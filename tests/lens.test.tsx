import { expect, test } from 'claude-code/testing'

import { brief, isShown, kindOf, label, parse, redact, split, valence } from '../hooks/steps'
import type { Row } from '../hooks/steps'
import { compilePatterns, extractRules, failures, hookLines, outwardOf, parseCommands, targetOf, units } from '../hooks/marks'
import type { Step } from '../types'

const CATS = ['notes', 'backlog & artifacts', 'code', 'auditing', 'evaluating']

const say = (uuid: string, text: string, tools: Row['toolUses'] = []): Row => ({ role: 'assistant', text, uuid, toolUses: tools })
const use = (id: string, tool = 'Bash', input: Record<string, unknown> = { command: 'npm test' }) => ({ tool_use_id: id, tool, input })
const result = (uuid: string, id: string, isError = false): Row => ({
  role: 'user',
  text: '',
  uuid,
  toolUses: [],
  toolResults: [{ tool_use_id: id, isError }],
})
const prompt = (uuid: string, text: string): Row => ({ role: 'user', text, uuid, toolUses: [] })

// ---- pure logic --------------------------------------------------------------------------------------------

test('split: text opens a step, tools join it, a prompt ends it', () => {
  const steps = split([
    say('a1', 'Running the tests.', [use('t1')]),
    result('u1', 't1', true),
    say('a2', '', [use('t2')]),
    result('u2', 't2'),
    say('a3', 'Fixing the failure.'),
    prompt('p1', 'thanks'),
    say('a4', '', [use('t3', 'Read', { file_path: '/x/y.ts' })]),
  ])
  expect(steps.map(s => s.id)).toEqual(['a1', 'a3', 'a4'])
  expect(steps[0]!.rows).toEqual(['a1', 'u1', 'a2', 'u2'])
  expect(steps[0]!.tools.map(t => t.isError === true)).toEqual([true, false])
  // A tools-first step: header site is its first tool call, no text row.
  expect(steps[2]!.textRow).toBeUndefined()
  expect(steps[2]!.toolIds).toEqual(['t3'])
})

test('split: a long step is cut into parts with distinct ids', () => {
  const rows: Row[] = [say('a0', 'Big step.')]
  for (let i = 0; i < 650; i++) rows.push(say(`r${i}`, '', [use(`t${i}`)]))
  const steps = split(rows)
  expect(steps.map(s => s.id)).toEqual(['a0', 'a0#2', 'a0#3'])
  expect(steps.map(s => s.part)).toEqual([1, 2, 3])
  expect(steps.reduce((n, s) => n + s.rows.length, 0)).toBe(651)
})

test('redact and brief keep secrets and file contents out', () => {
  expect(redact('key sk-abcdefghijklmnop1234 here')).toBe('key [redacted] here')
  expect(redact('password=hunter2 ok')).toBe('[redacted] ok')
  expect(redact('ghp_' + 'a'.repeat(36))).toBe('[redacted]')
  expect(brief('Write', { file_path: '/a/b.ts', content: 'SECRET BODY' })).toBe('Write /a/b.ts')
  // Only a path or a command is ever sent: free-text fields of any tool stay home.
  expect(brief('Agent', { description: 'customer medical record', prompt: 'x' })).toBe('Agent')
  expect(brief('WebFetch', { url: 'https://internal.example/x', prompt: 'y' })).toBe('WebFetch')
  expect(brief('Bash', { command: 'echo hi '.repeat(40) }).length).toBe('Bash '.length + 120)
  // A long unbroken run reads as a possible key and is redacted.
  expect(brief('Bash', { command: 'x'.repeat(300) })).toBe('Bash [redacted]')
})

test('parse: the JSON shape or null, never raw text', () => {
  const v = parse('Sure: {"summary":"Ran the lab CI","category":"Auditing","kind":"planned","relates":"D19"}', CATS)
  expect(v).toEqual({ summary: 'Ran the lab CI', category: 'auditing', kind: 'planned', relates: 'D19', asksNow: false })
  expect(parse('no json here', CATS)).toBeNull()
  expect(parse('{"summary":"x","category":"cooking","kind":"new"}', CATS)).toBeNull()
  expect(parse('{"summary":"x","category":"code","kind":"maybe"}', CATS)).toBeNull()
})

test('● planned needs evidence; otherwise ○ and ~inferred', () => {
  const plan = '- D19 route the job board\n- D31 apply'
  const v = { summary: 's', category: 'code', kind: 'planned' as const, relates: 'D19', asksNow: false }
  expect(kindOf(v, plan, '')).toEqual({ kind: 'planned', isRelatesVerified: true })
  expect(kindOf({ ...v, relates: 'D77' }, plan, '')).toEqual({ kind: 'unconfirmed', isRelatesVerified: false })
  expect(kindOf({ ...v, relates: 'D77' }, plan, 'Now D77 as planned.').kind).toBe('planned')
  expect(kindOf({ ...v, kind: 'fix', relates: null }, plan, '').kind).toBe('fix')
  const step = { ...split([say('a', 'x')])[0]!, status: 'done' as const, summary: 's', category: 'code', kind: 'unconfirmed' as const, relates: 'D77', isRelatesVerified: false }
  expect(label(step)).toBe('○ code · ~D77 · s')
  expect(isShown(step, 'planned')).toBe(true)
  expect(isShown(step, 'new')).toBe(false)
  expect(label({ ...step, status: 'unavailable', summary: undefined })).toBe('· summary unavailable')
})

// ---- the mod in a fake engine ------------------------------------------------------------------------------

type Fake = {
  rows: Row[]
  /** Replies of the model, in order; a function can wait before answering. */
  replies: Array<string | (() => Promise<unknown>)>
  calls: number
  maxInFlight: number
  inFlight: number
  reads: string[]
  /** The prompts the mod sent. */
  sent: string[]
  /** The system prompts the mod sent, in the same order. */
  systems: string[]
  /** The log lines the mod printed. */
  logs: string[]
  plan?: string
  /** True: the 4,096-row history read is refused. */
  isHistoryDown?: boolean
  /** True: every read throws. */
  isHistoryBroken?: boolean
  /** True: forward reads (`after`) throw; `last` reads work. */
  isAfterBroken?: boolean
  /** Files by full path, for fs.read and fs.list (other paths read as the plan). */
  files?: Record<string, string>
  /** The `hooks` settings key; `env` sits beside it to prove it is never read. */
  hooks?: unknown
  /** The settings keys the mod read. */
  settingsRead?: string[]
}

const answer = (summary: string, kind = 'new', category = 'code', relates: string | null = null) =>
  JSON.stringify({ summary, category, kind, relates })

function engine(on: any, f: Fake) {
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('ui.log', (_: unknown, e: { text: string }) => {
    f.logs.push(e.text)

    return { value: undefined }
  })
  on('clock.after', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'worklog' } }))
  on('session.root', () => ({ value: '/work/proj' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: f.plan !== undefined && /BACKLOG\.md$/.test(e.path) }))
  // The engine may hand paths over normalized (a drive letter, backslashes): matched on their ending.
  const norm = (p: string | undefined) => (p ?? '').replace(/\\/g, '/')
  const fileAt = (p: string) => Object.keys(f.files ?? {}).find(k => norm(p).endsWith(k))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const key = fileAt(e.path)

    return { value: key !== undefined ? f.files![key] : (f.plan ?? '') }
  })
  on('fs.list', (_: unknown, e: { path?: string }) => ({
    value: Object.keys(f.files ?? {})
      .filter(p => norm(e.path).endsWith(p.slice(0, p.lastIndexOf('/'))))
      .map(p => ({ name: p.slice(p.lastIndexOf('/') + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('settings.read', (_: unknown, e: { key?: string }) => {
    ;(f.settingsRead ??= []).push(e.key ?? '(all)')
    const all = { hooks: f.hooks, env: { SECRET_ENV: 'never-sent-value' } } as Record<string, unknown>

    return { value: e.key !== undefined ? all[e.key] : all }
  })
  on('prompt.context', (_: unknown, e: { blocks: unknown }) => ({ blocks: e.blocks }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'me-session' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('session.messages', (_: unknown, e: { last?: number; after?: string }) => {
    // A history read (the 4,096-row window) refused while the fake says history is down.
    if (f.isHistoryBroken === true) throw new Error('history read failed')
    if (f.isAfterBroken === true && e.after !== undefined) throw new Error('forward read failed')
    if (e.last === 4096 && f.isHistoryDown === true) return { value: { deny: 'unavailable' } }
    if (e.last !== undefined) return { value: f.rows.slice(-e.last) }
    f.reads.push(e.after!)
    const at = f.rows.findIndex(r => r.uuid === e.after)
    if (at < 0) return { value: { deny: 'not an anchor' } }

    return { value: f.rows.slice(at + 1, at + 1 + 4096) }
  })
  on('model.complete', async (_: unknown, e: { prompt: string; system?: string | { text: string }[] }) => {
    f.sent.push(e.prompt)
    f.systems.push(typeof e.system === 'string' ? e.system : (e.system ?? []).map(b => b.text).join(''))
    f.calls += 1
    f.inFlight += 1
    f.maxInFlight = Math.max(f.maxInFlight, f.inFlight)
    const next = f.replies.shift() ?? answer('default')
    try {
      const text = typeof next === 'string' ? next : await next()
      if (typeof text !== 'string') return { value: text }

      return { value: { isAnswered: true, text } }
    } finally {
      f.inFlight -= 1
    }
  })
}

const fake = (over: Partial<Fake> = {}): Fake => ({
  // Opens on a bare prompt: no earlier work, so no "earlier history" step shifts the numbering.
  rows: [prompt('a0', 'hello')],
  replies: [],
  systems: [],
  calls: 0,
  maxInFlight: 0,
  inFlight: 0,
  reads: [],
  sent: [],
  logs: [],
  ...over,
})

const START = { cwd: '/work/proj', surface: 'terminal', isInteractive: true } as any
const DONE = { reason: 'answer', turnId: 't1', answer: '', durationMs: 1000, isAborted: false } as any

/** The person types a reply: the turn's report and any question before it are replied, and fold as usual. */
const reply = ($: any, text = 'go on') => $.prompt.submit({ text })
const worklog = (args = '') =>
  ({ command: 'worklog', args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false } }) as any

declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

/** Lets the mod's background queue run to its end. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0))
}

test('a turn closes its steps; one call at a time; fix evidence and markers reach the log', { options: {} }, async ($, on) => {
  const f = fake({ plan: '- D19 route the job board' })
  engine(on, f)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Running the tests for D19.', [use('t1')]),
    result('u1', 't1', true),
    say('a2', 'Fixing the failing test.', [use('t2', 'Edit', { file_path: '/work/proj/x.ts', new_string: 'secret' })]),
    result('u2', 't2'),
  )
  f.replies.push(answer('Ran the tests', 'planned', 'auditing', 'D19'), answer('Fixed the failing test', 'fix'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(2)
  expect(f.maxInFlight).toBe(1)
  const out = (await $.command.run(worklog())) as { text: string }
  expect(out.text).toContain('#1 ● auditing · D19 · Ran the tests')
  expect(out.text).toContain('#2 ✚ code · Fixed the failing test')
  const fixes = (await $.command.run(worklog('fix'))) as { text: string }
  expect(fixes.text).toContain('filter: fix · 1 steps')
  expect(fixes.text).not.toContain('Ran the tests')
})

test('malformed replies twice → summary unavailable, both attempts counted', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'Something.'))
  f.replies.push('not json', 'still not json')
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(2)
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('#1 · summary unavailable')
})

test('the call cap stops summarizing and skips the rest', { options: { maxCalls: 1 } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'One.'), say('a2', 'Two.'), say('a3', 'Three.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(1)
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('skipped (call cap reached)')
})

test('paging: exactly 4,096 rows then nothing; no duplicates, nothing lost', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('b0', 'Long tool run.'))
  for (let i = 0; i < 4095; i++) f.rows.push(say(`r${i}`, '', [use(`t${i}`)]))
  f.replies.push(...Array.from({ length: 20 }, (_, i) => answer(`part ${i + 1}`)))
  await $.turn.complete(DONE)
  await settle()
  const text = ((await $.command.run(worklog())) as { text: string }).text
  // 4,096 rows in parts of 300 → 14 parts, all closed once.
  expect(text).toContain('· 14 steps')
  expect(f.reads.length).toBe(2)
})

test('session.end during a running call: the step and the queue are skipped, no call after', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'One.'), say('a2', 'Two.'))
  let release: (v: unknown) => void = () => undefined
  f.replies.push(() => new Promise(r => (release = r)))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(1)
  await $.session.end({ reason: 'other' } as any)
  release({ isAnswered: false, reason: 'aborted' })
  await settle()
  expect(f.calls).toBe(1)
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('#1 · skipped (session ended)')
  expect(text).toContain('#2 · skipped (session ended)')
})

const FULL = { columns: 120, rows: 40, isFullscreen: true }
const msg = (requestId: string, text: string, viewport: object = FULL) =>
  ({ plugin: 'work-lens', component: 'AssistantMessage', requestId, surface: 'terminal', viewport, props: { text, isFirstOfReply: true } }) as any
const toolRow = (requestId: string) =>
  ({
    plugin: 'work-lens',
    component: 'ToolUse',
    requestId,
    surface: 'terminal',
    viewport: FULL,
    props: { tool: 'Read', input: { file_path: '/x' }, isRunning: false, isErrored: false, isInterrupted: false },
  }) as any

test('fullscreen drawing: collapsed header, tools-only header on its ToolUse, filter hides, press expands', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>{`ORIGINAL ${e.requestId}`}</Text>
  })
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Writing the parser.', [use('t1', 'Edit', { file_path: '/p.ts' })]),
    result('u1', 't1'),
    prompt('p1', 'next'),
    say('a2', '', [use('t2', 'Read', { file_path: '/q.ts' })]),
  )
  f.replies.push(answer('Wrote the parser', 'new', 'code'), answer('Read the notes', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  await reply($)

  // Collapsed by default: the text row draws as its header alone; its tool row draws nothing.
  let ui = await $.ui.mount(msg('a1', 'Writing the parser.'))
  expect((await ui.find({ type: 'Button', text: /Wrote the parser/ }))?.text).toContain('▸ ◆ code · Wrote the parser')
  expect(await ui.find({ type: 'Text', text: /ORIGINAL a1/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount(toolRow('t1'))
  expect(await ui.find({ type: 'Text', text: /ORIGINAL/ })).toBeUndefined()
  await ui.unmount()

  // The tools-only step carries its header on its first ToolUse.
  ui = await $.ui.mount(toolRow('t2'))
  expect((await ui.find({ type: 'Button', text: /Read the notes/ }))?.text).toContain('▸ ◆ notes · Read the notes')
  await ui.unmount()

  // Pressing the header expands the step: header and the original row.
  ui = await $.ui.mount(msg('a1', 'Writing the parser.'))
  await ui.press({ key: 'wl-a1' })
  await ui.unmount()
  ui = await $.ui.mount(msg('a1', 'Writing the parser.'))
  expect((await ui.find({ type: 'Button', text: /Wrote the parser/ }))?.text).toContain('▾')
  expect(await ui.find({ type: 'Text', text: /ORIGINAL a1/ })).toBeDefined()
  await ui.unmount()

  // A filter hides the other step whole, and a row of no step is never touched.
  await $.command.run(worklog('notes'))
  ui = await $.ui.mount(msg('a1', 'Writing the parser.'))
  expect(await ui.find({ type: 'Text', text: /parser|ORIGINAL/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount(msg('zz', 'Not a step.'))
  expect(await ui.find({ type: 'Text', text: /ORIGINAL zz/ })).toBeDefined()
  await ui.unmount()
})

test('main-screen layout is never folded; a second block of the row gets no header', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>{`ORIGINAL ${e.requestId} ${e.props.text ?? ''}`}</Text>
  })
  await $.session.start(START)
  f.rows.push(say('a1', 'First block of the reply.\n\nSecond block of the reply.'))
  f.replies.push(answer('Explained it', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  await reply($)

  // Main screen: drawn as it was, no header.
  let ui = await $.ui.mount(msg('a1', 'First block of the reply.', { columns: 120, rows: 40, isFullscreen: false }))
  expect(await ui.find({ type: 'Text', text: /ORIGINAL a1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()

  // Fullscreen, collapsed: the first block is the header, the second draws nothing (no duplicate header).
  ui = await $.ui.mount(msg('a1', 'First block of the reply.'))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  await ui.unmount()
  ui = await $.ui.mount(msg('a1', 'Second block of the reply.'))
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ORIGINAL/ })).toBeUndefined()
  await ui.unmount()
})

test('the cap counts retries: a malformed answer at maxCalls 1 makes no second call', { options: { maxCalls: 1 } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'One.'))
  f.replies.push('not json', answer('never asked'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(1)
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('#1 · summary unavailable')
})

test('plan excerpts are redacted before they are sent', async ($, on) => {
  // A fake AWS-shaped key, built at run time so secret scanners don't flag this file.
  const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
  const f = fake({ plan: `- D19 route\npassword=hunter2\nkey ${fakeKey}` })
  engine(on, f)
  const sent = f.sent
  await $.session.start(START)
  f.rows.push(say('a1', 'Working on D19.'))
  await $.turn.complete(DONE)
  await settle()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('D19 route')
  expect(sent[0]).not.toContain('hunter2')
  expect(sent[0]).not.toContain(fakeKey)
})

test('a session that ends before its turn completes still lists the open step, skipped, with no call', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'Started something.'), say('a2', 'Still going.'))
  await $.session.end({ reason: 'other' } as any)
  await settle()
  expect(f.calls).toBe(0)
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('#1 · skipped (session ended)')
  expect(text).toContain('#2 · skipped (session ended)')
})

test('a long step crossing a page keeps one id: base, base#2, base#3 …, every row once', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('b0', 'Long tool run.'))
  for (let i = 0; i < 4500; i++) f.rows.push(say(`r${i}`, '', [use(`t${i}`)]))
  f.replies.push(...Array.from({ length: 20 }, () => answer('part')))
  await $.turn.complete(DONE)
  await settle()
  // 4,501 rows in parts of 300: 16 parts, numbered 1..16 in order, none restarting as a new step.
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('· 16 steps')
  expect(text).toContain('#16 (part 16)')
  expect(text).not.toMatch(/\(part 1\)/)
  for (let p = 2; p <= 16; p++) expect(text).toContain(`#${p} (part ${p})`)
})

test('session end pages through everything unscanned', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  for (let i = 0; i < 5000; i++) f.rows.push(say(`s${i}`, `Step ${i}.`))
  await $.session.end({ reason: 'other' } as any)
  await settle()
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('· 5000 steps')
  expect(text).toContain('#5000 · skipped (session ended)')
  expect(f.calls).toBe(0)
})

test('a summary that lands before anything is drawn is logged, not lost', async ($, on) => {
  const f = fake()
  engine(on, f)
  const logs = f.logs
  await $.session.start(START)
  f.rows.push(say('a1', 'Reading the backlog file now.'))
  f.replies.push(answer('Read the backlog', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  expect(logs.join('\n')).toContain('work-lens step 1 "Reading the backlog file now.…" — ◆ notes · Read the backlog')
})

test('filters never hide a step without a verdict', () => {
  const s = { ...split([say('a', 'x')])[0]!, status: 'queued' as const }
  expect(isShown(s, 'code')).toBe(true)
  expect(isShown({ ...s, status: 'skipped' }, 'fix')).toBe(true)
  expect(isShown({ ...s, status: 'done', category: 'notes', kind: 'new' }, 'code')).toBe(false)
})

test('a shared tool group carries its first shown step\'s header, and the filter never orphans a shown step', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>{`ORIGINAL ${e.requestId}`}</Text>
  })
  await $.session.start(START)
  f.rows.push(say('a1', '', [use('t1')]), result('u1', 't1'), prompt('p', 'go'), say('a2', '', [use('t2')]))
  f.replies.push(answer('First', 'new', 'code'), answer('Second', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  const call = (id: string) => ({ tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false, tool_use_id: id })
  const group = { plugin: 'work-lens', component: 'ToolGroup', requestId: 'g', surface: 'terminal', viewport: FULL, props: { calls: [call('t1'), call('t2')] } } as any
  let ui = await $.ui.mount(group)
  expect((await ui.find({ type: 'Button' }))?.text).toContain('First')
  expect(await ui.find({ type: 'Button', text: /Second/ })).toBeUndefined()
  await ui.unmount()
  // With the first step filtered out, the second (shown) step keeps its header on the group.
  await $.command.run(worklog('notes'))
  ui = await $.ui.mount(group)
  expect((await ui.find({ type: 'Button' }))?.text).toContain('Second')
  expect(await ui.find({ type: 'Button', text: /First/ })).toBeUndefined()
  await ui.unmount()
})

test('a failure straddling a part boundary still reaches the repair step as evidence', async ($, on) => {
  // Row 300 is a tool call, row 301 its failing result (so it lands in part 2), then a step that repairs it.
  const rows: Row[] = [say('a0', 'Long run.')]
  for (let i = 1; i < 300; i++) rows.push(say(`r${i}`, '', [use(`t${i}`)]))
  rows.push(result('u299', 't299', true), say('a2', 'Fixing the failed call.'))
  const steps = split(rows)
  expect(steps.map(s => s.id)).toEqual(['a0', 'a0#2', 'a2'])
  expect(steps[0]!.tools.find(t => t.id === 't299')?.isError).toBe(true)
  expect(steps[1]!.tools.some(t => t.isError)).toBe(true)

  // Through the mod: the repair step's prompt says a call failed in the step before it.
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(...rows)
  await $.turn.complete(DONE)
  await settle()
  const repair = f.sent.find(p => p.includes('Fixing the failed call.'))
  expect(repair).toContain('A tool call failed in the step before this one: yes')
})

test('a failing result whose call was in an earlier read is carried, not dropped', () => {
  const steps = split([say('c1', 'Continuing.'), result('u9', 'old-call', true)])
  expect(steps[0]!.tools).toEqual([{ id: 'old-call', brief: '(result of an earlier call)', isError: true }])
})

test('valence: fixes negative, neutral categories neutral, the rest positive; filters follow it', () => {
  const base = { ...split([say('a', 'x')])[0]!, status: 'done' as const, summary: 's' }
  const fix = { ...base, kind: 'fix' as const, category: 'code' }
  const note = { ...base, kind: 'new' as const, category: 'notes' }
  const code = { ...base, kind: 'planned' as const, category: 'code' }
  expect([fix, note, code].map(s => valence(s, ['notes']))).toEqual(['negative', 'neutral', 'positive'])
  expect(valence({ ...code, status: 'queued' }, ['notes'])).toBeUndefined()
  // Plan item 35: a step with no verdict passes every filter, valences included, so nothing unlabeled vanishes.
  expect(isShown({ ...code, status: 'queued' }, 'negative', ['notes'])).toBe(true)
  expect(isShown(fix, 'negative', ['notes'])).toBe(true)
  expect(isShown(note, 'positive', ['notes'])).toBe(false)
  expect(isShown(note, 'neutral', ['notes'])).toBe(true)
})

const BAND = {
  plugin: 'work-lens',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  viewport: FULL,
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as any

test('markers are colored by valence, and every count in the band is a filter that toggles', { options: { labelDetail: 'all' } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'beneath' }))
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Building the parser.'),
    say('a2', 'Fixing the broken import.'),
    say('a3', 'Updating the notes.'),
  )
  f.replies.push(answer('Built the parser', 'new', 'code'), answer('Fixed the import', 'fix', 'code'), answer('Updated notes', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  await reply($)

  // Header markers: green for building, red for the fix, gray for notes.
  for (const [id, text, color] of [
    ['a1', 'Building the parser.', 'success'],
    ['a2', 'Fixing the broken import.', 'error'],
    ['a3', 'Updating the notes.', 'inactive'],
  ] as const) {
    const ui = await $.ui.mount(msg(id, text))
    const marks = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color !== undefined)
    expect(marks.map(t => t.props.color)).toEqual([color])
    await ui.unmount()
  }

  // The band (every label, as before 0.5.1): counts per value, kind and category, each one a button.
  let ui = await $.ui.mount(BAND)
  const band = (await ui.findAll({ type: 'Button' })).map(b => b.text.trim())
  expect(band).toContain('[all 3]')
  expect(band).toContain('▲ positive 1')
  expect(band).toContain('■ neutral 1')
  expect(band).toContain('▼ negative 1')
  expect(band).toContain('◆ new 2')
  expect(band).toContain('✚ fix 1')
  expect(band).toContain('notes 1')
  await ui.press({ key: 'band-fix' })
  await ui.unmount()
  let out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: fix · 1 steps')
  expect(out).toContain('Fixed the import')
  expect(out).not.toContain('Built the parser')

  // Pressing the active chip again clears the filter.
  ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'band-fix' }))?.text).toContain('[')
  await ui.press({ key: 'band-fix' })
  await ui.unmount()
  out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: all · 3 steps')
  // The value words still filter when typed, though no longer offered.
  out = ((await $.command.run(worklog('negative'))) as { text: string }).text
  expect(out).toContain('filter: negative · 1 steps')
  expect(out).toContain('Fixed the import')
})

test('grouped band: one chip per group; a group opens to its labels and filters by any of them', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Pushing.', [{ tool_use_id: 't1', tool: 'Bash', input: bash('git push'), text: 'pushed' }]),
    say('a2', 'Fixing the broken import.'),
    say('a3', 'Updating the notes.'),
  )
  f.replies.push(answer('Pushed', 'new', 'code'), answer('Fixed the import', 'fix', 'code'), answer('Updated notes', 'new', 'notes'))
  await $.turn.complete(DONE)
  await settle()
  await reply($)
  let ui = await $.ui.mount(BAND)
  const top = (await ui.findAll({ type: 'Button' })).map(b => b.text.trim())
  // Needs you counts the turn's report; Review the push; Purpose and Work carry no count.
  expect(top).toEqual(['[all 3]', 'Needs you 1', 'Review 1', 'Purpose', 'Work'])
  // Opening Review: back, the group (now the filter), its labels with steps.
  await ui.press({ key: 'band-review' })
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  const opened = (await ui.findAll({ type: 'Button' })).map(b => b.text.trim())
  expect(opened).toEqual(['‹ groups', '[Review 1]', '⇪ outward 1'])
  let out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: review · 1 steps')
  expect(out).toContain('Pushed')
  // A label inside it, then back: the group chip still shows the filter in use.
  await ui.press({ key: 'band-outward' })
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  await ui.press({ key: 'band-‹' })
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text.trim())).toContain('[Review 1]')
  await ui.unmount()
  out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: outward · 1 steps')
  // With Work open, the outward filter in use keeps its chip, marked as from another group.
  ui = await $.ui.mount(BAND)
  await ui.press({ key: 'band-work' })
  await $.command.run(worklog('outward'))
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text.trim())).toContain('[⇪ outward 1] (other group)')
  await ui.unmount()
  // A whole group typed while another is open: marked too.
  await $.command.run(worklog('purpose'))
  ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text.trim())).toContain('[Purpose] (other group)')
  await ui.unmount()
  // A group typed, and the needs-you alias.
  out = ((await $.command.run(worklog('purpose'))) as { text: string }).text
  expect(out).toContain('filter: purpose · 3 steps')
  out = ((await $.command.run(worklog('needs-you'))) as { text: string }).text
  expect(out).toContain('filter: needs · 1 steps')
})

test('labelGroups "needs, work": Review and Purpose are not drawn, but still filter when typed', { options: { labelGroups: 'needs, work, bogus' } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Pushing.', [{ tool_use_id: 't1', tool: 'Bash', input: bash('git push'), text: 'pushed' }]),
    say('a2', 'Checking.', [use('t2', 'Bash', bash('npm test'))]),
    failedResult('u2', 't2', 'tests failed'),
    say('a3', 'Reporting.'),
  )
  f.replies.push(
    verdictWith({ summary: 'Pushed', assumption: 'Picked main' }),
    answer('Ran the tests', 'fix', 'code'),
    answer('Reported', 'new', 'notes'),
  )
  await $.turn.complete(DONE)
  await settle()
  expect(f.logs.some(l => l.includes('labelGroups left out') && l.includes('bogus'))).toBe(true)
  const out = ((await $.command.run(worklog())) as { text: string }).text
  // ⚠ and the categories stay; ⇪, ◇ and the kind glyphs go.
  expect(out).toContain('⚠ unresolved')
  expect(out).toContain('code · Ran the tests')
  expect(out).not.toMatch(/⇪|◇|◆|✚/)
  // And in the row header on screen.
  const head = await $.ui.mount(msg('a1', 'Pushing.'))
  expect((await head.findAll({ type: 'Text' })).map(t => t.text).join('')).not.toMatch(/⇪|◇/)
  await head.unmount()
  // The band: only Needs you and Work, the ⚠ count kept.
  const ui = await $.ui.mount(BAND)
  const band = (await ui.findAll({ type: 'Button' })).map(b => b.text.trim())
  expect(band).toEqual(['[all 3]', 'Needs you 2', 'Work'])
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('⚠ 1 unresolved')
  await ui.unmount()
  // A hidden label typed: it filters, and says so.
  const typed = ((await $.command.run(worklog('outward'))) as { text: string }).text
  expect(typed).toContain('filter: outward (hidden group) · 1 steps')
  // A whole hidden group typed: the same.
  expect(((await $.command.run(worklog('review'))) as { text: string }).text).toContain('filter: review (hidden group) · 1 steps')
  await $.command.run(worklog('outward'))
  const ui2 = await $.ui.mount(BAND)
  expect((await ui2.findAll({ type: 'Button' })).map(b => b.text.trim())).toContain('[⇪ outward 1] (hidden)')
  await ui2.unmount()
})

test('labelGroups without needs: no ⚠ or ❗ in the band, no ★ badge; the summaries still get the rules', { options: { labelGroups: 'review, purpose, work' } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'beneath' }))
  await $.session.start(START)
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  f.rows.push(say('a1', 'Checking.', [use('t1', 'Bash', bash('npm test'))]), failedResult('u1', 't1', 'tests failed'), say('a2', 'Reporting.'))
  await $.turn.complete(DONE)
  await settle()
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(text).not.toContain('unresolved')
  expect(text).not.toContain('Needs you')
  await ui.unmount()
  const head = await $.ui.mount(msg('a2', 'Reporting.'))
  expect((await head.findAll({ type: 'Text' })).map(t => t.text).join('')).not.toContain('★')
  await head.unmount()
  // Display only: the rule excerpt is still sent.
  expect(f.systems.join('\n')).toContain('Never push without approval')
})

test('labelGroups without work: the category is left out of every line', { options: { labelGroups: 'needs, review, purpose' } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: 'beneath' }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Building the parser.'), say('a2', 'Next.'))
  f.replies.push(answer('Built the parser', 'new', 'code', 'D19'), answer('Next', 'new', 'code'))
  await $.turn.complete(DONE)
  await settle()
  const out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('◆ ~D19 · Built the parser')
  expect(out).not.toContain('code')
  await reply($)
  const head = await $.ui.mount(msg('a1', 'Building the parser.'))
  const text = (await head.findAll({ type: 'Button' })).map(b => b.text).join('')
  expect(text).toContain('Built the parser')
  expect(text).not.toContain('code')
  await head.unmount()
})

test('a category named like a group is left out and logged; /clear closes the open group', { options: { categories: 'code, review, notes' } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  expect(f.logs.some(l => l.includes('categories left out') && l.includes('review'))).toBe(true)
  const none = ((await $.command.run(worklog('nope'))) as { text: string }).text
  expect(none).toContain('code')
  expect(none).not.toMatch(/\bnegative\b/)
  f.rows.push(say('a1', 'One.'), say('a2', 'Two.'))
  await $.turn.complete(DONE)
  await settle()
  let ui = await $.ui.mount(BAND)
  await ui.press({ key: 'band-work' })
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text.trim())[0]).toBe('‹ groups')
  await ui.unmount()
  await $.session.end({ reason: 'clear' } as any)
  await $.session.start(START)
  f.rows.push(say('b1', 'New.'), say('b2', 'Session.'))
  await $.turn.complete(DONE)
  await settle()
  // The group is closed: the chips start at all again (the filter itself carries over, as before 0.5.1).
  ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text.trim())[0]).toMatch(/^\[?all \d/)
  await ui.unmount()
})

test('collapsed steps fold their tool output too; ctrl+o still shows it', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: `ORIGINAL ${e.requestId}` }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Running the build.', [use('t1')]), result('u1', 't1'))
  f.replies.push(answer('Ran the build', 'new', 'code'))
  await $.turn.complete(DONE)
  await settle()
  await reply($)
  const out = (isExpanded?: boolean) =>
    ({
      plugin: 'work-lens',
      component: 'ToolResult',
      requestId: 't1',
      surface: 'terminal',
      viewport: FULL,
      props: { tool_use_id: 't1', tool: 'Bash', output: { stdout: 'x'.repeat(500) }, isErrored: false, isExpanded },
    }) as any
  let ui = await $.ui.mount(out())
  expect(await ui.find({ type: 'Text', text: /ORIGINAL t1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount(out(true))
  expect(await ui.find({ type: 'Text', text: /ORIGINAL t1/ })).toBeDefined()
  await ui.unmount()
  // Expanded by its header: the output shows.
  ui = await $.ui.mount(msg('a1', 'Running the build.'))
  await ui.press({ key: 'wl-a1' })
  await ui.unmount()
  ui = await $.ui.mount(out())
  expect(await ui.find({ type: 'Text', text: /ORIGINAL t1/ })).toBeDefined()
  await ui.unmount()
})

test('work from before the mod started folds as "earlier history", with no model call', async ($, on) => {
  const f = fake({ rows: [prompt('p0', 'start'), say('h1', 'Old work one.', [use('ht1')]), result('hu1', 'ht1'), say('h2', 'Old work two.')] })
  engine(on, f)
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: `ORIGINAL ${e.requestId}` }))
  await $.session.start(START)
  f.rows.push(say('a1', 'New work.'))
  f.replies.push(answer('Did new work', 'new', 'code'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(1)
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('#1 · skipped (earlier history)')
  expect(text).toContain('#2 · skipped (earlier history)')
  expect(text).toContain('#3 ◆ code · Did new work')
  // Under a filter, the band says why the steps without a summary are still in view.
  await $.command.run(worklog('new'))
  let ui = await $.ui.mount(BAND)
  const why = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(why).toContain('2 without a summary, kept in view (2 earlier history; /worklog summarize)')
  await ui.unmount()
  await $.command.run(worklog('all'))
  // The old step draws as its header alone; its tool row and output draw nothing.
  ui = await $.ui.mount(msg('h1', 'Old work one.'))
  expect((await ui.find({ type: 'Button' }))?.text).toContain('earlier history')
  expect(await ui.find({ type: 'Text', text: /ORIGINAL/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount(toolRow('ht1'))
  expect(await ui.find({ type: 'Text', text: /ORIGINAL/ })).toBeUndefined()
  await ui.unmount()
  // A second start (a reload) lists nothing twice.
  await $.session.start(START)
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('· 3 steps')
})

test('a compaction: the work before it is read first and folds; the rows after it are not skipped', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  on('ui.render', { plugin: '*' }, ($$: any, e: any) => $$.ui.resolve(e).Text({ children: `ORIGINAL ${e.requestId}` }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Editing the readme.', [use('t1')]), result('u1', 't1'))
  f.replies.push(answer('Edited the readme', 'new', 'notes'), answer('Kept going', 'new', 'code'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 'summary of the conversation')] } as any)
  // The compaction drops every earlier row; the conversation now starts at its summary.
  f.rows.splice(0, f.rows.length, prompt('c0', 'summary of the conversation'))
  f.rows.push(say('a2', 'Kept going after it.'))
  await $.turn.complete(DONE)
  await settle()
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('Edited the readme')
  expect(text).toContain('Kept going')
  expect(f.logs.join('\n')).not.toContain('compaction removed')
  // The pre-compaction step's diff folds under its header.
  const ui = await $.ui.mount({
    plugin: 'work-lens',
    component: 'ToolResult',
    requestId: 't1',
    surface: 'terminal',
    viewport: FULL,
    props: { tool_use_id: 't1', tool: 'Edit', output: {}, isErrored: false },
  } as any)
  expect(await ui.find({ type: 'Text', text: /ORIGINAL/ })).toBeUndefined()
  await ui.unmount()
})

test('a compaction the mod did not see: the rows after it are still listed, the notice is said once', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'Before.'))
  await $.turn.complete(DONE)
  f.rows.splice(0, f.rows.length, prompt('c0', 'summary'), say('a2', 'After one.'), prompt('p1', 'go on'))
  f.rows.push(say('a3', 'After two.'))
  await $.turn.complete(DONE)
  await $.turn.complete(DONE)
  await settle()
  const text = ((await $.command.run(worklog())) as { text: string }).text
  expect(text).toContain('· 3 steps')
  expect(f.logs.filter(l => l.includes('compaction removed')).length).toBe(1)
})

test('the notice is hidden only for the anchor a successful pre-compaction read reached', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  // A compaction that keeps the anchor, then later work and an unseen compaction: the notice is said.
  f.rows.push(say('a1', 'One.'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  f.rows.push(say('a2', 'Two.'))
  await $.turn.complete(DONE)
  f.rows.splice(0, f.rows.length, prompt('c1', 's2'), say('a3', 'Three.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.logs.filter(l => l.includes('compaction removed')).length).toBe(1)
  // A pre-compaction read that fails leaves the notice on.
  f.rows.push(say('a4', 'Four.'))
  f.isHistoryBroken = true
  await $.session.compact({ trigger: 'auto', messages: [prompt('c2', 's3')] } as any)
  f.isHistoryBroken = false
  f.rows.splice(0, f.rows.length, prompt('c3', 's4'), say('a5', 'Five.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.logs.filter(l => l.includes('compaction removed')).length).toBe(2)
})

test('a compaction that keeps only rows already listed: nothing doubles, the notice is said once', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'One.'), say('a2', 'Two.'))
  await $.turn.complete(DONE)
  // The anchor (a2) is dropped; a1 is kept behind the summary. Nothing new to read, twice.
  f.rows.splice(0, f.rows.length, prompt('c0', 'summary'), say('a1', 'One.'))
  await $.turn.complete(DONE)
  await $.turn.complete(DONE)
  await settle()
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('· 2 steps')
  expect(f.logs.filter(l => l.includes('compaction removed')).length).toBe(1)
})

const asking = (summary: string) => JSON.stringify({ summary, category: 'code', kind: 'new', relates: null, asks_now: true })
const original = ($$: any, e: any) => $$.ui.resolve(e).Text({ children: `ORIGINAL ${e.requestId}` })
const header = async ($: any, id: string, text: string) => {
  const ui = await $.ui.mount(msg(id, text))
  const out = { button: (await ui.find({ type: 'Button' }))?.text as string | undefined, isOpen: (await ui.find({ type: 'Text', text: /ORIGINAL/ })) !== undefined }
  await ui.unmount()

  return out
}

test('a question at the end of a turn: ❗ input, kept open and through every filter, decided after the reply', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Built the parser.'), say('a2', 'Should I push it to the public repo?'))
  f.replies.push(answer('Built the parser'), asking('Asked whether to push'))
  await $.turn.complete(DONE)
  await settle()
  // Only the turn's last step is asked whether it needs the person.
  expect(f.systems.map(s => s.includes('asks_now'))).toEqual([false, true])
  let h = await header($, 'a2', 'Should I push it to the public repo?')
  expect(h.button).toContain('❗ input')
  expect(h.isOpen).toBe(true)
  expect((await header($, 'a1', 'Built the parser.')).isOpen).toBe(false)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /❗ 1 waiting on you/ })).toBeDefined()
  await band.unmount()
  // A filter never hides a question waiting on the person.
  expect(((await $.command.run(worklog('negative'))) as { text: string }).text).toContain('Asked whether to push')
  await $.command.run(worklog('all'))
  await reply($)
  h = await header($, 'a2', 'Should I push it to the public repo?')
  expect(h.button).toContain('✔ decided')
  expect(h.isOpen).toBe(false)
  expect(((await $.command.run(worklog('input'))) as { text: string }).text).toContain('· 1 steps')
})

test('asks_now is asked of the turn end only; a backlog note at the end is a ★ report, never ❗', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Renamed the file.'), say('a2', 'Logged the rename question as a backlog item for later.'))
  f.replies.push(answer('Renamed the file'), answer('Logged it'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems.length).toBe(2)
  expect(f.systems[0]).not.toContain('asks_now')
  expect(f.systems[1]).toContain('asks_now')
  let h = await header($, 'a2', 'Logged the rename question as a backlog item for later.')
  expect(h.button).toContain('★ report')
  expect(h.button).not.toContain('❗')
  expect(h.isOpen).toBe(true)
  await reply($)
  h = await header($, 'a2', 'Logged the rename question as a backlog item for later.')
  expect(h.button).not.toContain('★')
  expect(h.isOpen).toBe(false)
})

test('question cards and plan approvals are found from the tools: decided once closed, no asks_now needed', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Asking which option.', [use('q1', 'AskUserQuestion', {})]),
    result('u1', 'q1'),
    say('a2', 'Here is the plan.', [use('x1', 'ExitPlanMode', {})]),
    result('u2', 'x1'),
    say('a3', 'Building it now.'),
  )
  await $.turn.complete(DONE)
  await settle()
  const out = ((await $.command.run(worklog('input'))) as { text: string }).text
  expect(out).toContain('· 2 steps')
  const h = await header($, 'a1', 'Asking which option.')
  expect(h.button).toContain('✔ decided')
  expect(h.isOpen).toBe(false)
})

test('a reply that lands while the summary is still running is never undone', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  let release = () => {}
  f.rows.push(say('a1', 'Which name do you want?'))
  f.replies.push(() => new Promise(r => (release = () => r(asking('Asked for a name')))))
  await $.turn.complete(DONE)
  // The summary call is under way when the person replies.
  for (let i = 0; i < 200 && f.calls === 0; i++) await new Promise(r => setTimeout(r, 0))
  expect(f.calls).toBe(1)
  await reply($)
  release()
  await settle()
  const h = await header($, 'a1', 'Which name do you want?')
  expect(h.button).toContain('✔ decided')
  expect(h.isOpen).toBe(false)
})

test('a turn end with no verdict stays open (? unread) until replied, even after a turn the person did not start', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Do you want the long or short form?'))
  f.replies.push('not json', 'still not json')
  await $.turn.complete(DONE)
  await settle()
  // A background notice starts a turn: not the person's reply.
  await $.prompt.submit({ text: 'task finished', isMeta: true } as any)
  f.rows.push(say('a2', 'The background task finished.'))
  f.replies.push(answer('Noted the task result'))
  await $.turn.complete(DONE)
  await settle()
  let h = await header($, 'a1', 'Do you want the long or short form?')
  expect(h.button).toContain('? unread')
  expect(h.isOpen).toBe(true)
  expect((await header($, 'a2', 'The background task finished.')).button).toContain('★ report')
  await reply($)
  expect((await header($, 'a1', 'Do you want the long or short form?')).isOpen).toBe(false)
  expect((await header($, 'a2', 'The background task finished.')).isOpen).toBe(false)
})

test('turn boundaries are per turn: a failed turn scan is marked later at its own end, a compaction never makes one', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Done with part one.'))
  await $.turn.complete(DONE)
  await reply($)
  // A second turn: a compaction mid-turn closes a3 but makes no boundary; the turn then ends at a4.
  f.rows.push(say('a2', 'Turn two: working.'), say('a3', 'Mid-turn note before a compaction.'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  f.rows.push(say('a4', 'Turn two is finished.'))
  await $.turn.complete(DONE)
  await settle()
  expect((await header($, 'a3', 'Mid-turn note before a compaction.')).button ?? '').not.toContain('★')
  expect((await header($, 'a4', 'Turn two is finished.')).button).toContain('★ report')
  expect(((await $.command.run(worklog('report'))) as { text: string }).text).toContain('· 2 steps')
})

test('a turn scan that fails still marks that turn end when a later scan reads it', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Which option do you want?'))
  // The boundary (newest row) is read; the scan's forward read then fails.
  f.isAfterBroken = true
  await $.turn.complete(DONE)
  f.isAfterBroken = false
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('· 0 steps')
  // Another turn (a notice the person did not type) closes both: a1 is still its own turn's end.
  f.rows.push(prompt('n1', 'notice'), say('a2', 'Handled the notice.'))
  await $.turn.complete(DONE)
  await settle()
  expect(((await $.command.run(worklog('report'))) as { text: string }).text).toContain('· 2 steps')
})

test('a turn whose newest row belongs to no step still marks its last text step as the report', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  // The newest row is a user row (a queued message): no step holds it.
  f.rows.push(say('a1', 'Shall I go ahead?'), prompt('q1', 'queued message'))
  await $.turn.complete(DONE)
  await settle()
  expect((await header($, 'a1', 'Shall I go ahead?')).button).toContain('★ report')
})

test('a turn whose text step closed in an earlier read: that step is still its report, asked asks_now again', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  // The turn's text step (with its trailing tool call) closes in a compaction's read, before the turn ends;
  // its first summary had no asks_now question, so it is asked again once it is known as the turn's end.
  f.rows.push(say('a1', 'Should I publish it now?'), say('b1', '', [use('t1')]), result('u1', 't1'))
  f.replies.push(answer('Asked about publishing'), asking('Asked whether to publish'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  await $.turn.complete(DONE)
  await settle()
  const h = await header($, 'a1', 'Should I publish it now?')
  expect(h.button).toContain('❗ input')
  expect(h.isOpen).toBe(true)
  expect(f.systems.filter(s => s.includes('asks_now')).length).toBe(1)
})

test('a closing read holding only a tools-only step: the last listed text step is the turn end', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  on('ui.render', { plugin: '*' }, original)
  await $.session.start(START)
  f.rows.push(say('a1', 'Do you want me to continue?'))
  // Summaries in list order: a1 at the compaction, a1 again as the turn end, then b2.
  f.replies.push(answer('Asked to continue'), asking('Asked whether to continue'), answer('Ran a check'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  // After it, the turn's last work is a tools-only step: the turn's read closes only that.
  f.rows.push(say('b2', '', [use('t2')]), result('u2', 't2'))
  await $.turn.complete(DONE)
  await settle()
  expect((await header($, 'a1', 'Do you want me to continue?')).button).toContain('❗ input')
})

test('a failed history read is retried at the next start, not given up', async ($, on) => {
  const f = fake({ rows: [prompt('p0', 'start'), say('h1', 'Old work one.')] })
  f.isHistoryDown = true
  engine(on, f)
  await $.session.start(START)
  await settle()
  expect(((await $.command.run(worklog())) as { text: string }).text).not.toContain('earlier history')
  f.isHistoryDown = false
  await $.session.start(START)
  await settle()
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('skipped (earlier history)')
})

test('split: a tool result never pushes a part past 300 rows', () => {
  // Row 300 is a tool call, so row 301 would be its result: the part must turn over before it.
  const rows: Row[] = [say('a0', 'Big step.')]
  for (let i = 1; i < 400; i++) {
    rows.push(say(`r${i}`, '', [use(`t${i}`)]))
    rows.push(result(`u${i}`, `t${i}`))
  }
  const steps = split(rows)
  expect(steps.every(s => s.rows.length <= 300)).toBe(true)
  expect(steps.reduce((n, s) => n + s.rows.length, 0)).toBe(rows.length)
})

test('an anchor lost to compaction resets without a crash, and the rows since it are read', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows = [say('z1', 'After compaction.')]
  await $.turn.complete(DONE)
  await settle()
  // 0.3.1: the rows written since the compaction are no longer skipped.
  expect(f.calls).toBe(1)
  f.rows.push(say('z2', 'New work.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.calls).toBe(2)
})

// ---- 0.5.0 markers: ⇪ outward, ⚠ unresolved, ⚑ deviation, ◇ assumption ------------------------------------

const bash = (command: string) => ({ command })
const out = (command: string, extra: RegExp[] = []) => outwardOf('Bash', bash(command), extra)

test('⇪ outward: sends off the machine, parsed from the whole command', () => {
  expect(out('git push origin main')).toBe('git push')
  expect(out('cd "/c/dev/x" && timeout 60 git push')).toBe('git push')
  expect(out('git -C /x push')).toBe('git push')
  expect(out('gh pr merge 12 --squash')).toBe('gh pr merge')
  expect(out('npm publish --access public')).toBe('npm publish')
  expect(out('npx vercel --prod')).toBe('vercel deploy')
  expect(out('python ~/.claude/handoff.py send "Subject" "body"')).toBe('handoff send')
  // A quoted URL stays an argument.
  expect(out('curl -X POST "https://api.example.com/v1/x" -d @f.json')).toBe('curl POST api.example.com')
  expect(outwardOf('Artifact', { file_path: '/x.html' })).toBe('Artifact publish')
  expect(outwardOf('mcp__supabase__deploy_edge_function', {})).toBe('supabase deploy_edge_function')
  // Not outward: text inside quotes or a comment, a dry run, local deletion, reads and drafts, localhost.
  expect(out('echo "git push"')).toBeUndefined()
  expect(out('ls # then git push')).toBeUndefined()
  expect(out('git push --dry-run')).toBeUndefined()
  expect(out('rm -rf build')).toBeUndefined()
  expect(out('git reset --hard HEAD')).toBeUndefined()
  expect(out('cat <<EOF\ngit push\nEOF')).toBeUndefined()
  expect(out('curl -X POST http://localhost:3000/x')).toBeUndefined()
  expect(out('curl https://example.com')).toBeUndefined()
  expect(out('vercel env ls')).toBeUndefined()
  expect(outwardOf('Artifact', { action: 'read', url: 'u' })).toBeUndefined()
  expect(outwardOf('mcp__vercel__get_deployment', {})).toBeUndefined()
  expect(outwardOf('mcp__x__list_projects', {})).toBeUndefined()
  expect(outwardOf('mcp__x__send_draft', {})).toBeUndefined()
  expect(outwardOf('mcp__x__publish_drafts', {})).toBeUndefined()
  expect(out('gh repo view x')).toBeUndefined()
  expect(out('gh pr list')).toBeUndefined()
  expect(out('pnpm publish --dry-run')).toBeUndefined()
  expect(out('vercel')).toBe('vercel deploy')
  expect(out('vercel logs x')).toBeUndefined()
  // Options that take a value, before the subcommand or in a wrapper.
  expect(out('gh --repo owner/repo pr create --fill')).toBe('gh pr create')
  expect(out('npm --workspace pkg publish')).toBe('npm publish')
  expect(out('vercel --scope team deploy')).toBe('vercel deploy')
  expect(out('vercel --scope team logs')).toBeUndefined()
  expect(out('env -u HOME git push')).toBe('git push')
  expect(out('timeout --signal TERM 60 git push')).toBe('git push')
  expect(out('git -c user.name=x push')).toBe('git push')
  // Custom patterns; an invalid one is left out, not thrown.
  const { patterns, bad } = compilePatterns('^rsync .*remote:, [oops')
  expect(bad).toEqual(['[oops'])
  expect(out('rsync -a dist/ remote:/srv', patterns)).toBe('rsync -a dist/ remote:/srv')
  expect(parseCommands('a "b && c" && d')).toEqual([['a', 'b && c'], ['d']])
})

test('targets tell a retry from an unrelated call', () => {
  expect(targetOf('Bash', bash('npm test 2>&1 | tail -5'))).toBe(targetOf('Bash', bash('timeout 300 npm test')))
  expect(targetOf('Bash', bash('cd /a && git push'))).not.toBe(targetOf('Bash', bash('cd /b && git push')))
  // A repository named by an option is part of the target.
  expect(targetOf('Bash', bash('git -C /a push'))).not.toBe(targetOf('Bash', bash('git -C /b push')))
  expect(targetOf('Bash', bash('git --git-dir /a push'))).not.toBe(targetOf('Bash', bash('git --git-dir /b push')))
  expect(targetOf('Bash', bash('gh --repo o/a pr create'))).not.toBe(targetOf('Bash', bash('gh --repo o/b pr create')))
  expect(targetOf('Bash', bash('git -C /a push'))).toBe(targetOf('Bash', bash('git -C /a push --force-with-lease')))
  // Attached and = forms are the same option; a different value is a different target.
  const t = (c: string) => targetOf('Bash', bash(c))
  expect(t('git -C/a push')).toBe(t('git -C /a push'))
  expect(t('git -C/a push')).not.toBe(t('git -C/b push'))
  expect(t('git --git-dir=/a push')).toBe(t('git --git-dir /a push'))
  expect(t('git --git-dir=/a push')).not.toBe(t('git --git-dir=/b push'))
  expect(t('gh --repo=o/a pr create')).toBe(t('gh -R o/a pr create'))
  expect(t('gh --repo=o/a pr create')).not.toBe(t('gh --repo=o/b pr create'))
  // Order does not matter; git's -C (folder) and -c (setting) are not the same option.
  expect(t('git -C /a -c core.x=1 push')).toBe(t('git -c core.x=1 -C /a push'))
  expect(t('git -C /a push')).not.toBe(t('git -c /a push'))
  // A credential given as an option is never kept in a target.
  expect(t('vercel deploy --token=abc123secret')).not.toContain('abc123secret')
  expect(t('vercel deploy -t abc123secret')).not.toContain('abc123secret')
  expect(targetOf('Edit', { file_path: '/x.ts', old_string: 'a' })).toBe(targetOf('Write', { file_path: '/x.ts', content: 'b' }))
  expect(targetOf('mcp__s__q', { sql: 'select 1', description: 'a' })).toBe(targetOf('mcp__s__q', { description: 'b', sql: 'select 1' }))
})

const stepOf = (id: string, tools: Step['tools'], extra: Partial<Step> = {}): Step => ({
  id, part: 1, rows: [id], toolIds: tools.map(t => t.id), text: 'x', tools, status: 'done', ...extra,
})

test('⚠ failures: resolved per failure by a seen retry, named fixes, or expected; never by an unrelated step', () => {
  const t = (id: string, target: string, more: object = {}) => ({ id, brief: `Bash ${target}`, target, ...more })
  const list = [
    stepOf('s1', [t('c1', 'cmd:|npm test', { isError: true, fail: 'f1' }), t('c2', 'cmd:/a|git push', { isError: true, fail: 'f2' })]),
    // An unrelated step and a retry still in flight resolve nothing.
    stepOf('s2', [t('c3', 'cmd:|npm test')], { kind: 'fix' }),
    stepOf('s3', [t('c4', 'cmd:/b|git push', { seen: true })]),
  ]
  expect(failures(list).map(f => [f.id, f.isOpen])).toEqual([['f1', true], ['f2', true]])
  // A seen retry of the same target resolves f1 only.
  list.push(stepOf('s4', [t('c5', 'cmd:|npm test', { seen: true })]))
  expect(failures(list).map(f => [f.id, f.isOpen, f.how])).toEqual([['f1', false, 'retry'], ['f2', true, undefined]])
  // A later step naming f2 resolves it; a carrier of the same call adds no second failure.
  list.push(stepOf('s5', [{ id: 'c2', brief: 'Bash x (result)', isError: true, fail: 'f2' }], { fixes: ['f2'] }))
  expect(failures(list).map(f => [f.id, f.isOpen])).toEqual([['f1', false], ['f2', false]])
  // expected only counts on the failure's own step.
  const own = [stepOf('e1', [t('g', 'cmd:|grep x', { isError: true, fail: 'f9' })], { expected: ['f9'] })]
  expect(failures(own)[0]!.how).toBe('expected')
  const other = [stepOf('e1', [t('g', 'cmd:|grep x', { isError: true, fail: 'f9' })]), stepOf('e2', [], { expected: ['f9'] })]
  expect(failures(other)[0]!.isOpen).toBe(true)
})

test('rule excerpt: whole units only, negations kept, priority under the budget, hooks by script name', () => {
  expect(units('# Head\n- Never push\n  without asking.\n\nA paragraph\nthat goes on.\n| a | b |\n|---|---|\n| must x | y |')).toEqual([
    'Never push without asking.', 'A paragraph that goes on.', '| a | b |', '| must x | y |',
  ])
  const long = `- Always run the tests ${'x'.repeat(200)}`
  const text = extractRules(
    [{ text: `${long}\n- This line has no rule word\n- Do not push without approval` }, { text: '- CRITICAL: decisions go to cards', isFeedback: true }],
    ['PreToolUse Bash → guard.py'],
    300,
  )
  // The feedback/CRITICAL unit and the short rule fit; the long one is dropped whole, never cut.
  expect(text).toContain('- Do not push without approval')
  expect(text).toContain('- CRITICAL: decisions go to cards')
  expect(text).not.toContain('Always run the tests')
  expect(text).not.toContain('no rule word')
  expect(text).toContain('- PreToolUse Bash → guard.py')
  expect(hookLines({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python "C:/Users/me/secret dir/guard.py" --token abc' }] }] })).toEqual([
    'PreToolUse Bash → guard.py',
  ])
  expect(hookLines(undefined)).toEqual([])
  // The budget holds for hooks too: lines that do not fit are left out.
  const many = Array.from({ length: 20 }, (_, i) => `PreToolUse ${'m'.repeat(50)}${i} → ${'s'.repeat(55)}.py`)
  expect(extractRules([{ text: '- Never do x without y.' }], many, 600).length).toBeLessThanOrEqual(600)
})

const RULES = "Excerpt of the person's standing rules:\n- Push only after the owner approves it in this conversation."
const check = (over: object = {}) => ({
  openIds: ['f1'], ownIds: ['f2'], calls: [{ id: 'tu1', brief: 'Bash git push' }], text: 'Pushing it now, no need to wait.', rules: RULES, ...over,
})
const verdictWith = (extra: object) => JSON.stringify({ summary: 's', category: 'code', kind: 'new', relates: null, ...extra })

test('parse: judgments only when asked, ids only as sent, a deviation only when grounded', () => {
  const rule = 'Push only after the owner approves it'
  const v = parse(verdictWith({ fixes: ['f1', 'f7'], expected: ['f2', 'f1'], deviation: { rule, how: 'pushed unasked', action: { call: 'c1' } }, assumption: 'chose main' }), CATS, check())
  expect(v?.fixes).toEqual(['f1'])
  expect(v?.expected).toEqual(['f2'])
  expect(v?.deviation).toEqual({ rule, how: 'pushed unasked', toolId: 'tu1' })
  expect(v?.assumption).toBe('chose main')
  const dev = (d: object) => parse(verdictWith({ deviation: d }), CATS, check())?.deviation
  expect(dev({ rule, how: 'h', action: { call: 'c9' } })).toBeUndefined()
  // Word for word: a changed case is not a quote, while a line break read as a space still is.
  expect(dev({ rule: 'push only after kris approves it', how: 'h', action: { call: 'c1' } })).toBeUndefined()
  expect(dev({ rule: 'Push only after\nthe owner approves it', how: 'h', action: { call: 'c1' } })?.toolId).toBe('tu1')
  expect(dev({ rule: 'Always deploy on Fridays please', how: 'h', action: { call: 'c1' } })).toBeUndefined()
  expect(dev({ rule, how: 'h', action: { quote: 'no need to wait' } })?.quote).toBe('no need to wait')
  expect(dev({ rule, how: 'h', action: { quote: 'wait' } })).toBeUndefined()
  expect(dev({ rule, how: 'h', action: { quote: 'a sentence the step never said' } })).toBeUndefined()
  expect(dev({ rule, how: 'h' })).toBeUndefined()
  // judgeRules off: no excerpt, so neither is kept even if the model offers them.
  const off = parse(verdictWith({ deviation: { rule, how: 'h', action: { call: 'c1' } }, assumption: 'a' }), CATS, check({ rules: undefined }))
  expect(off?.deviation).toBeUndefined()
  expect(off?.assumption).toBeUndefined()
})

test('split keeps the latest typed message, skips tagged notices, and sees results', () => {
  const steps = split([
    prompt('p1', 'Push it once the tests pass.'),
    say('a1', 'Running.', [use('t1')]),
    { role: 'user', text: '', uuid: 'u1', toolUses: [], toolResults: [{ tool_use_id: 't1', isError: false, text: 'ok' }] },
    prompt('p2', '<task-notification>done</task-notification>'),
    say('a2', 'Pushing.', [{ tool_use_id: 't2', tool: 'Bash', input: bash('git push'), text: 'pushed' }]),
    prompt('p3', '/worklog outward'),
    say('a3', 'Again.', [use('t3', 'Bash', bash('git push'))]),
    { role: 'user', text: '', uuid: 'u3', toolUses: [], toolResults: [{ tool_use_id: 't3', isError: false }] },
  ])
  // Tagged notices and slash commands are not the person's message.
  expect(steps.map(s => s.latest)).toEqual(['Push it once the tests pass.', 'Push it once the tests pass.', 'Push it once the tests pass.'])
  expect(steps[0]!.tools[0]!.seen).toBe(true)
  expect(steps[1]!.tools[0]).toMatchObject({ out: 'git push', seen: true })
  // A result with no text is no proof the call ran.
  expect(steps[2]!.tools[0]!.seen).toBeUndefined()
})

test('a result read after its call was listed marks that call: its ⇪ is sent', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  // The push's step closes (a later text row exists) before its result is written.
  f.rows.push(say('a1', 'Pushing.', [use('t1', 'Bash', bash('git push'))]), say('a2', 'Waiting for it.'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  expect(((await $.command.run(worklog())) as { text: string }).text).toContain('⇪? git push (result not seen)')
  f.rows.push(okResult('u1', 't1'), say('a3', 'Pushed.'))
  await $.turn.complete(DONE)
  await settle()
  const o = (await $.command.run(worklog('outward'))) as { text: string }
  expect(o.text).toContain('⇪ git push')
  expect(o.text).not.toContain('⇪?')
})

test('a failure read after its call was listed is that call\'s step\'s ⚠, not the later step\'s', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Pushing.', [use('t1', 'Bash', bash('git push'))]), say('a2', 'Waiting for it.'))
  f.replies.push(answer('Pushed'), answer('Waited'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  f.rows.push(failedResult('u1', 't1', 'rejected: non-fast-forward'), say('a3', 'Looking at the rejection.'))
  // The owner is asked again (it now holds f1) and says nothing about it: the failure stays open.
  f.replies.push(answer('Looked at it'), answer('Pushed'))
  await $.turn.complete(DONE)
  await settle()
  const u = (await $.command.run(worklog('unresolved'))) as { text: string }
  expect(u.text).toContain('filter: unresolved · 1 steps')
  expect(u.text).toContain('#1 ')
  expect(u.text).not.toContain('#3 ')
  // Only the owner was asked whether the failure was its own expected one.
  const asked = f.sent.slice(2).filter(p => p.includes("This step's own failures"))
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('git push')
  expect(asked[0]).not.toContain('Looking at the rejection')
  // A failed push is not ⇪.
  expect(((await $.command.run(worklog('outward'))) as { text: string }).text).toContain('filter: outward · 0 steps')
})

test('a late failure its own step calls expected is resolved once that step is asked again', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Checking for leftovers.', [use('t1', 'Bash', bash('grep -r TODO src'))]), say('a2', 'Next.'))
  f.replies.push(answer('Checked'), answer('Next'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  f.rows.push(failedResult('u1', 't1', 'exit code 1'), say('a3', 'None found.'))
  const expected = verdictWith({ expected: ['f1'] })
  f.replies.push(expected, expected)
  await $.turn.complete(DONE)
  await settle()
  expect(((await $.command.run(worklog('unresolved'))) as { text: string }).text).toContain('filter: unresolved · 0 steps')
})

test('a failure that lands while its step is being summarized: that step is asked again', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  f.rows.push(say('a1', 'Checking for leftovers.', [use('t1', 'Bash', bash('grep -r TODO src'))]), say('a2', 'Next.'))
  let release: (v: unknown) => void = () => undefined
  f.replies.push(() => new Promise(r => (release = r)))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  expect(f.calls).toBe(1)
  // While #1's call runs, its failure is read.
  f.rows.push(failedResult('u1', 't1', 'exit code 1'), say('a3', 'None found.'))
  await $.turn.complete(DONE)
  await settle()
  const expected = verdictWith({ expected: ['f1'] })
  // The re-queued #1 is the oldest queued step: asked first.
  f.replies.push(expected, answer('Next'), answer('None found'))
  release({ isAnswered: true, text: answer('Checked') })
  await settle()
  const again = f.sent.slice(1).filter(p => p.includes("This step's own failures"))
  expect(again.length).toBe(1)
  expect(again[0]).toContain('grep -r TODO')
  expect(((await $.command.run(worklog('unresolved'))) as { text: string }).text).toContain('filter: unresolved · 0 steps')
})

const failedResult = (uuid: string, id: string, text: string): Row => ({
  role: 'user', text: '', uuid, toolUses: [], toolResults: [{ tool_use_id: id, isError: true, text }],
})
const okResult = (uuid: string, id: string): Row => ({
  role: 'user', text: '', uuid, toolUses: [], toolResults: [{ tool_use_id: id, isError: false, text: 'ok' }],
})

test('⚠ through the mod: an open failure is listed, counted, filtered, sent with its error, and resolved by a named fix', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Running the tests.', [use('t1')]),
    failedResult('u1', 't1', 'FAIL x.test.ts: expected 2, got 3'),
    say('a2', 'Updating the docs.', [use('t2', 'Edit', { file_path: '/d.md' })]),
    okResult('u2', 't2'),
  )
  f.replies.push(answer('Ran the tests'), answer('Updated the docs'))
  await $.turn.complete(DONE)
  await settle()
  // The next step was sent the open failure with its error, and named no fix: it stays open.
  expect(f.sent[1]).toContain('Open failures before this step:\n- f1: Bash npm test — error: FAIL x.test.ts: expected 2, got 3')
  expect(f.systems[0]).toContain('"expected"')
  const u = (await $.command.run(worklog('unresolved'))) as { text: string }
  expect(u.text).toContain('filter: unresolved · 1 steps')
  expect(u.text).toContain('⚠ unresolved: f1 Bash npm test')
  // A later step that names f1 resolves it.
  f.rows.push(say('a3', 'Fixing the failing assertion.', [use('t3', 'Edit', { file_path: '/x.ts' })]), okResult('u3', 't3'))
  f.replies.push(verdictWith({ kind: 'fix', fixes: ['f1'] }))
  await $.turn.complete(DONE)
  await settle()
  const after = (await $.command.run(worklog('unresolved'))) as { text: string }
  expect(after.text).toContain('filter: unresolved · 0 steps')
})

test('sendFailureText off: the failure is named without its error text', { options: { sendFailureText: false } }, async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(say('a1', 'Running.', [use('t1')]), failedResult('u1', 't1', 'token leak here'), say('a2', 'Next.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.sent.join('\n')).toContain('- f1: Bash npm test')
  expect(f.sent.join('\n')).not.toContain('token leak here')
})

test('⇪ through the mod: a push with a result is outward; a failed push is ⚠, not ⇪', async ($, on) => {
  const f = fake()
  engine(on, f)
  await $.session.start(START)
  f.rows.push(
    say('a1', 'Pushing.', [use('t1', 'Bash', bash('git push'))]),
    okResult('u1', 't1'),
    say('a2', 'Pushing the other repo.', [use('t2', 'Bash', bash('cd /b && git push'))]),
    failedResult('u2', 't2', 'rejected'),
    say('a3', 'Done.'),
  )
  await $.turn.complete(DONE)
  await settle()
  const o = (await $.command.run(worklog('outward'))) as { text: string }
  expect(o.text).toContain('filter: outward · 1 steps')
  expect(o.text).toContain('⇪ git push')
  const u = (await $.command.run(worklog('unresolved'))) as { text: string }
  expect(u.text).toContain('Bash cd /b && git push')
})

const MEM = '/home/u/.claude/projects/p/memory'
const instr = [
  { path: '/home/u/.claude/CLAUDE.md', kind: 'user', content: '# Rules\n- Never push without approval from the owner.\n- Notes are kept in Obsidian.' },
  { path: `${MEM}/MEMORY.md`, kind: 'memory', content: '- [x](x.md) — an index line' },
]

test('⚑ rules: CLAUDE.md, feedback memories and hook names are sent (never env); a grounded deviation shows', async ($, on) => {
  const f = fake({
    files: {
      [`${MEM}/feedback-edits.md`]: '---\ntype: feedback\n---\nEdits via Write/Edit only, never sed.',
      [`${MEM}/project-x.md`]: '---\ntype: project\n---\nYou must never see this project line.',
    },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python /h/guard.py' }] }] },
  })
  engine(on, f)
  await $.session.start(START)
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  f.rows.push(prompt('p1', 'Looks good, thanks.'), say('a1', 'Pushing now.', [use('t1', 'Bash', bash('git push'))]), okResult('u1', 't1'))
  f.replies.push(verdictWith({ deviation: { rule: 'Never push without approval from the owner.', how: 'pushed without an OK', action: { call: 'c1' } } }))
  await $.turn.complete(DONE)
  await settle()
  const sys = f.systems[0]!
  expect(sys).toContain('- Never push without approval from the owner.')
  expect(sys).toContain('Edits via Write/Edit only, never sed.')
  expect(sys).toContain('PreToolUse Bash → guard.py')
  expect(sys).not.toContain('must never see this project line')
  expect(sys).not.toContain('never-sent-value')
  expect(sys).toContain('NOT a deviation: a procedure whose trigger did not occur')
  // One read, of the hooks key: the engine reads the settings object and hands the mod only that key's value.
  expect(f.settingsRead).toEqual(['(all)'])
  expect(f.sent[0]).toContain('The person\'s latest message: "Looks good, thanks."')
  const d = (await $.command.run(worklog('deviation'))) as { text: string }
  expect(d.text).toContain('⚑ "Never push without approval from the owner.": pushed without an OK')
})

test('rules follow the context: files dropped from it, or a /clear, are not sent again', async ($, on) => {
  const f = fake()
  engine(on, f)
  on('session.compact', (_: unknown, e: any) => ({ messages: e.messages }))
  await $.session.start(START)
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  f.rows.push(say('a1', 'One.'), say('a2', 'Two.'))
  await $.session.compact({ trigger: 'auto', messages: [prompt('c0', 's')] } as any)
  await settle()
  expect(f.systems[0]).toContain('Never push without approval')
  // Another hook rewrote the instruction files: none of the old ones are used.
  await $.prompt.context({ blocks: [] } as any)
  const rewritten = f.systems.length
  f.rows.push(say('a3', 'Three.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems.length).toBeGreaterThan(rewritten)
  expect(f.systems.slice(rewritten).join('\n')).not.toContain('Never push without approval')
  // The same index file, no longer of the memory kind: its folder's feedback memories are not read any more.
  f.files = { [`${MEM}/feedback-edits.md`]: 'Edits via Write/Edit only, never sed.' }
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  const asMemory = f.systems.length
  f.rows.push(say('a4', 'Four.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems.slice(asMemory).join('\n')).toContain('never sed')
  await $.prompt.context({ blocks: [], instructionFiles: instr.map(i => ({ ...i, kind: 'project' })) } as any)
  const asProject = f.systems.length
  f.rows.push(say('a5', 'Five.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems.length).toBeGreaterThan(asProject)
  expect(f.systems.slice(asProject).join('\n')).not.toContain('never sed')
  // After /clear, nothing of the old session's context remains.
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  await $.session.end({ reason: 'clear' } as any)
  await $.session.start(START)
  const before = f.systems.length
  f.rows.push(say('b1', 'New session.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems.length).toBeGreaterThan(before)
  expect(f.systems.slice(before).join('\n')).not.toContain('Never push without approval')
})

test('judgeRules off: no rules, no latest message, no ⚑/◇ asked', { options: { judgeRules: false } }, async ($, on) => {
  const f = fake({ hooks: { Stop: [{ hooks: [{ command: 'node x.mjs' }] }] } })
  engine(on, f)
  await $.session.start(START)
  await $.prompt.context({ blocks: [], instructionFiles: instr } as any)
  f.rows.push(prompt('p1', 'private words'), say('a1', 'Working.'))
  await $.turn.complete(DONE)
  await settle()
  expect(f.systems[0]).not.toContain('Never push')
  expect(f.systems[0]).not.toContain('deviation')
  expect(f.sent[0]).not.toContain('private words')
  expect(f.settingsRead ?? []).toEqual([])
})
