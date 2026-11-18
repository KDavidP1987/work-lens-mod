import { expect, test } from 'claude-code/testing'

import { brief, isShown, kindOf, label, parse, redact, split, valence } from '../hooks/steps'
import type { Row } from '../hooks/steps'

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
  expect(v).toEqual({ summary: 'Ran the lab CI', category: 'auditing', kind: 'planned', relates: 'D19' })
  expect(parse('no json here', CATS)).toBeNull()
  expect(parse('{"summary":"x","category":"cooking","kind":"new"}', CATS)).toBeNull()
  expect(parse('{"summary":"x","category":"code","kind":"maybe"}', CATS)).toBeNull()
})

test('● planned needs evidence; otherwise ○ and ~inferred', () => {
  const plan = '- D19 route the job board\n- D31 apply'
  const v = { summary: 's', category: 'code', kind: 'planned' as const, relates: 'D19' }
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
  /** The log lines the mod printed. */
  logs: string[]
  plan?: string
  /** True: the 4,096-row history read is refused. */
  isHistoryDown?: boolean
  /** True: every read throws. */
  isHistoryBroken?: boolean
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
  on('fs.read', () => ({ value: f.plan ?? '' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'me-session' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', (_: unknown, e: { last?: number; after?: string }) => {
    // A history read (the 4,096-row window) refused while the fake says history is down.
    if (f.isHistoryBroken === true) throw new Error('history read failed')
    if (e.last === 4096 && f.isHistoryDown === true) return { value: { deny: 'unavailable' } }
    if (e.last !== undefined) return { value: f.rows.slice(-e.last) }
    f.reads.push(e.after!)
    const at = f.rows.findIndex(r => r.uuid === e.after)
    if (at < 0) return { value: { deny: 'not an anchor' } }

    return { value: f.rows.slice(at + 1, at + 1 + 4096) }
  })
  on('model.complete', async (_: unknown, e: { prompt: string }) => {
    f.sent.push(e.prompt)
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

test('markers are colored by valence, and every count in the band is a filter that toggles', async ($, on) => {
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

  // The band: counts per valence, kind and category, each one a button.
  let ui = await $.ui.mount(BAND)
  const band = (await ui.findAll({ type: 'Button' })).map(b => b.text.trim())
  expect(band).toContain('[all 3]')
  expect(band).toContain('▲ positive 1')
  expect(band).toContain('■ neutral 1')
  expect(band).toContain('▼ negative 1')
  expect(band).toContain('✚ fix 1')
  await ui.press({ key: 'band-negative' })
  await ui.unmount()
  let out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: negative · 1 steps')
  expect(out).toContain('Fixed the import')
  expect(out).not.toContain('Built the parser')

  // Pressing the active chip again clears the filter.
  ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'band-negative' }))?.text).toContain('[')
  await ui.press({ key: 'band-negative' })
  await ui.unmount()
  out = ((await $.command.run(worklog())) as { text: string }).text
  expect(out).toContain('filter: all · 3 steps')
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
  // The old step draws as its header alone; its tool row and output draw nothing.
  let ui = await $.ui.mount(msg('h1', 'Old work one.'))
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
