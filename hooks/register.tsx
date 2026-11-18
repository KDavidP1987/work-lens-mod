import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Step } from '../types'
import {
  buildPrompt,
  continuation,
  headerSite,
  isOpeningBlock,
  isShown,
  kindOf,
  label,
  labelParts,
  mark,
  PAGE_ROWS,
  parse,
  redact,
  split,
  valence,
  VALENCE_COLOR,
  VALENCES,
} from './steps'
import type { Continuation, Row, Verdict } from './steps'

const PANE = 'work-log'
const QUEUE_MAX = 20
const DEBOUNCE_MS = 10_000
const PLAN_TTL_MS = 60_000
const PLAN_MAX = 8000
const PLAN_FILES = ['BACKLOG.md', 'docs/dod/README.md', '.orchestration/handoff.md', 'PLAN.md', 'TODO.md']
const KINDS = ['planned', 'new', 'fix'] as const

/** Every filter in the order the band and pane offer them: all, valences, kinds, then the categories. */
const filterChoices = () => ['all', ...VALENCES, ...KINDS, ...S.categories]

/** The marker drawn in its valence's color (plain when the step has no verdict yet). */
function Mark({ step, Text }: { step: Step; Text: any }) {
  const v = valence(step, S.neutral)

  return v ? <Text color={VALENCE_COLOR[v]}>{labelParts(step).mark}</Text> : <Text>{labelParts(step).mark}</Text>
}

const steps = atom({ plugin: 'work-lens', key: 'steps' } as const, [])
const filter = atom({ plugin: 'work-lens', key: 'filter' } as const, 'all')
const toggled = atom({ plugin: 'work-lens', key: 'toggled' } as const, {})
const calls = atom({ plugin: 'work-lens', key: 'calls' } as const, { tried: 0, answered: 0 })
const anchor = atom({ plugin: 'work-lens', key: 'anchor' } as const, null)

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
  plan: { text: '', at: 0 },
  index: new WeakMap<readonly Step[], Map<string, Step>>(),
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
    const res = await $.session.messages({ after: from })
    if (!Array.isArray(res)) {
      // The anchor fell to a compaction: start again from the newest row.
      S.cont = undefined
      await setAnchorToNewest($)
      $.ui.log('work-lens: a compaction removed rows before they were summarized; those steps are skipped')

      return
    }
    const rows = res as unknown as Row[]
    const isFull = rows.length >= PAGE_ROWS
    const found = split(rows, S.cont).filter(isWorthListing)
    const closeCount = isClosing && !isFull ? found.length : found.length - 1
    const closed = found.slice(0, Math.max(0, closeCount))
    const last = closed.at(-1)?.rows.at(-1)
    if (last) {
      await update($, anchor, () => last)
      S.cont = continuation(found[closeCount])
    }
    await enqueue($, closed)
    if (!isFull || closed.length === 0) return
  }
}

/** At the session's end: what was never scanned is still listed, every step of it skipped, with no call. */
async function recordRest($: Engine) {
  let from = await read($, anchor)
  let cont = S.cont
  while (from !== null) {
    const res = await $.session.messages({ after: from })
    if (!Array.isArray(res)) return
    const rows = res as unknown as Row[]
    const found = split(rows, cont).filter(isWorthListing)
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
  await update($, steps, list => {
    const out = [...list]
    let n = out.reduce((m, s) => Math.max(m, s.n ?? 0), 0)
    let prevError = out.at(-1)?.tools.some(t => t.isError) ?? false
    for (const s of closed) {
      if (out.some(o => o.id === s.id)) continue
      n += 1
      const step: Step = { ...s, n, errorBefore: prevError }
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
  void work($)
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
      const verdict = await summarize($, next, plan)
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
        await patch($, next.id, {
          status: 'done',
          summary: verdict.summary,
          category: verdict.category,
          kind,
          relates: verdict.relates,
          isRelatesVerified,
        })
      }
      // Fullscreen shows the summary on the step itself; anywhere else (or not known yet) it is a log line.
      if (S.isFullscreen !== true) {
        const done = (await read($, steps)).find(s => s.id === next.id)
        const words = next.text.trim().split(/\s+/).slice(0, 5).join(' ')
        if (done) $.ui.log(`work-lens step ${done.n}${words ? ` "${words}…"` : ''} — ${label(done)}`)
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
async function summarize($: Engine, step: Step, plan: string): Promise<Verdict | null | 'cap'> {
  const { system, prompt } = buildPrompt(step, S.categories, plan, step.errorBefore === true)
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
      const v = parse(r.text, S.categories)
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

const isCollapsible = (s: Step) => s.status === 'done'

/** How one transcript site draws: as itself, with the step's header, as the header alone, or not at all. */
type SiteView =
  | { mode: 'pass' }
  | { mode: 'hidden' }
  | { mode: 'header'; step: Step; isCollapsed: boolean }
  | { mode: 'both'; step: Step; isCollapsed: boolean }

/** `isHead` says whether this site is the one that carries a step's header. */
async function siteView($: Engine, ids: readonly string[], isHead: (s: Step) => boolean): Promise<SiteView> {
  const list = await read($, steps)
  if (list.length === 0) return { mode: 'pass' as const }
  const index = indexOf(list)
  const owners = [...new Set(ids.map(id => index.get(id)).filter((s): s is Step => s !== undefined))]
  if (owners.length === 0) return { mode: 'pass' as const }
  const f = await read($, filter)
  const flips = await read($, toggled)
  const shown = owners.filter(s => isShown(s, f, S.neutral))
  if (shown.length === 0) return { mode: 'hidden' as const }
  const isCollapsed = (s: Step) => isCollapsible(s) && (S.isCollapsedByDefault !== (flips[s.id] === true))
  // The header is the first shown step whose header site this is: in a shared ToolGroup, the first step that the
  // filter shows, so a shown step never loses its only header to a hidden one (plan item 31).
  const head = shown.find(s => ids.includes(headerSite(s)) && isHead(s))
  const isAllCollapsed = shown.every(isCollapsed)
  if (head === undefined) return isAllCollapsed ? { mode: 'hidden' } : { mode: 'pass' }
  const at = { step: head, isCollapsed: isCollapsed(head) }

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
      <Mark step={s} Text={Text} />
      {` ${labelParts(s).rest}`}
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
  const reserved = new Set(['all', 'summarize', 'unconfirmed', ...VALENCES, ...KINDS])
  const cats = String(options.categories ?? '')
    .split(',')
    .map(c => c.trim())
    .filter((c, i, all) => c !== '' && !reserved.has(c.toLowerCase()) && all.findIndex(o => o.toLowerCase() === c.toLowerCase()) === i)
  if (cats.length > 0) S.categories = cats
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
      argumentHint: '[all|positive|neutral|negative|planned|new|fix|<category>|summarize]',
    })
    if ((await read($, anchor)) === null) await setAnchorToNewest($)
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
      await update($, calls, () => ({ tried: 0, answered: 0 }))
      S.cont = undefined
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

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.timer?.cancel()
      S.timer = null
      await scan($, true).catch(() => undefined)
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
    const choices = filterChoices()
    if (arg !== '') {
      const value = choices.find(c => c.toLowerCase() === arg)
      if (value === undefined) return { text: `work-lens: no filter "${arg}". Try one of: ${choices.join(', ')}.` }
      await update($, filter, () => value)
    }
    if (arg === '' && e.presentation.isFullscreen) {
      await $.ui.open({ id: PANE, title: 'Work log' })

      return { text: 'work-lens: Work log opened.' }
    }
    const f = await read($, filter)
    const list = (await read($, steps)).filter(s => isShown(s, f, S.neutral))
    const lines = list.slice(-40).map(s => `#${s.n}${s.part > 1 ? ` (part ${s.part})` : ''} ${label(s)}`)

    return { text: [`work-lens · filter: ${f} · ${list.length} steps`, ...lines].join('\n') }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    noteSurface(e)
    const text = e.props.text

    return drawSite($, e, [e.requestId], () => next(e), s => isOpeningBlock(s, text))
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
    const hidden = f === 'all' ? 0 : list.filter(s => !isShown(s, f, S.neutral)).length
    // Steps with no verdict yet pass every filter (never hidden unlabeled); the line says how many it kept.
    const pending = list.filter(s => s.status !== 'done').length
    // Only the filters with steps, plus all and the one in use, so the line stays short.
    const chips = filterChoices().filter(c => c === 'all' || c === f || countFor(list, c) > 0)

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>{'work-lens '}</Text>
        {chips.map(c => (
          <Button key={`band-${c}`} plain onPress={() => update($, filter, () => (c === f ? 'all' : c))}>
            <Chip choice={c} count={countFor(list, c)} isActive={c === f} Text={Text} />
          </Button>
        ))}
        {busy > 0 && <Text dimColor>{` … ${busy} summarizing`}</Text>}
        {f !== 'all' && <Text dimColor>{` · ${hidden} hidden${pending > 0 ? ` · ${pending} unlabeled kept` : ''}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, steps)
    const f = await read($, filter)
    const used = await read($, calls)
    const shown = list.filter(s => isShown(s, f, S.neutral))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {filterChoices().map((c, i) => (
            <Button
              key={`f-${c}`}
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              onPress={() => update($, filter, () => (c === f ? 'all' : c))}
            >
              <Chip choice={c} count={countFor(list, c)} isActive={c === f} Text={Text} />
            </Button>
          ))}
        </Box>
        <Text dimColor>{`${used.answered} summaries · ${used.tried}/${S.maxCalls} calls · model ${S.model}`}</Text>
        {shown.length === 0 && <Text dimColor>No steps yet.</Text>}
        {shown.slice(-room).map(s => (
          <Button key={`s-${s.id}`} plain onPress={() => toggle($, s.id)}>
            <Text dimColor>{`#${s.n} `}</Text>
            <Mark step={s} Text={Text} />
            {` ${labelParts(s).rest}`}
          </Button>
        ))}
      </Box>
    )
  })
}

/** How many summarized steps a filter holds ('all' counts every step). */
function countFor(list: readonly Step[], choice: string) {
  if (choice === 'all') return list.length

  return list.filter(s => s.status === 'done' && isShown(s, choice, S.neutral)).length
}

const GLYPH: Record<string, string> = {
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
    choice === 'positive' || choice === 'planned' || choice === 'new'
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
