// Pure logic of work-lens: no `$`, so the tests call it directly.

import type { Kind, Step, StepTool } from '../types'

/** A row as `$.session.messages({ last | after })` returns it (the fields this mod reads). */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  uuid?: string
  toolUses: ReadonlyArray<{ tool_use_id: string; tool: string; input: Record<string, unknown>; isError?: true }>
  toolResults?: ReadonlyArray<{ tool_use_id: string; isError: boolean }>
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
export function split(rows: readonly Row[], cont?: Continuation): Step[] {
  const steps: Step[] = []
  // A read that starts inside a long step's later part continues it under the same id.
  let open: Step | null = cont ? { ...newStep(`${cont.base}#${cont.part}`), part: cont.part, parentId: cont.base } : null
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
    open = { ...newStep(`${base}#${prev.part + 1}`), part: prev.part + 1, parentId: base }
  }
  for (const row of rows) {
    const uuid = row.uuid ?? ''
    const hasText = row.text.trim() !== ''
    if (row.role === 'user') {
      const results = row.toolResults ?? []
      if (results.length === 0) {
        if (hasText) close()
        continue
      }
      if (open === null) continue
      roll()
      const cur: Step = open as Step
      for (const r of results) {
        if (!r.isError) continue
        const tool = cur.tools.find(t => t.id === r.tool_use_id)
        if (tool) {
          tool.isError = true
          continue
        }
        // The call sits in an earlier part (this read or a closed one): mark it there when this read holds it,
        // and carry the failure in the part where it surfaced, so the next step still sees it as evidence.
        const earlier = steps.flatMap(s => s.tools).find(t => t.id === r.tool_use_id)
        if (earlier) earlier.isError = true
        cur.tools.push({ id: r.tool_use_id, brief: earlier ? `${earlier.brief} (result)` : '(result of an earlier call)', isError: true })
      }
      cur.rows.push(uuid)
      continue
    }
    if (hasText || open === null) {
      close()
      open = newStep(uuid)
      open.textRow = hasText ? uuid : undefined
    } else {
      roll()
    }
    const cur: Step = open as Step
    cur.rows.push(uuid)
    if (hasText) cur.text = cur.text ? `${cur.text}\n${row.text}` : row.text
    for (const use of row.toolUses) {
      cur.toolIds.push(use.tool_use_id)
      const tool: StepTool = { id: use.tool_use_id, brief: brief(use.tool, use.input) }
      if (use.isError) tool.isError = true
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

export type Verdict = { summary: string; category: string; kind: 'planned' | 'new' | 'fix'; relates: string | null }

export function buildPrompt(step: Step, categories: readonly string[], plan: string, errorBefore: boolean) {
  const system =
    'You label one step of an AI coding session for a work log. Reply with JSON only: ' +
    '{"summary": string (at most 90 characters, plain words, what was done or found), ' +
    `"category": one of ${JSON.stringify(categories)}, ` +
    '"kind": "planned" | "new" | "fix", "relates": string or null}. ' +
    'kind: "fix" when the step repairs something that failed earlier in this session (a failed tool call is given ' +
    'as evidence) or its own text says it corrects an earlier mistake; "planned" when it carries out an item of ' +
    'the project plan below or a plan the step itself states; otherwise "new". relates: the plan item id or short ' +
    'title the step serves, copied exactly from the plan text, or null.'
  const toolLines = step.tools.map(t => `- ${t.brief}${t.isError ? ' (FAILED)' : ''}`).join('\n')
  const prompt =
    `Project plan excerpts:\n${plan || '(none)'}\n\n` +
    `A tool call failed in the step before this one: ${errorBefore ? 'yes' : 'no'}\n\n` +
    `Step text:\n${redact(step.text).slice(0, 4000) || '(no text: tool calls only)'}\n\n` +
    `Tool calls:\n${toolLines || '(none)'}`

  return { system, prompt }
}

/** Reads the model's JSON reply; null when it is not the shape asked for. */
export function parse(text: string, categories: readonly string[]): Verdict | null {
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

  return { summary, category: categories[at]!, kind, relates }
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
export function labelParts(step: Step): { mark: string; rest: string } {
  if (step.status === 'queued' || step.status === 'running') return { mark: '…', rest: 'summarizing' }
  if (step.status === 'skipped') return { mark: '·', rest: `skipped${step.note ? ` (${step.note})` : ''}` }
  if (step.status === 'unavailable' || !step.summary) return { mark: '·', rest: 'summary unavailable' }
  const rel = step.relates ? ` · ${step.isRelatesVerified ? '' : '~'}${step.relates}` : ''

  return { mark: step.kind ? MARK[step.kind] : '·', rest: `${step.category}${rel} · ${step.summary}` }
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

/** Whether a step passes the filter: 'all', a category, a kind, or a valence. */
export function isShown(step: Step, filter: string, neutral: readonly string[] = ['notes']) {
  // A step without a verdict (summarizing, skipped, unavailable) has no category to filter on: always shown.
  if (filter === 'all' || step.status !== 'done') return true
  if (filter === 'planned') return step.kind === 'planned' || step.kind === 'unconfirmed'
  if (filter === 'new' || filter === 'fix') return step.kind === filter
  if ((VALENCES as readonly string[]).includes(filter)) return valence(step, neutral) === filter

  return step.category === filter
}
