import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Step } from '../types'
import {
  askOf,
  badgeOf,
  buildPrompt,
  isKeptOpen,
  isWaiting,
  newestTurnEnd,
  continuation,
  headerSite,
  isOpeningBlock,
  isShown,
  kindOf,
  label,
  labelParts,
  mark,
  ownCalls,
  PAGE_ROWS,
  parse,
  redact,
  split,
  valence,
  VALENCE_COLOR,
  VALENCES,
} from './steps'
import type { Continuation, FailLine, JudgeCtx, ParseCtx, Row, SplitOpts, Verdict } from './steps'
import { compilePatterns, extractRules, failures, hookLines, isCarrier, outwardOfStep } from './marks'
import type { Failure, RuleSource } from './marks'

const PANE = 'work-log'
const QUEUE_MAX = 20
const DEBOUNCE_MS = 10_000
const PLAN_TTL_MS = 60_000
const PLAN_MAX = 8000
const PLAN_FILES = ['BACKLOG.md', 'docs/dod/README.md', '.orchestration/handoff.md', 'PLAN.md', 'TODO.md']
const KINDS = ['planned', 'new', 'fix'] as const

/** Every filter in the order the band and pane offer them: all, valences, kinds, then the categories. */
/** input (questions to the person) and report (each turn's last word) are known without a verdict. */
const MARKS = ['input', 'report'] as const
/** ⚠ unresolved, ⇪ outward (from the tool calls), ⚑ deviation and ◇ assumption (from the summary). */
const FLAGS = ['unresolved', 'outward', 'deviation', 'assumption'] as const

/**
 * The four parent groups of the labels (owner's choice, 2026-11-19). Value (▲■▼) is worked out from kind and category, so it
 * is no group: it stays the row's color, and its filters are accepted when typed but not offered.
 */
const GROUP_IDS = ['needs', 'review', 'purpose', 'work'] as const
type GroupId = (typeof GROUP_IDS)[number]
const GROUP_TITLE: Record<GroupId, string> = { needs: 'Needs you', review: 'Review', purpose: 'Purpose', work: 'Work' }
const GROUP_ALIASES: Record<string, GroupId> = { 'needs-you': 'needs', 'needs you': 'needs' }
const isGroup = (c: string): c is GroupId => (GROUP_IDS as readonly string[]).includes(c)

function membersOf(g: GroupId): readonly string[] {
  if (g === 'needs') return ['input', 'report', 'unresolved', 'deviation']
  if (g === 'review') return ['outward', 'assumption']
  if (g === 'purpose') return KINDS

  return S.categories
}

/** The group a label belongs to; none for the value words. */
const groupOf = (c: string) => GROUP_IDS.find(g => membersOf(g).includes(c))
/** Whether a label (or a group) is drawn: its group is among the groups shown (`labelGroups`). */
const isLabelShown = (c: string) => {
  const g = isGroup(c) ? c : groupOf(c)

  return g !== undefined && S.groups.includes(g)
}

/** Every label filter offered, in order: all, the marks and flags, the kinds, then the categories (and value, in `all`). */
const filterChoices = () => ['all', ...MARKS, ...FLAGS, ...(S.isGrouped ? [] : VALENCES), ...KINDS, ...S.categories]
/** What `/worklog <filter>` accepts: the offered labels, the groups, and the value words (still accepted). */
const typedChoices = () => [...filterChoices(), ...GROUP_IDS, ...VALENCES]
const RULES_TTL_MS = 300_000
const MEMORY_FILES_MAX = 120
const OPEN_SENT_MAX = 5

/** Every failure of the list and whether it is open, worked out once per list. */
function failuresOf(list: readonly Step[]) {
  let fails = S.fails.get(list)
  if (fails === undefined) {
    fails = failures(list)
    S.fails.set(list, fails)
  }

  return fails
}

/** The ids of the steps holding a failure still open. */
const openOf = (list: readonly Step[]) => new Set(failuresOf(list).filter(f => f.isOpen).map(f => f.stepId))

function hasFlag(s: Step, flag: string, open: ReadonlySet<string>) {
  if (flag === 'unresolved') return open.has(s.id)
  if (flag === 'outward') {
    const o = outwardOfStep(s)

    return o.sent.length + o.unseen.length > 0
  }
  if (flag === 'deviation') return s.deviation !== undefined

  return s.assumption !== undefined
}

/**
 * isShown, plus the four flags: a waiting question passes, and ⚑/◇ keep a step that has no verdict yet. A group
 * passes a step that one of its labels passes.
 */
function passes(s: Step, f: string, open: ReadonlySet<string>): boolean {
  if (isGroup(f)) return membersOf(f).some(m => passes(s, m, open))
  if ((FLAGS as readonly string[]).includes(f)) {
    if (isWaiting(s) || hasFlag(s, f, open)) return true

    return (f === 'deviation' || f === 'assumption') && s.status !== 'done'
  }

  return isShown(s, f, S.neutral)
}

/** The flags drawn after the badge: ⚠ red, ⇪ amber (⇪? dim while no result is seen), ⚑ red, ◇ dim. */
function flags(step: Step, open: ReadonlySet<string>, Text: any) {
  const o = outwardOfStep(step)
  const out = []
  if (isLabelShown('unresolved') && open.has(step.id)) out.push(<Text key="u" color="error">{'⚠ '}</Text>)
  if (isLabelShown('outward')) {
    if (o.sent.length > 0) out.push(<Text key="o" color="warning">{'⇪ '}</Text>)
    else if (o.unseen.length > 0) out.push(<Text key="o" dimColor>{'⇪? '}</Text>)
  }
  if (isLabelShown('deviation') && step.deviation !== undefined) out.push(<Text key="d" color="error">{'⚑ '}</Text>)
  if (isLabelShown('assumption') && step.assumption !== undefined) out.push(<Text key="a" dimColor>{'◇ '}</Text>)

  return out
}

/** The flags in words, for the pane, the log line and /worklog: what failed, went out, broke a rule, was assumed. */
function flagText(step: Step, fails: readonly Failure[]) {
  const out: string[] = []
  const mine = fails.filter(f => f.isOpen && f.stepId === step.id)
  if (isLabelShown('unresolved') && mine.length > 0) out.push(`⚠ unresolved: ${mine.map(f => `${f.id} ${f.brief}`).join('; ')}`)
  const o = outwardOfStep(step)
  if (isLabelShown('outward')) {
    if (o.sent.length > 0) out.push(`⇪ ${o.sent.join(', ')}`)
    if (o.unseen.length > 0) out.push(`⇪? ${o.unseen.join(', ')} (result not seen)`)
  }
  if (isLabelShown('deviation') && step.deviation !== undefined) out.push(`⚑ "${step.deviation.rule}": ${step.deviation.how}`)
  if (isLabelShown('assumption') && step.assumption !== undefined) out.push(`◇ ${step.assumption}`)

  return out.join(' · ')
}

/** A step's line after its marker, without the category when Work is not shown. */
const restOf = (step: Step) => labelParts(step, !isLabelShown('work')).rest
/** The marker glyph: the kind's, or a plain dot when Purpose is not shown (a summarized step only). */
const markOf = (step: Step) => (isLabelShown('purpose') || step.status !== 'done' ? labelParts(step).mark : '•')
/** A step's whole line in words (the log, /worklog): marker and rest, as the groups shown allow. */
const lineOf = (step: Step) => `${markOf(step)} ${restOf(step)}`

/**
 * The marker drawn in its valence's color (plain when the step has no verdict yet). With Purpose not shown the kind
 * glyph gives way to a plain dot, still in the valence's color.
 */
function Mark({ step, Text }: { step: Step; Text: any }) {
  const v = valence(step, S.neutral)
  const glyph = markOf(step)

  return v ? <Text color={VALENCE_COLOR[v]}>{glyph}</Text> : <Text>{glyph}</Text>
}

/** The badge before a step's marker: ❗ input (bold amber), ✔ decided, ★ report, ? unread; or nothing. */
function badge(step: Step, newest: string | undefined, Text: any) {
  if (!isLabelShown('input')) return undefined
  const b = badgeOf(step, newest)
  if (b === 'input') return <Text bold color="warning">{'❗ input '}</Text>
  if (b === 'decided') return <Text dimColor>{'✔ decided '}</Text>
  if (b === 'report') return <Text color="suggestion">{'★ report '}</Text>
  if (b === 'unread') return <Text dimColor>{'? unread '}</Text>

  return undefined
}

const steps = atom({ plugin: 'work-lens', key: 'steps' } as const, [])
const filter = atom({ plugin: 'work-lens', key: 'filter' } as const, 'all')
const toggled = atom({ plugin: 'work-lens', key: 'toggled' } as const, {})
const calls = atom({ plugin: 'work-lens', key: 'calls' } as const, { tried: 0, answered: 0 })
const anchor = atom({ plugin: 'work-lens', key: 'anchor' } as const, null)
const backfilled = atom({ plugin: 'work-lens', key: 'backfilled' } as const, false)
const failSeq = atom({ plugin: 'work-lens', key: 'failSeq' } as const, 0)
const openGroup = atom({ plugin: 'work-lens', key: 'openGroup' } as const, null)

type Engine = EngineInterface

/** Module working state; what must outlive a reload lives in $.state above. */
const S = {
  categories: ['notes', 'backlog & artifacts', 'code', 'auditing', 'evaluating'] as string[],
  neutral: ['notes'] as string[],
  model: 'haiku',
  isAuto: true,
  isCollapsedByDefault: true,
  maxCalls: 200,
  isEnded: false,
  scanning: null as Promise<void> | null,
  cont: undefined as Continuation | undefined,
  rescan: null as null | { isClosing: boolean },
  timer: null as null | { cancel: () => void },
  isWorking: false,
  stop: null as AbortController | null,
  isFullscreen: undefined as boolean | undefined,
  /** The anchor the compaction hook's scan reached, set only when that scan succeeded. */
  compactionAnchor: null as string | null,
  /**
   * The newest row at each turn.complete, until a scan closes the step holding it: the last step with text at or
   * before it is that turn's end. Per turn, so a failed scan or a compaction's scan never moves a boundary.
   */
  turnEnds: [] as string[],
  /** The anchor a compaction removed, so its notice is logged once. */
  lostAnchor: null as string | null,
  plan: { text: '', at: 0 },
  index: new WeakMap<readonly Step[], Map<string, Step>>(),
  fails: new WeakMap<readonly Step[], Failure[]>(),
  /** The `outwardPatterns` setting, compiled; the ones that did not compile, logged once at start. */
  outward: [] as RegExp[],
  badPatterns: [] as string[],
  /** `judgeRules`: send the rule excerpt and the latest message, and ask for ⚑ and ◇. */
  isJudged: true,
  /** `sendFailureText`: send each failure's error excerpt, not only its call. */
  isFailureTextSent: true,
  /** The person's latest typed message at the anchor (scan order), carried into the next read. */
  latest: undefined as string | undefined,
  /** The instruction files the session sends, as the last `prompt.context` named them. */
  instr: undefined as readonly { path: string; kind: string; content: string }[] | undefined,
  rules: null as null | { text: string; at: number },
  /** `labelGroups`: the groups drawn; `labelDetail`: grouped chips (one per group) or every label. */
  groups: [...GROUP_IDS] as GroupId[],
  isGrouped: true,
  /** Names left out at start (an unknown group, a category named like a filter), logged once. */
  badGroups: [] as string[],
  badCategories: [] as string[],
}

/** What `split` is told: the extra ⇪ patterns, and the latest message when the rules are judged. */
const splitOpts = (): SplitOpts => (S.isJudged && S.latest !== undefined ? { outward: S.outward, latest: S.latest } : { outward: S.outward })

// ---- the rule excerpt for ⚑ -----------------------------------------------------------------------------------

/**
 * The person's standing rules: the instruction files the session sends (CLAUDE.md files, the memory index), the
 * feedback memories beside that index, and the stored hooks (event, matcher, script name only). Redacted, cached.
 */
async function rulesText($: Engine) {
  const now = await $.clock.now()
  if (S.rules !== null && now - S.rules.at < RULES_TTL_MS) return S.rules.text
  const files = S.instr ?? []
  const sources: RuleSource[] = files.map(f => ({ text: f.content }))
  const index = files.find(f => f.kind === 'memory')
  if (index !== undefined) {
    const dir = index.path.replace(/[\\/][^\\/]*$/, '')
    const entries = await $.fs.list(dir).catch(() => [])
    const mds = entries.filter(e => e.kind === 'file' && /\.md$/i.test(e.name) && e.name !== 'MEMORY.md').slice(0, MEMORY_FILES_MAX)
    for (const e of mds) {
      const body = String(await $.fs.read(`${dir}/${e.name}`).catch(() => ''))
      if (/^feedback/i.test(e.name) || /^\s*type:\s*feedback\b/m.test(body)) sources.push({ text: body, isFeedback: true })
    }
  }
  const hooks: unknown = await $.settings.read({ key: 'hooks' }).catch(() => undefined)
  S.rules = { text: redact(extractRules(sources, hookLines(hooks))), at: now }

  return S.rules.text
}

// ---- reading the plan files -------------------------------------------------------------------------------

async function planText($: Engine) {
  const now = await $.clock.now()
  if (now - S.plan.at < PLAN_TTL_MS) return S.plan.text
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  let text = ''
  for (const name of PLAN_FILES) {
    if (text.length >= PLAN_MAX) break
    const path = `${root}/${name}`
    if (!(await $.fs.exists(path).catch(() => false))) continue
    const body = await $.fs.read(path).catch(() => '')
    text += `--- ${name} ---\n${String(body).slice(0, PLAN_MAX - text.length)}\n`
  }
  S.plan = { text: redact(text.slice(0, PLAN_MAX)), at: now }

  return S.plan.text
}

// ---- scanning rows into steps -----------------------------------------------------------------------------

async function setAnchorToNewest($: Engine) {
  const res = await $.session.messages({ last: 1 })
  const uuid = Array.isArray(res) ? (res[0]?.uuid ?? null) : null
  await update($, anchor, () => uuid)

  return uuid
}

/**
 * Single-flight: a scan asked for while one runs is folded into a rerun after it (closing if either asked to
 * close), and the caller waits for that run too, so `turn.complete` returns only once its closing scan is done.
 */
function scan($: Engine, isClosing: boolean): Promise<void> {
  if (S.scanning !== null) {
    S.rescan = { isClosing: isClosing || (S.rescan?.isClosing ?? false) }

    return S.scanning
  }
  S.scanning = scanRuns($, isClosing).finally(() => {
    S.scanning = null
  })

  return S.scanning
}

async function scanRuns($: Engine, isClosing: boolean) {
  let closing = isClosing
  for (;;) {
    await scanOnce($, closing)
    const again = S.rescan
    S.rescan = null
    if (again === null || S.isEnded) return
    closing = again.isClosing
  }
}

/** Reads every row after the anchor, page by page, closes the finished steps and queues them. */
/** The steps worth listing: text, tool calls, or a later part of a long step. */
const isWorthListing = (s: Step) => s.text.trim() !== '' || s.tools.length > 0 || s.part > 1

/**
 * Reads every row after the anchor, page by page until a page is short, closes the finished steps and queues
 * them. Rows of the step left open are read again next time; when that step is a later part of a long one,
 * `S.cont` carries its id so the reread continues it rather than starting a new step.
 */
async function scanOnce($: Engine, isClosing: boolean) {
  for (;;) {
    if (S.isEnded) return
    let from = await read($, anchor)
    if (from === null) from = await setAnchorToNewest($)
    if (from === null) return
    let res = await $.session.messages({ after: from })
    if (!Array.isArray(res)) {
      // The anchor fell to a compaction. The rows the conversation still holds (the newest 4,096) are read and
      // every one no step owns yet is split, so the rows written since the compaction are not skipped.
      S.cont = undefined
      const kept = await $.session.messages({ last: PAGE_ROWS })
      if (!Array.isArray(kept)) {
        await setAnchorToNewest($)

        return
      }
      const owned = new Set((await read($, steps)).flatMap(s => s.rows))
      res = (kept as unknown as Row[]).filter(r => r.uuid === undefined || !owned.has(r.uuid)) as unknown as typeof res
      // Said once per lost anchor, and not when the compaction hook's scan reached exactly this anchor.
      if (S.compactionAnchor !== from && S.lostAnchor !== from) {
        $.ui.log('work-lens: a compaction removed rows before they were read; those steps are not listed')
      }
      S.lostAnchor = from
      S.compactionAnchor = null
    }
    const rows = res as unknown as Row[]
    const isFull = rows.length >= PAGE_ROWS
    const found = split(rows, S.cont, splitOpts()).filter(isWorthListing)
    const closeCount = isClosing && !isFull ? found.length : found.length - 1
    const closed = found.slice(0, Math.max(0, closeCount))
    // Each turn boundary read in this batch, once every row up to it is closed: the last closed step with text
    // starting at or before it is the turn's report. By row position, so a boundary row no step holds (an empty
    // reply, a prompt) still counts.
    const pos = new Map(rows.map((r, i) => [r.uuid, i]))
    // A closing read that is not a full page has closed every row it read, rows of no step included.
    const lastRow = closed.at(-1)?.rows.at(-1)
    const limit = isClosing && !isFull ? rows.length - 1 : lastRow === undefined ? -1 : (pos.get(lastRow) ?? -1)
    // A boundary this read does not settle is looked up among the steps already listed: its row closed in an
    // earlier read (a compaction's, a mid-turn one), or no text step of this read starts before it.
    const listed = await read($, steps)
    const fromListed: number[] = []
    S.turnEnds = S.turnEnds.filter(b => {
      const at = pos.get(b)
      if (at === undefined) {
        const held = listed.findIndex(s => s.rows.includes(b))
        if (held < 0) return true
        fromListed.push(held)

        return false
      }
      if (at > limit) return true
      for (let i = closed.length - 1; i >= 0; i--) {
        const start = pos.get(closed[i]!.rows[0]!) ?? Infinity
        if (start <= at && closed[i]!.text.trim() !== '') {
          closed[i] = { ...closed[i]!, isTurnEnd: true }

          return false
        }
      }
      fromListed.push(listed.length - 1)

      return false
    })
    // The last listed step with text at or before each such boundary, unless an earlier turn's end comes first;
    // one already summarized is asked again (one call) so asks_now is known.
    if (fromListed.length > 0) {
      await update($, steps, list => {
        const out = [...list]
        for (const from of fromListed) {
          for (let i = Math.min(from, out.length - 1); i >= 0; i--) {
            const s = out[i]!
            if (s.text.trim() === '') continue
            if (s.isTurnEnd !== true) out[i] = { ...(s.status === 'done' ? mark(s, 'queued') : s), isTurnEnd: true }
            break
          }
        }

        return out
      })
      void work($)
    }
    const last = closed.at(-1)?.rows.at(-1)
    if (last) {
      await update($, anchor, () => last)
      S.cont = continuation(found[closeCount])
      // A typed prompt ends a step and is never inside one: the last closed step's is the one in force at the anchor.
      S.latest = closed.at(-1)!.latest ?? S.latest
    }
    await enqueue($, closed)
    if (!isFull || closed.length === 0) return
  }
}

/**
 * Lists the rows from before the mod started (a resumed session, or the mod loaded mid-session) as steps marked
 * "earlier history": no model call, but collapsible like any other, so old work folds too. They go before the
 * steps already listed and every step is renumbered. Up to the newest 4,096 rows, through the anchor.
 */
async function backfill($: Engine) {
  if (await read($, backfilled)) return
  const upTo = await read($, anchor)
  if (upTo === null) return
  const res = await $.session.messages({ last: PAGE_ROWS })
  // A failed or refused read leaves the flag unset, so the next start tries again.
  if (!Array.isArray(res)) return
  const rows = res as unknown as Row[]
  const end = rows.findIndex(r => r.uuid === upTo)
  // Anchor outside the newest 4,096 rows: every row in reach is already a step, and older rows cannot be read
  // with ids (a ranged read reaches the newest 4,096 only). Nothing more to do (plan item 46).
  const old = end < 0 ? [] : split(rows.slice(0, end + 1), undefined, { outward: S.outward }).filter(isWorthListing)
  await update($, backfilled, () => true)
  if (old.length === 0) return
  await update($, steps, list => {
    const known = new Set(list.map(s => s.id))
    const earlier = old.filter(s => !known.has(s.id)).map(s => mark(s, 'skipped', 'earlier history'))

    return [...earlier, ...list].map((s, i) => ({ ...s, n: i + 1 }))
  })
}

/** At the session's end: what was never scanned is still listed, every step of it skipped, with no call. */
async function recordRest($: Engine) {
  let from = await read($, anchor)
  let cont = S.cont
  while (from !== null) {
    const res = await $.session.messages({ after: from })
    if (!Array.isArray(res)) return
    const rows = res as unknown as Row[]
    const found = split(rows, cont, { outward: S.outward }).filter(isWorthListing)
    const isFull = rows.length >= PAGE_ROWS
    // On a full page the last step may go on in the next one: keep it for that read.
    const closed = isFull ? found.slice(0, -1) : found
    await enqueue($, closed)
    if (!isFull || closed.length === 0) return
    from = closed.at(-1)?.rows.at(-1) ?? null
    cont = continuation(found.at(-1))
  }
}

async function enqueue($: Engine, closed: Step[]) {
  if (closed.length === 0) return
  let seq = await read($, failSeq)
  await update($, steps, list => {
    const out = [...list]
    let n = out.reduce((m, s) => Math.max(m, s.n ?? 0), 0)
    let prevError = out.at(-1)?.tools.some(t => t.isError) ?? false
    // One failure id per tool_use_id for the session: a carried result or a rescan reuses the id stored for it.
    const known = new Map<string, string>()
    for (const s of out) for (const t of s.tools) if (t.fail !== undefined) known.set(t.id, t.fail)
    const failId = (toolId: string) => {
      let id = known.get(toolId)
      if (id === undefined) {
        seq += 1
        id = `f${seq}`
        known.set(toolId, id)
      }

      return id
    }
    // A result read after its call's step was listed: that call ran (its ⇪ is sent, it can resolve a failure).
    const late = new Set(closed.flatMap(s => s.seenEarlier ?? []))
    if (late.size > 0) {
      for (let i = 0; i < out.length; i++) {
        const s = out[i]!
        if (s.tools.some(t => late.has(t.id) && t.seen !== true && t.isError !== true)) {
          out[i] = { ...s, tools: s.tools.map(t => (late.has(t.id) && t.isError !== true ? { ...t, seen: true as const } : t)) }
        }
      }
    }
    const listedCount = out.length
    for (const s of closed) {
      if (out.some(o => o.id === s.id)) continue
      n += 1
      const tools = s.tools.map(t => (t.isError === true ? { ...t, fail: failId(t.id) } : t))
      // A failure whose call was listed in an earlier read belongs to that call's step: marked there (same id), so
      // its ⚠ and its `expected` question are that step's; the carrier here stays only as evidence for a fix.
      for (const t of tools) {
        if (t.fail === undefined || !isCarrier(t)) continue
        const at = out.slice(0, listedCount).findIndex(o => o.tools.some(x => x.id === t.id && !isCarrier(x)))
        if (at < 0) continue
        const owner = out[at]!
        out[at] = {
          // Summarized before the failure was known: asked again (one call), so `expected` is judged. One in flight
          // is asked again when it lands (work() compares its failures).
          ...owner,
          ...(owner.status === 'done' ? { status: 'queued' as const } : {}),
          tools: owner.tools.map(x =>
            x.id === t.id && !isCarrier(x) ? { ...x, isError: true as const, fail: t.fail!, ...(t.error !== undefined ? { error: t.error } : {}) } : x,
          ),
        }
      }
      const step: Step = { ...s, tools, n, errorBefore: prevError }
      // A card or plan that closed has its answer (the tool's result): asked and replied, from the tools alone.
      const asks = askOf(s.tools)
      if (asks !== undefined) Object.assign(step, { asks, isReplied: true })
      prevError = s.tools.some(t => t.isError)
      if (S.isEnded) Object.assign(step, { status: 'skipped', note: 'session ended' })
      else if (!S.isAuto) Object.assign(step, { status: 'skipped', note: 'auto-summarize off' })
      else step.status = 'queued'
      out.push(step)
    }
    // Bounded queue: the oldest waiting steps give way.
    const waiting = out.filter(s => s.status === 'queued')
    const over = waiting.length - QUEUE_MAX
    if (over > 0) {
      const drop = new Set(waiting.slice(0, over).map(s => s.id))

      return out.map(s => (drop.has(s.id) ? mark(s, 'skipped', 'queue full') : s))
    }

    return out
  })
  await update($, failSeq, n => Math.max(n, seq))
  void work($)
}

/** What a step's summary is judged against: the failures open before it, its own, the rules, the latest message. */
async function judgeCtx($: Engine, step: Step): Promise<{ judge: JudgeCtx; check: ParseCtx }> {
  const list = await read($, steps)
  const at = list.findIndex(s => s.id === step.id)
  const line = (f: Failure): FailLine =>
    S.isFailureTextSent && f.error !== undefined ? { id: f.id, brief: f.brief, error: f.error } : { id: f.id, brief: f.brief }
  const open = (at < 0 ? [] : failuresOf(list.slice(0, at))).filter(f => f.isOpen).slice(-OPEN_SENT_MAX).map(line)
  // Its own failures, unless a retry in the step already succeeded; one judged expected before is asked again.
  const own = failures(at < 0 ? [step] : list.slice(0, at + 1))
    .filter(f => f.stepId === step.id && f.how !== 'retry' && f.how !== 'fixed')
    .map(line)
  const rules = S.isJudged ? await rulesText($) : undefined
  const judge: JudgeCtx = { open, own }
  if (rules !== undefined) judge.rules = rules
  if (S.isJudged && step.latest !== undefined) judge.latest = step.latest
  const check: ParseCtx = { openIds: open.map(f => f.id), ownIds: own.map(f => f.id), calls: ownCalls(step), text: step.text }
  if (rules !== undefined) check.rules = rules

  return { judge, check }
}

// ---- the summary queue ------------------------------------------------------------------------------------

async function patch($: Engine, id: string, change: Partial<Step>) {
  await update($, steps, list => list.map(s => (s.id === id ? { ...s, ...change } : s)))
}

/** One call at a time, until the queue is empty, the session ends or the cap is reached. */
async function work($: Engine) {
  if (S.isWorking) return
  S.isWorking = true
  try {
    for (;;) {
      if (S.isEnded) return
      const next = (await read($, steps)).find(s => s.status === 'queued')
      if (next === undefined) return
      if ((await read($, calls)).tried >= S.maxCalls) {
        await update($, steps, list =>
          list.map(s => (s.status === 'queued' ? mark(s, 'skipped', 'call cap reached') : s)),
        )
        $.ui.log(`work-lens: stopped summarizing at the cap of ${S.maxCalls} calls (raise it in /config)`)

        return
      }
      await patch($, next.id, { status: 'running' })
      const plan = await planText($)
      const ctx = await judgeCtx($, next)
      const verdict = await summarize($, next, plan, ctx)
      if (S.isEnded) return
      if (verdict === 'cap') {
        await update($, steps, list =>
          list.map(s => (s.status === 'queued' || s.id === next.id ? mark(s, 'skipped', 'call cap reached') : s)),
        )
        $.ui.log(`work-lens: stopped summarizing at the cap of ${S.maxCalls} calls (raise it in /config)`)

        return
      }
      if (verdict === null) {
        await patch($, next.id, { status: 'unavailable' })
      } else {
        const { kind, isRelatesVerified } = kindOf(verdict, plan, next.text)
        // A failure attached to the step while its call ran was not in the prompt: keep the summary, ask again.
        const failsOf = (s: Step | undefined) => (s?.tools ?? []).filter(t => t.fail !== undefined).length
        const now = (await read($, steps)).find(s => s.id === next.id)
        const isStale = failsOf(now) > failsOf(next)
        await patch($, next.id, {
          status: isStale ? 'queued' : 'done',
          summary: verdict.summary,
          category: verdict.category,
          kind,
          relates: verdict.relates,
          isRelatesVerified,
          // Only a turn's end is asked; a card or plan found from the tools keeps its own kind. isReplied is
          // never set here, so a reply that came in while this ran stands (plan item 49).
          ...(next.isTurnEnd === true && verdict.asksNow && next.asks === undefined ? { asks: 'text' as const } : {}),
          // Each summary's judgments replace the last ones (a re-asked turn end included).
          fixes: verdict.fixes,
          expected: verdict.expected,
          deviation: verdict.deviation,
          assumption: verdict.assumption,
        })
      }
      // Fullscreen shows the summary on the step itself; anywhere else (or not known yet) it is a log line.
      if (S.isFullscreen !== true) {
        const list = await read($, steps)
        const done = list.find(s => s.id === next.id)
        const words = next.text.trim().split(/\s+/).slice(0, 5).join(' ')
        const flag = done && isWaiting(done) ? '❗ input needed · ' : ''
        const why = done ? flagText(done, failuresOf(list)) : ''
        if (done) $.ui.log(`work-lens step ${done.n}${words ? ` "${words}…"` : ''} — ${flag}${lineOf(done)}${why ? ` · ${why}` : ''}`)
      }
    }
  } finally {
    S.isWorking = false
  }
}

/**
 * Up to two attempts: a retry for malformed JSON, or after 5 s for a 429 or 5xx. Every attempt counts toward the
 * cap, checked before each one: 'cap' when no attempt is left.
 */
async function summarize(
  $: Engine,
  step: Step,
  plan: string,
  ctx: { judge: JudgeCtx; check: ParseCtx },
): Promise<Verdict | null | 'cap'> {
  const built = buildPrompt(step, S.categories, plan, step.errorBefore === true, ctx.judge)
  const prompt = built.prompt
  // The rule excerpt goes first and is cached: the same text opens every call for a while.
  const system = built.rules !== undefined ? [{ text: `${built.rules}\n\n`, cache: true as const }, { text: built.system }] : built.system
  for (let attempt = 0; attempt < 2; attempt++) {
    if (S.isEnded) return null
    if ((await read($, calls)).tried >= S.maxCalls) return attempt === 0 ? 'cap' : null
    S.stop = new AbortController()
    await update($, calls, c => ({ ...c, tried: c.tried + 1 }))
    const r = await $.model
      .complete({ model: S.model, system, prompt, maxTokens: 300, effort: 'low', timeoutMs: 60_000 }, { signal: S.stop.signal })
      .catch(() => null)
    S.stop = null
    if (r === null) return null
    if (r.isAnswered) {
      await update($, calls, c => ({ ...c, answered: c.answered + 1 }))
      const v = parse(r.text, S.categories, ctx.check)
      if (v !== null) return v
      continue
    }
    if (r.reason === 'api-error' && (r.status === 429 || (r.status ?? 0) >= 500)) {
      await $.clock.sleep(5_000).catch(() => undefined)
      continue
    }

    return null
  }

  return null
}

// ---- drawing ----------------------------------------------------------------------------------------------

function indexOf(list: readonly Step[]) {
  let map = S.index.get(list)
  if (map === undefined) {
    map = new Map()
    for (const s of list) {
      for (const id of s.rows) if (id) map.set(id, s)
      for (const id of s.toolIds) map.set(id, s)
    }
    S.index.set(list, map)
  }

  return map
}

function noteSurface(e: { viewport?: { isFullscreen?: boolean } }) {
  if (e.viewport?.isFullscreen !== undefined) S.isFullscreen = e.viewport.isFullscreen
}

/** Every step that has finished its turn in the queue folds: summarized, skipped or unavailable alike. */
const isCollapsible = (s: Step) => s.status === 'done' || s.status === 'skipped' || s.status === 'unavailable'

/** How one transcript site draws: as itself, with the step's header, as the header alone, or not at all. */
type SiteView =
  | { mode: 'pass' }
  | { mode: 'hidden' }
  | { mode: 'header'; step: Step; isCollapsed: boolean; newest: string | undefined; open: ReadonlySet<string> }
  | { mode: 'both'; step: Step; isCollapsed: boolean; newest: string | undefined; open: ReadonlySet<string> }

/** `isHead` says whether this site is the one that carries a step's header. */
async function siteView($: Engine, ids: readonly string[], isHead: (s: Step) => boolean): Promise<SiteView> {
  const list = await read($, steps)
  if (list.length === 0) return { mode: 'pass' as const }
  const index = indexOf(list)
  const owners = [...new Set(ids.map(id => index.get(id)).filter((s): s is Step => s !== undefined))]
  if (owners.length === 0) return { mode: 'pass' as const }
  const f = await read($, filter)
  const flips = await read($, toggled)
  const open = openOf(list)
  const shown = owners.filter(s => passes(s, f, open))
  if (shown.length === 0) return { mode: 'hidden' as const }
  const newest = newestTurnEnd(list)
  // A question or the turn's report starts open until the person replies; a press still flips it.
  const isCollapsed = (s: Step) =>
    isCollapsible(s) && ((S.isCollapsedByDefault && !isKeptOpen(s, newest)) !== (flips[s.id] === true))
  // The header is the first shown step whose header site this is: in a shared ToolGroup, the first step that the
  // filter shows, so a shown step never loses its only header to a hidden one (plan item 31).
  const head = shown.find(s => ids.includes(headerSite(s)) && isHead(s))
  const isAllCollapsed = shown.every(isCollapsed)
  if (head === undefined) return isAllCollapsed ? { mode: 'hidden' } : { mode: 'pass' }
  const at = { step: head, isCollapsed: isCollapsed(head), newest, open }

  return isAllCollapsed ? { mode: 'header', ...at } : { mode: 'both', ...at }
}

type Render = import('claude-code').RenderInput
type Draw = () => Promise<import('claude-code').RenderElement>

/**
 * Draws one transcript site under the step view: unchanged, hidden, as the step's header, or header + itself.
 * Only in the fullscreen layout: the main screen has printed its rows into scrollback, so it is never folded.
 */
async function drawSite($: Engine, e: Render, ids: readonly string[], original: Draw, isHead: (s: Step) => boolean) {
  if (e.viewport?.isFullscreen !== true) return original()
  const view = await siteView($, ids, isHead)
  if (view.mode === 'pass') return original()
  const { Box, Button, Text } = $.ui.resolve(e)
  if (view.mode === 'hidden') return <Box />
  const s = view.step
  const header = (
    <Button key={`wl-${s.id}`} plain onPress={() => toggle($, s.id)}>
      {`${view.isCollapsed ? '▸' : '▾'} `}
      {badge(s, view.newest, Text)}
      {flags(s, view.open, Text)}
      <Mark step={s} Text={Text} />
      {` ${restOf(s)}`}
      <Text dimColor>{`  #${s.n}${s.part > 1 ? ` part ${s.part}` : ''}`}</Text>
    </Button>
  )
  if (view.mode === 'header') return <Box>{header}</Box>

  return (
    <Box flexDirection="column">
      {header}
      {await original()}
    </Box>
  )
}

function toggle($: Engine, id: string) {
  return update($, toggled, t => {
    const next = { ...t }
    if (next[id]) delete next[id]
    else next[id] = true

    return next
  })
}

// ---- registration -----------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  // A category may not take a name the filters already use (all, a valence, a kind, summarize), nor repeat.
  const reserved = new Set([
    'all',
    'summarize',
    'unconfirmed',
    ...MARKS,
    ...FLAGS,
    ...VALENCES,
    ...KINDS,
    ...GROUP_IDS,
    ...Object.keys(GROUP_ALIASES),
  ])
  const compiled = compilePatterns(String(options.outwardPatterns ?? ''))
  S.outward = compiled.patterns
  S.badPatterns = compiled.bad
  S.isJudged = options.judgeRules !== false
  S.isFailureTextSent = options.sendFailureText !== false
  const named = String(options.categories ?? '')
    .split(',')
    .map(c => c.trim())
    .filter(c => c !== '')
  // A category named like a filter or a group is left out (and logged once at start); a repeat is dropped quietly.
  S.badCategories = named.filter(c => reserved.has(c.toLowerCase()))
  const cats = named.filter((c, i, all) => !reserved.has(c.toLowerCase()) && all.findIndex(o => o.toLowerCase() === c.toLowerCase()) === i)
  if (cats.length > 0) S.categories = cats
  S.isGrouped = String(options.labelDetail ?? 'grouped').trim().toLowerCase() !== 'all'
  const wanted = String(options.labelGroups ?? GROUP_IDS.join(', '))
    .split(',')
    .map(g => g.trim().toLowerCase())
    .filter(g => g !== '')
  const known = wanted.map(g => GROUP_ALIASES[g] ?? g).filter(isGroup)
  S.badGroups = wanted.filter(g => !isGroup(GROUP_ALIASES[g] ?? g))
  // None named (or none known): every group, in the standard order.
  S.groups = known.length > 0 ? GROUP_IDS.filter(g => known.includes(g)) : [...GROUP_IDS]
  S.model = String(options.model ?? 'haiku')
  S.isAuto = options.autoSummarize !== false
  S.isCollapsedByDefault = options.collapseByDefault !== false
  const lower = S.categories.map(c => c.toLowerCase())
  S.neutral = String(options.neutralCategories ?? 'notes')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(c => lower.includes(c))
    .map(c => S.categories[lower.indexOf(c)]!)
  S.maxCalls = Math.max(1, Number(options.maxCalls ?? 200))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    S.isEnded = false
    await $.command.register({
      name: 'worklog',
      description: 'work-lens: open the Work log, filter steps, or summarize skipped ones',
      argumentHint: '[all|needs|review|purpose|work|input|report|unresolved|outward|deviation|assumption|planned|new|fix|<category>|summarize]',
    })
    if (S.badPatterns.length > 0) {
      $.ui.log(`work-lens: outwardPatterns left out (not a valid pattern): ${S.badPatterns.join(', ')}`)
      S.badPatterns = []
    }
    if (S.badGroups.length > 0) {
      $.ui.log(`work-lens: labelGroups left out (no such group; use ${GROUP_IDS.join(', ')}): ${S.badGroups.join(', ')}`)
      S.badGroups = []
    }
    if (S.badCategories.length > 0) {
      $.ui.log(`work-lens: categories left out (the name is a filter or group): ${S.badCategories.join(', ')}`)
      S.badCategories = []
    }
    if ((await read($, anchor)) === null) await setAnchorToNewest($)
    await backfill($).catch(() => undefined)
    void work($)

    return result
  })

  on('session.end', async ($, e, next) => {
    S.isEnded = true
    S.timer?.cancel()
    S.stop?.abort()
    if (e.reason === 'clear') {
      // The process goes on under a new session: start the log over.
      await update($, steps, () => [])
      await update($, anchor, () => null)
      await update($, backfilled, () => false)
      await update($, calls, () => ({ tried: 0, answered: 0 }))
      await update($, failSeq, () => 0)
      await update($, openGroup, () => null)
      S.cont = undefined
      S.latest = undefined
      // The new session's context brings its own files; nothing of the old one is sent.
      S.instr = undefined
      S.rules = null
      S.isEnded = false
    } else {
      await update($, steps, list =>
        list.map(s =>
          s.status === 'queued' || s.status === 'running' ? mark(s, 'skipped', 'session ended') : s,
        ),
      )
      await recordRest($).catch(() => undefined)
    }

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.message.type === 'assistant' && e.agentId === undefined && S.timer === null && !S.isEnded) {
      try {
        S.timer = $.clock.after(DEBOUNCE_MS, () => {
          S.timer = null
          void scan($, false).catch(() => undefined)
        })
      } catch {
        S.timer = null
      }
    }

    return result
  })

  // Before the main conversation compacts, every row up to now is split into closed steps, so the work still on
  // screen after the compaction belongs to steps that fold (their text is kept in state; summaries need no rows).
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined && e.trigger !== 'precompute' && !S.isEnded) {
      S.timer?.cancel()
      S.timer = null
      S.compactionAnchor = null
      try {
        await scan($, true)
        S.compactionAnchor = await read($, anchor)
      } catch {
        // The scan failed: the notice stays on for whatever the compaction removes.
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.timer?.cancel()
      S.timer = null
      // The turn's boundary: its newest row. Kept until a scan closes the step that holds it (at most 20 kept).
      const newest = await $.session.messages({ last: 1 }).catch(() => undefined)
      const uuid = Array.isArray(newest) ? newest[0]?.uuid : undefined
      if (typeof uuid === 'string') S.turnEnds = [...S.turnEnds, uuid].slice(-20)
      await scan($, true).catch(() => undefined)
    }

    return next(e)
  })

  // A prompt the person typed (not a slash command, not a message they never saw) is their reply: every turn end
  // and question before it is replied, whatever its summary's state, and folds by the usual rule from then on.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      const list = await read($, steps)
      const ids = new Set(list.filter(s => (s.isTurnEnd === true || s.asks !== undefined) && s.isReplied !== true).map(s => s.id))
      if (ids.size > 0) {
        await update($, steps, l => l.map(s => (ids.has(s.id) ? { ...s, isReplied: true } : s)))
        // A press made while it was held open would now read inverted: forget it.
        await update($, toggled, t => Object.fromEntries(Object.entries(t).filter(([id]) => !ids.has(id))) as typeof t)
      }
    }

    return next(e)
  })

  // The instruction files the session sends (CLAUDE.md files, the memory index): read for the rule excerpt,
  // passed on unchanged.
  on('prompt.context', async ($, e, next) => {
    // Each context replaces the last: undefined (another hook rewrote them) means no instruction files are used.
    // Compared by content, so the cached excerpt is rebuilt only when the files changed.
    const sig = (files: typeof S.instr) =>
      files === undefined ? '' : files.map(f => `${f.path}\u0000${f.kind}\u0000${f.content}`).join('\u0001')
    if (sig(e.instructionFiles) !== sig(S.instr) || (e.instructionFiles === undefined) !== (S.instr === undefined)) {
      S.instr = e.instructionFiles
      S.rules = null
    }

    return next(e)
  })

  on('command.run', { command: 'worklog' }, async ($, e) => {
    S.isFullscreen = e.presentation.isFullscreen
    const arg = e.args.trim().toLowerCase()
    if (arg === 'summarize') {
      await update($, steps, list =>
        list.map(s => (s.status === 'skipped' && s.note !== 'session ended' ? mark(s, 'queued') : s)),
      )
      void work($)

      return { text: 'work-lens: summarizing the skipped steps now.' }
    }
    if (arg !== '') {
      const wanted = GROUP_ALIASES[arg] ?? arg
      const value = typedChoices().find(c => c.toLowerCase() === wanted)
      if (value === undefined) {
        return { text: `work-lens: no filter "${arg}". Try one of: ${[...GROUP_IDS, ...filterChoices()].join(', ')}.` }
      }
      await update($, filter, () => value)
    }
    if (arg === '' && e.presentation.isFullscreen) {
      await $.ui.open({ id: PANE, title: 'Work log' })

      return { text: 'work-lens: Work log opened.' }
    }
    const f = await read($, filter)
    const all = await read($, steps)
    const open = openOf(all)
    const fails = failuresOf(all)
    const list = all.filter(s => passes(s, f, open))
    const lines = list.slice(-40).map(s => {
      const why = flagText(s, fails)

      return `#${s.n}${s.part > 1 ? ` (part ${s.part})` : ''} ${lineOf(s)}${why ? ` · ${why}` : ''}`
    })
    const note = isHiddenFilter(f) ? ' (hidden group)' : ''

    return { text: [`work-lens · filter: ${f}${note} · ${list.length} steps`, ...lines].join('\n') }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    noteSurface(e)
    const text = e.props.text

    return drawSite($, e, [e.requestId], () => next(e), s => isOpeningBlock(s, text))
  })

  // A tool's output (Bash stdout, an edit's diff, a file read) draws as its own row under the call: it folds and
  // filters with its step, never carries the header, and ctrl+o (isExpanded) shows it in full.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    noteSurface(e)
    if (e.props.isExpanded) return next(e)

    return drawSite($, e, [e.requestId], () => next(e), () => false)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    noteSurface(e)
    if (e.props.isExpanded) return next(e)

    return drawSite($, e, [e.requestId], () => next(e), () => true)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    noteSurface(e)
    if (e.props.isExpanded) return next(e)
    const ids = e.props.calls.map(c => c.tool_use_id).filter((id): id is string => typeof id === 'string')

    return drawSite($, e, ids, () => next(e), () => true)
  })

  // The line above the prompt: every count is a filter. Press one to filter, press it again for all.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, steps)
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const f = await read($, filter)
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = list.filter(s => s.status === 'queued' || s.status === 'running').length
    const waiting = list.filter(isWaiting).length
    const open = openOf(list)
    const unresolved = failuresOf(list).filter(x => x.isOpen).length
    const hidden = f === 'all' ? 0 : list.filter(s => !passes(s, f, open)).length
    // Steps with no summary pass every filter (never hidden unlabeled); the line says how many it kept, and why.
    const kept = unsummarized(list)
    const og = await read($, openGroup)
    // Only the labels with steps, plus all, back, the groups and the one in use, so the line stays short.
    const chips = chipsFor(f, og).filter(i => i.type !== 'label' || i.choice === 'all' || i.choice === f || countFor(list, i.choice) > 0)
    const isNeedsShown = S.groups.includes('needs')

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>{'work-lens '}</Text>
        {chips.map(i => (
          <Button key={`band-${i.key}`} plain onPress={() => pressChip($, i, f, og)}>
            <ChipView item={i} list={list} isActive={isChipActive(i, f, og)} Text={Text} />
          </Button>
        ))}
        {isNeedsShown && waiting > 0 && <Text bold color="warning">{`  ❗ ${waiting} waiting on you`}</Text>}
        {isNeedsShown && unresolved > 0 && <Text color="error">{`  ⚠ ${unresolved} unresolved`}</Text>}
        {busy > 0 && <Text dimColor>{` … ${busy} summarizing`}</Text>}
        {f !== 'all' && <Text dimColor>{` · ${hidden} hidden${kept !== '' ? ` · ${kept}` : ''}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, steps)
    const f = await read($, filter)
    const used = await read($, calls)
    const open = openOf(list)
    const fails = failuresOf(list)
    const shown = list.filter(s => passes(s, f, open))
    const newest = newestTurnEnd(list)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)
    const og = await read($, openGroup)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {chipsFor(f, og).map((item, i) => (
            <Button key={`f-${item.key}`} plain hotkey={i < 9 ? String(i + 1) : undefined} onPress={() => pressChip($, item, f, og)}>
              <ChipView item={item} list={list} isActive={isChipActive(item, f, og)} Text={Text} />
            </Button>
          ))}
        </Box>
        <Text dimColor>{`${used.answered} summaries · ${used.tried}/${S.maxCalls} calls · model ${S.model}`}</Text>
        {shown.length === 0 && <Text dimColor>No steps yet.</Text>}
        {shown.slice(-room).map(s => (
          <Button key={`s-${s.id}`} plain onPress={() => toggle($, s.id)}>
            <Text dimColor>{`#${s.n} `}</Text>
            {badge(s, newest, Text)}
            {flags(s, open, Text)}
            <Mark step={s} Text={Text} />
            {` ${restOf(s)}`}
            {flagText(s, fails) !== '' && <Text dimColor>{`  ${flagText(s, fails)}`}</Text>}
          </Button>
        ))}
      </Box>
    )
  })
}

/**
 * Whether a step holds a label (what a count counts): the flags verdict or not, input and report too; the rest only
 * with a verdict. A group: any of its labels. Unlike `passes`, a waiting or unlabeled step kept on screen is not
 * counted for a label it does not hold.
 */
function holds(s: Step, choice: string, open: ReadonlySet<string>): boolean {
  if (isGroup(choice)) return membersOf(choice).some(m => holds(s, m, open))
  if ((FLAGS as readonly string[]).includes(choice)) return hasFlag(s, choice, open)
  if (choice === 'input') return s.asks !== undefined || (s.isTurnEnd === true && s.status !== 'done')
  if (choice === 'report') return s.isTurnEnd === true

  return s.status === 'done' && isShown(s, choice, S.neutral)
}

/** How many steps hold a filter's label ('all' counts every step). */
function countFor(list: readonly Step[], choice: string) {
  if (choice === 'all') return list.length
  const open = openOf(list)

  return list.filter(s => holds(s, choice, open)).length
}

/**
 * The steps with no summary, which a filter keeps in view since they have no label to filter on, counted by why:
 * "earlier history" (before the mod started: never summarized unless asked), "call cap reached", "queue full",
 * "session ended", or "summary failed". Steps being summarized are left out (the band counts them apart).
 * Example: "100 without a summary, kept in view (92 earlier history, 8 call cap reached; /worklog summarize)".
 */
function unsummarized(list: readonly Step[]) {
  const why = new Map<string, number>()
  let canAsk = 0
  for (const s of list) {
    if (s.status === 'done' || s.status === 'queued' || s.status === 'running') continue
    const reason = s.status === 'unavailable' ? 'summary failed' : (s.note ?? 'skipped')
    why.set(reason, (why.get(reason) ?? 0) + 1)
    // `/worklog summarize` asks for the skipped ones, except those of a session that ended.
    if (s.status === 'skipped' && s.note !== 'session ended') canAsk += 1
  }
  const n = [...why.values()].reduce((a, b) => a + b, 0)
  if (n === 0) return ''
  const parts = [...why.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${c} ${r}`)

  return `${n} without a summary, kept in view (${parts.join(', ')}${canAsk > 0 ? '; /worklog summarize' : ''})`
}

/** A filter that names a label or group not drawn (`labelGroups`): still usable when typed, marked as hidden. */
const isHiddenFilter = (f: string) => f !== 'all' && (isGroup(f) || groupOf(f) !== undefined) && !isLabelShown(f)

/** Groups whose chip carries a count: the ones a step may or may not hold (nearly every step has a kind and a category). */
const isCountedGroup = (g: GroupId) => g === 'needs' || g === 'review'

/** A note after an active filter's chip shown out of its place: its group hidden, or another group open. */
type ChipItem = { key: string; choice: string; type: 'label' | 'group' | 'back'; note?: '(hidden)' | '(other group)' }

/**
 * The chips of the band and the pane, in order.
 * - Grouped, no group open: all, then one chip per group shown.
 * - Grouped, a group open: back, the group itself, then its labels.
 * - All: every label of the groups shown.
 * The active filter always has a chip (marked hidden when its group is not shown), so it can be seen and pressed off.
 */
function chipsFor(f: string, open: string | null): ChipItem[] {
  const og = open !== null && isGroup(open) && S.groups.includes(open) ? open : null
  // `all` is the layout before 0.5.1, every chip side by side, the value chips (▲■▼) included.
  const items: ChipItem[] = !S.isGrouped
    ? ['all', ...MARKS, ...FLAGS, ...VALENCES, ...KINDS, ...S.categories]
        .filter(c => c === 'all' || isLabelShown(c) || (VALENCES as readonly string[]).includes(c))
        .map(c => ({ key: c, choice: c, type: 'label' as const }))
    : og === null
      ? [{ key: 'all', choice: 'all', type: 'label' as const }, ...S.groups.map(g => ({ key: g, choice: g, type: 'group' as const }))]
      : [
          { key: '‹', choice: og, type: 'back' as const },
          { key: og, choice: og, type: 'group' as const },
          ...membersOf(og).map(c => ({ key: c, choice: c, type: 'label' as const })),
        ]
  // In grouped mode with no group open, a label filter shows through its group's chip.
  const isCovered = S.isGrouped && og === null && isLabelShown(f) && !isGroup(f)
  if (f !== 'all' && !isCovered && !items.some(i => i.type !== 'back' && i.choice === f)) {
    const note = isHiddenFilter(f) ? '(hidden)' : og !== null && (isGroup(f) || groupOf(f) !== undefined) ? '(other group)' : undefined
    items.push({ key: `active-${f}`, choice: f, type: isGroup(f) ? 'group' : 'label', ...(note ? { note } : {}) })
  }

  return items
}

/** Whether a chip shows as the one in use: the filter itself, or (no group open) the group holding it. */
const isChipActive = (item: ChipItem, f: string, open: string | null) =>
  item.type !== 'back' && (item.choice === f || (item.type === 'group' && open === null && isGroup(item.choice) && groupOf(f) === item.choice))

/** What pressing a chip does: back closes the group; a group opens and filters by it; a label filters (again: all). */
async function pressChip($: Engine, item: ChipItem, f: string, open: string | null) {
  if (item.type === 'back') return update($, openGroup, () => null)
  if (item.type === 'group' && S.isGrouped && open !== item.choice && S.groups.includes(item.choice as GroupId)) {
    await update($, openGroup, () => item.choice)

    return update($, filter, () => item.choice)
  }

  return update($, filter, () => (item.choice === f ? 'all' : item.choice))
}

/** One chip of either kind: a label, a group (its title, a count when it carries one), or back. */
function ChipView({ item, list, isActive, Text }: { item: ChipItem; list: readonly Step[]; isActive: boolean; Text: any }) {
  const hidden = item.note !== undefined ? <Text dimColor>{` ${item.note}`}</Text> : undefined
  if (item.type === 'back') return <Text dimColor>{'  ‹ groups'}</Text>
  if (item.type === 'label') {
    return (
      <Text>
        <Chip choice={item.choice} count={countFor(list, item.choice)} isActive={isActive} Text={Text} />
        {hidden}
      </Text>
    )
  }
  const g = item.choice as GroupId
  const color = g === 'needs' ? 'error' : g === 'review' ? 'warning' : undefined

  return (
    <Text bold={isActive}>
      {isActive ? ' [' : '  '}
      {color ? <Text color={color}>{GROUP_TITLE[g]}</Text> : GROUP_TITLE[g]}
      {isCountedGroup(g) ? ` ${countFor(list, g)}` : ''}
      {isActive ? ']' : ''}
      {hidden}
    </Text>
  )
}

const GLYPH: Record<string, string> = {
  input: '❗',
  report: '★',
  unresolved: '⚠',
  outward: '⇪',
  deviation: '⚑',
  assumption: '◇',
  positive: '▲',
  neutral: '■',
  negative: '▼',
  planned: '●',
  new: '◆',
  fix: '✚',
}

/** One filter as a chip: its glyph in its valence color, its name and count; the active one bracketed and bold. */
function Chip({ choice, count, isActive, Text }: { choice: string; count: number; isActive: boolean; Text: any }) {
  const color =
    choice === 'input' || choice === 'outward'
      ? 'warning'
      : choice === 'unresolved' || choice === 'deviation'
        ? 'error'
        : choice === 'assumption'
          ? 'inactive'
      : choice === 'report'
        ? 'suggestion'
        : choice === 'positive' || choice === 'planned' || choice === 'new'
      ? VALENCE_COLOR.positive
      : choice === 'negative' || choice === 'fix'
        ? VALENCE_COLOR.negative
        : choice === 'neutral' || S.neutral.includes(choice)
          ? VALENCE_COLOR.neutral
          : undefined
  const glyph = GLYPH[choice]

  return (
    <Text bold={isActive}>
      {isActive ? ' [' : '  '}
      {glyph && <Text color={color}>{`${glyph} `}</Text>}
      {color && !glyph ? <Text color={color}>{choice}</Text> : choice}
      {` ${count}`}
      {isActive ? ']' : ''}
    </Text>
  )
}
