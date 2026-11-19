// Pure logic of work-lens: no `$`, so the tests call it directly.

import type { Deviation, Kind, Step, StepTool } from '../types'
import { isCarrier, isQuotedFrom, outwardOf, targetOf } from './marks'

/** A row as `$.session.messages({ last | after })` returns it (the fields this mod reads). */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  uuid?: string
  toolUses: ReadonlyArray<{ tool_use_id: string; tool: string; input: Record<string, unknown>; isError?: true; text?: string }>
  toolResults?: ReadonlyArray<{ tool_use_id: string; isError: boolean; text?: string }>
}

/** What `split` needs beyond the rows: the extra ⇪ patterns, and the person's latest message before the rows. */
export type SplitOpts = { outward?: readonly RegExp[]; latest?: string }

export const LATEST_MAX = 300
export const ERROR_MAX = 300

/** A user row the person typed: text that is not a tool result, a tagged notice, or a slash command. */
const isTyped = (row: Row) => {
  const text = row.text.trim()

  return (row.toolResults ?? []).length === 0 && text !== '' && !text.startsWith('<') && !/^\/[A-Za-z]/.test(text)
}

export const PART_ROWS = 300
export const PAGE_ROWS = 4096

const SECRET = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}/g,
  /\b[0-9a-f]{40,}\b/gi,
]

/** Replaces text shaped like a key, token or password with [redacted]. */
export const redact = (text: string) => SECRET.reduce((t, re) => t.replace(re, '[redacted]'), text)

/** A tool call reduced to its name plus a file path or the command's start; no other input is ever sent. */
export const brief = (tool: string, input: Record<string, unknown>) => {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const what = pick('file_path') ?? pick('notebook_path') ?? pick('path') ?? pick('command') ?? ''

  return redact(`${tool}${what ? ` ${what.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`)
}

const newStep = (id: string): Step => ({
  id,
  part: 1,
  rows: [],
  toolIds: [],
  text: '',
  tools: [],
  status: 'open',
})

/**
 * Splits rows (oldest first, all after the anchor) into steps. An assistant row with text opens a step; an
 * assistant row with only tool calls joins the open step or opens a tools-first one; user rows carry tool
 * results (errors) into the open step. A user row with neither text nor results is skipped; a user prompt
 * (text, no results) ends the open step. A step that reaches PART_ROWS rows is cut into parts.
 */
export function split(rows: readonly Row[], cont?: Continuation, opts: SplitOpts = {}): Step[] {
  const steps: Step[] = []
  let latest = opts.latest
  const fresh = (id: string): Step => (latest === undefined ? newStep(id) : { ...newStep(id), latest })
  // A read that starts inside a long step's later part continues it under the same id.
  let open: Step | null = cont ? { ...fresh(`${cont.base}#${cont.part}`), part: cont.part, parentId: cont.base } : null
  const close = () => {
    if (open !== null) steps.push(open)
    open = null
  }
  /** A full step continues as its next part, so no part ever holds more than PART_ROWS rows. */
  const roll = () => {
    if (open === null || open.rows.length < PART_ROWS) return
    const prev: Step = open
    const base = prev.parentId ?? prev.id
    close()
    open = { ...fresh(`${base}#${prev.part + 1}`), part: prev.part + 1, parentId: base }
  }
  const errorOf = (text: string | undefined) => (text === undefined || text.trim() === '' ? undefined : redact(text.slice(0, ERROR_MAX)))
  const orphans: NonNullable<Row['toolResults']>[number][] = []
  /** Tool results into the step they surface in. */
  const absorb = (cur: Step, results: NonNullable<Row['toolResults']>) => {
    for (const r of results) {
      const tool = cur.tools.find(t => t.id === r.tool_use_id) ?? steps.flatMap(s => s.tools).find(t => t.id === r.tool_use_id)
      // A stored result with its text is the proof the call ran: what ⇪ and a retry that worked need. One whose
      // call closed in an earlier read is noted, and the listed call is marked when the step is listed.
      if (!r.isError) {
        if (r.text === undefined) continue
        if (tool) tool.seen = true
        else (cur.seenEarlier ??= []).push(r.tool_use_id)
        continue
      }
      const error = errorOf(r.text)
      if (tool && cur.tools.includes(tool)) {
        tool.isError = true
        if (error !== undefined) tool.error = error
        continue
      }
      // The call sits in an earlier part (this read or a closed one): mark it there when this read holds it,
      // and carry the failure in the part where it surfaced, so the next step still sees it as evidence.
      if (tool) tool.isError = true
      const carrier: StepTool = { id: r.tool_use_id, brief: tool ? `${tool.brief} (result)` : '(result of an earlier call)', isError: true }
      if (error !== undefined) carrier.error = error
      if (tool?.target !== undefined) carrier.target = tool.target
      cur.tools.push(carrier)
    }
  }
  for (const row of rows) {
    const uuid = row.uuid ?? ''
    const hasText = row.text.trim() !== ''
    if (row.role === 'user') {
      const results = row.toolResults ?? []
      if (results.length === 0) {
        if (isTyped(row)) latest = row.text.trim().slice(0, LATEST_MAX)
        if (hasText) close()
        continue
      }
      // Results read before any step of this read (their calls closed in an earlier one) go with the next step.
      if (open === null) {
        orphans.push(...results)
        continue
      }
      roll()
      const cur: Step = open as Step
      absorb(cur, results)
      cur.rows.push(uuid)
      continue
    }
    if (hasText || open === null) {
      close()
      open = fresh(uuid)
      open.textRow = hasText ? uuid : undefined
    } else {
      roll()
    }
    const cur: Step = open as Step
    if (orphans.length > 0) {
      absorb(cur, orphans)
      orphans.length = 0
    }
    cur.rows.push(uuid)
    if (hasText) cur.text = cur.text ? `${cur.text}\n${row.text}` : row.text
    for (const use of row.toolUses) {
      cur.toolIds.push(use.tool_use_id)
      const tool: StepTool = { id: use.tool_use_id, brief: brief(use.tool, use.input), target: targetOf(use.tool, use.input) }
      const out = outwardOf(use.tool, use.input, opts.outward)
      if (out !== undefined) tool.out = out
      if (use.isError) {
        tool.isError = true
        const error = errorOf(use.text)
        if (error !== undefined) tool.error = error
      } else if (use.text !== undefined) {
        tool.seen = true
      }
      cur.tools.push(tool)
    }
  }
  close()

  return steps.filter(s => s.rows.length > 0)
}

/** Where the next read resumes when the step left open is a later part of a long step. */
export type Continuation = { base: string; part: number }

/** The continuation for the step left open after a read, if it is part 2 or later. */
export const continuation = (open: Step | undefined): Continuation | undefined =>
  open !== undefined && open.part > 1 ? { base: open.parentId ?? open.id, part: open.part } : undefined

/** A copy of the step with a new status and note (no note clears it). */
export const mark = (s: Step, status: Step['status'], note?: string): Step => ({ ...s, status, note })

/** The site a step's header is drawn on: its text row, else its first tool call. */
export const headerSite = (step: Step) => step.textRow ?? step.toolIds[0] ?? step.id

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

/**
 * Whether a rendered text block is the opening block of its step's row: a row drawn as several blocks shares
 * one id, and only the first carries the header. Compared on the block's first 60 characters.
 */
export const isOpeningBlock = (step: Step, blockText: string) => {
  const head = squash(blockText).slice(0, 60)

  return head !== '' && squash(step.text).startsWith(head)
}

export type Verdict = {
  summary: string
  category: string
  kind: 'planned' | 'new' | 'fix'
  relates: string | null
  /** Asked of a turn's last step only: whether it asks the person for input before work goes on. */
  asksNow: boolean
  /** Ids of open failures (sent with the step) the step repairs; only when some were sent. */
  fixes?: string[]
  /** Ids of the step's own failures that were intended or harmless; only when it has some. */
  expected?: string[]
  /** A material, grounded break of a quoted rule; only when the rule excerpt was sent. */
  deviation?: Deviation
  assumption?: string
}

/** A failure as the prompt lists it. */
export type FailLine = { id: string; brief: string; error?: string }

/**
 * What the summary is judged against beyond the step: the open failures before it and its own, and (with
 * `judgeRules` on) the rule excerpt and the person's latest message. `rules` undefined: no ⚑/◇ fields are asked.
 */
export type JudgeCtx = { open: readonly FailLine[]; own: readonly FailLine[]; rules?: string; latest?: string }

const failLine = (f: FailLine) => `- ${f.id}: ${f.brief}${f.error !== undefined ? ` — error: ${f.error.replace(/\s+/g, ' ')}` : ''}`

/** The step's own calls (carriers of an earlier call's result left out), numbered c1, c2, … in the prompt. */
export const ownCalls = (step: Step) => step.tools.filter(t => !isCarrier(t))

/**
 * A question card or a plan approval among the step's own calls, from the tool name alone (no model call). The
 * carrier of a failed result of an earlier call does not count: the call it belongs to was in an earlier step.
 */
export function askOf(tools: readonly StepTool[]): 'card' | 'plan' | undefined {
  const names = tools.filter(t => !t.brief.startsWith('(') && !t.brief.endsWith(' (result)')).map(t => t.brief.split(' ')[0])
  if (names.includes('ExitPlanMode')) return 'plan'
  if (names.includes('AskUserQuestion')) return 'card'

  return undefined
}

export function buildPrompt(step: Step, categories: readonly string[], plan: string, errorBefore: boolean, ctx?: JudgeCtx) {
  const isTurnEnd = step.isTurnEnd === true
  const hasOpen = (ctx?.open.length ?? 0) > 0
  const hasOwn = (ctx?.own.length ?? 0) > 0
  const isJudged = ctx?.rules !== undefined
  const fields =
    (isTurnEnd ? ', "asks_now": boolean' : '') +
    (hasOpen ? ', "fixes": [failure ids]' : '') +
    (hasOwn ? ', "expected": [failure ids]' : '') +
    (isJudged ? ', "deviation": null or {"rule": string, "how": string, "action": {"call": "cN"} or {"quote": string}}, "assumption": string or null' : '')
  const system =
    'You label one step of an AI coding session for a work log. Reply with JSON only: ' +
    '{"summary": string (at most 90 characters, plain words, what was done or found), ' +
    `"category": one of ${JSON.stringify(categories)}, ` +
    `"kind": "planned" | "new" | "fix", "relates": string or null${fields}}. ` +
    'kind: "fix" when the step repairs something that failed earlier in this session (a failed tool call is given ' +
    'as evidence) or its own text says it corrects an earlier mistake; "planned" when it carries out an item of ' +
    'the project plan below or a plan the step itself states; otherwise "new". relates: the plan item id or short ' +
    'title the step serves, copied exactly from the plan text, or null.' +
    (isTurnEnd
      ? ' This step is the last thing the assistant said before it stopped and handed back to the user. ' +
        'asks_now: true only when it asks the user to answer, decide, approve, confirm or supply something before ' +
        'the work can go on. false when it only reports, notes an item for a backlog or for later, defers a ' +
        'decision, or ends with an optional offer the user need not answer.'
      : '') +
    (hasOpen
      ? ' fixes: the ids, from "Open failures", of failures this step clearly repairs (a retry, a fix of their ' +
        'cause); [] when it repairs none of them or you are unsure.'
      : '') +
    (hasOwn
      ? ' expected: the ids of this step\'s own failures that were intended or harmless (a search that found ' +
        'nothing, a test written to fail first, a probe expected to fail); [] when a failure matters or you are unsure.'
      : '') +
    (isJudged
      ? ' deviation: only a MATERIAL break of a rule in the excerpt above: the step took an action that goes ' +
        'against it (changing a plan, code, config or data; pushing, publishing, deploying or sending; deciding ' +
        'for the person something the rules reserve for them), or skipped a required part of an action it did take ' +
        '(a push without the approval a rule requires, a release without its gate, an edit by a forbidden method). ' +
        'NOT a deviation: a procedure whose trigger did not occur in this step (e.g. "update the notes after a ' +
        'release" when nothing was released), skipping work that would have had no effect, or a procedure that ' +
        'plainly does not apply here. rule: copied word for word from the excerpt. how: what the step did, at most ' +
        '120 characters. action: {"call": "cN"} naming the tool call below that did it, or, when the step broke the ' +
        'rule only by what it said, {"quote": words copied from the step text}. null when nothing material broke a ' +
        'rule. Judge approvals against the person\'s latest message. assumption: a choice the person did not ask ' +
        'for or decide that they may want to review (a picked default, an inferred intent, a widened scope), at ' +
        'most 120 characters; null when none.'
      : '')
  const calls = ownCalls(step)
  const toolLines = step.tools
    .map(t => {
      const at = calls.indexOf(t)

      return `- ${at >= 0 ? `c${at + 1} ` : ''}${t.brief}${t.isError ? ` (FAILED${t.fail !== undefined ? ` ${t.fail}` : ''})` : ''}`
    })
    .join('\n')
  const prompt =
    `Project plan excerpts:\n${plan || '(none)'}\n\n` +
    (isJudged ? `The person's latest message: ${ctx?.latest !== undefined ? JSON.stringify(redact(ctx.latest)) : '(none seen)'}\n\n` : '') +
    `A tool call failed in the step before this one: ${errorBefore ? 'yes' : 'no'}\n\n` +
    (hasOpen ? `Open failures before this step:\n${ctx!.open.map(failLine).join('\n')}\n\n` : '') +
    (hasOwn ? `This step's own failures:\n${ctx!.own.map(failLine).join('\n')}\n\n` : '') +
    `Step text:\n${redact(step.text).slice(0, 4000) || '(no text: tool calls only)'}\n\n` +
    `Tool calls:\n${toolLines || '(none)'}`

  return { system, prompt, rules: isJudged && ctx?.rules ? ctx.rules : undefined }
}

/** What `parse` checks the judgments against: the ids that were sent, the step's calls and text, the excerpt. */
export type ParseCtx = { openIds: readonly string[]; ownIds: readonly string[]; calls: readonly StepTool[]; text: string; rules?: string }

const ids = (value: unknown, allowed: readonly string[]) =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && allowed.includes(v)))] : []

const short = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * A deviation is kept only when grounded: its rule quoted from the excerpt, a `how`, and an action that is one of
 * the step's own calls (`c1`…) or words found in the step's text (at least 12 characters).
 */
export function groundDeviation(value: unknown, ctx: ParseCtx): Deviation | undefined {
  if (ctx.rules === undefined || value === null || typeof value !== 'object') return undefined
  const d = value as { rule?: unknown; how?: unknown; action?: unknown }
  const rule = short(d.rule, 400)
  const how = short(d.how, 140)
  if (how === '' || !isQuotedFrom(rule, ctx.rules)) return undefined
  const action = d.action !== null && typeof d.action === 'object' ? (d.action as { call?: unknown; quote?: unknown }) : {}
  const at = typeof action.call === 'string' ? /^c(\d+)$/i.exec(action.call.trim()) : null
  const call = at !== null ? ctx.calls[Number(at[1]) - 1] : undefined
  if (call !== undefined) return { rule: rule.slice(0, 200), how, toolId: call.id }
  const quote = short(action.quote, 400)
  if (quote !== '' && isQuotedFrom(quote, ctx.text)) return { rule: rule.slice(0, 200), how, quote: quote.slice(0, 140) }

  return undefined
}

/** Reads the model's JSON reply; null when it is not the shape asked for. */
export function parse(text: string, categories: readonly string[], ctx?: ParseCtx): Verdict | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: Record<string, unknown>
  try {
    value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const summary = typeof value.summary === 'string' ? value.summary.replace(/\s+/g, ' ').trim().slice(0, 90) : ''
  const lower = categories.map(c => c.toLowerCase())
  const at = typeof value.category === 'string' ? lower.indexOf(value.category.toLowerCase().trim()) : -1
  const kind = value.kind
  if (!summary || at < 0 || (kind !== 'planned' && kind !== 'new' && kind !== 'fix')) return null
  const relates = typeof value.relates === 'string' && value.relates.trim() ? value.relates.trim().slice(0, 60) : null

  const v: Verdict = { summary, category: categories[at]!, kind, relates, asksNow: value.asks_now === true }
  if (ctx === undefined) return v
  // Each judgment only when its question was asked, and only ids that were sent.
  if (ctx.openIds.length > 0) v.fixes = ids(value.fixes, ctx.openIds)
  if (ctx.ownIds.length > 0) v.expected = ids(value.expected, ctx.ownIds)
  if (ctx.rules !== undefined) {
    const deviation = groundDeviation(value.deviation, ctx)
    if (deviation !== undefined) v.deviation = deviation
    const assumption = short(value.assumption, 140)
    if (assumption !== '') v.assumption = assumption
  }

  return v
}

/** True when the plan text holds the relation the model named (case-insensitive). */
export const isInPlan = (relates: string | null, plan: string) =>
  relates !== null && relates.length >= 2 && plan.toLowerCase().includes(relates.toLowerCase())

/** The marker shown: ● planned needs the relation found in the plan, or the step's own text naming it. */
export function kindOf(v: Verdict, plan: string, stepText: string): { kind: Kind; isRelatesVerified: boolean } {
  const isRelatesVerified = isInPlan(v.relates, plan)
  if (v.kind !== 'planned') return { kind: v.kind, isRelatesVerified }
  const isNamedInStep = v.relates !== null && stepText.toLowerCase().includes(v.relates.toLowerCase())

  return { kind: isRelatesVerified || isNamedInStep ? 'planned' : 'unconfirmed', isRelatesVerified }
}

export const MARK: Record<Kind, string> = { planned: '●', unconfirmed: '○', new: '◆', fix: '✚' }

/** The marker of a step and the rest of its one-line label, apart so the marker can be colored. */
/** A step's marker and the rest of its line; `hideCategory` leaves the category out (the Work group not shown). */
export function labelParts(step: Step, hideCategory = false): { mark: string; rest: string } {
  if (step.status === 'queued' || step.status === 'running') return { mark: '…', rest: 'summarizing' }
  if (step.status === 'skipped') return { mark: '·', rest: `skipped${step.note ? ` (${step.note})` : ''}` }
  if (step.status === 'unavailable' || !step.summary) return { mark: '·', rest: 'summary unavailable' }
  const rel = step.relates ? `${step.isRelatesVerified ? '' : '~'}${step.relates}` : ''
  const head = [hideCategory ? '' : (step.category ?? ''), rel].filter(p => p !== '')

  return { mark: step.kind ? MARK[step.kind] : '·', rest: [...head, step.summary].join(' · ') }
}

/** The one-line label of a step: marker, category, relation, summary. */
export function label(step: Step) {
  const { mark, rest } = labelParts(step)

  return `${mark} ${rest}`
}

/**
 * What kind of effort a step was: positive (moves the build forward), neutral (notes and upkeep that add no
 * direct value: the categories listed as neutral), negative (fixing an error). None until it has a verdict.
 */
export type Valence = 'positive' | 'neutral' | 'negative'

export const VALENCES: readonly Valence[] = ['positive', 'neutral', 'negative']

export function valence(step: Step, neutral: readonly string[]): Valence | undefined {
  if (step.status !== 'done') return undefined
  if (step.kind === 'fix') return 'negative'
  if (step.category !== undefined && neutral.includes(step.category)) return 'neutral'

  return 'positive'
}

/** Theme colors for each valence: green, gray, red in the default themes. */
export const VALENCE_COLOR: Record<Valence, 'success' | 'inactive' | 'error'> = {
  positive: 'success',
  neutral: 'inactive',
  negative: 'error',
}

/** A step asking the person for input that has not been replied to. */
export const isWaiting = (step: Step) => step.asks !== undefined && step.isReplied !== true

/** The id of the newest turn's report, the last `isTurnEnd` step. */
export function newestTurnEnd(list: readonly Step[]) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.isTurnEnd === true) return list[i]!.id

  return undefined
}

/**
 * Whether a step stays open whatever the collapse setting, until the person replies: a question (❗), the
 * newest turn's report (★), or an older turn end with no verdict, which may be asking (plan items 49-50).
 */
export function isKeptOpen(step: Step, newest: string | undefined) {
  if (step.isReplied === true) return false
  if (step.asks !== undefined) return true
  if (step.isTurnEnd !== true) return false

  return step.id === newest || step.status !== 'done'
}

export type Badge = 'input' | 'decided' | 'report' | 'unread'

/** The badge drawn before a step's marker, if any. */
export function badgeOf(step: Step, newest: string | undefined): Badge | undefined {
  if (step.asks !== undefined) return step.isReplied === true ? 'decided' : 'input'
  if (step.isTurnEnd !== true || step.isReplied === true) return undefined
  if (step.id === newest) return 'report'

  return step.status !== 'done' ? 'unread' : undefined
}

/** Whether a step passes the filter: 'all', input, report, a category, a kind, or a valence. */
export function isShown(step: Step, filter: string, neutral: readonly string[] = ['notes']) {
  // A question not yet replied to passes every filter, so a filter never hides it.
  if (filter === 'all' || isWaiting(step)) return true
  // input and report are known without a verdict: an unlabeled turn end may be asking, so input keeps it.
  if (filter === 'input') return step.asks !== undefined || (step.isTurnEnd === true && step.status !== 'done')
  if (filter === 'report') return step.isTurnEnd === true
  // A step without a verdict (summarizing, skipped, unavailable) has no category to filter on: always shown.
  if (step.status !== 'done') return true
  if (filter === 'planned') return step.kind === 'planned' || step.kind === 'unconfirmed'
  if (filter === 'new' || filter === 'fix') return step.kind === filter
  if ((VALENCES as readonly string[]).includes(filter)) return valence(step, neutral) === filter

  return step.category === filter
}
