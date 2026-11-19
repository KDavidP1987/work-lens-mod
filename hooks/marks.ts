// Pure logic of the 0.5.0 markers: ⇪ outward, ⚠ unresolved failures, and the rule excerpt for ⚑ deviation.
// No `$` and no imports from steps.ts, so steps.ts can use it and the tests call it directly.

import type { Step, StepTool } from '../types'

// ---- a shell command line, parsed ---------------------------------------------------------------------------

/**
 * Splits a shell command line into its simple commands, each a list of words, the way a shell groups them:
 * quotes group and are decoded (a quoted URL stays one argument), text inside quotes never starts a command,
 * `#` comments and heredoc bodies are dropped, and `&&`, `||`, `;`, `|`, `&`, parentheses and newlines outside
 * quotes end a command. Not a full shell: enough to tell which programs a command line runs.
 */
export function parseCommands(src: string): string[][] {
  const cmds: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let heredoc: string | null = null
  // A redirection's target (`> out.txt`) is not a word of the command.
  let isTarget = false
  const endWord = () => {
    if (hasWord) {
      if (isTarget) isTarget = false
      else words.push(word)
    }
    word = ''
    hasWord = false
  }
  const endCmd = () => {
    endWord()
    if (words.length > 0) cmds.push(words)
    words = []
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        word += src[i + 1]
        hasWord = true
      }
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      word += src.slice(i + 1, end)
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          word += src[j + 1]
          j += 2
          continue
        }
        word += src[j]
        j++
      }
      hasWord = true
      i = j + 1
      continue
    }
    if (c === '#' && !hasWord) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '\n') {
      endCmd()
      if (heredoc !== null) {
        // Skip the body up to the line holding only the delimiter; stop on that line's newline.
        let k = i + 1
        for (;;) {
          const e = src.indexOf('\n', k)
          const line = src.slice(k, e < 0 ? src.length : e)
          if (line.trim() === heredoc || e < 0) {
            i = e < 0 ? src.length : e
            break
          }
          k = e + 1
        }
        heredoc = null
        continue
      }
      i++
      continue
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord()
      let j = i + 2
      if (src[j] === '-') j++
      while (src[j] === ' ') j++
      let delim = ''
      const q = src[j]
      if (q === "'" || q === '"') {
        const k = src.indexOf(q, j + 1)
        delim = src.slice(j + 1, k < 0 ? src.length : k)
        j = k < 0 ? src.length : k + 1
      } else {
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) delim += src[j++]
      }
      heredoc = delim === '' ? null : delim
      i = j
      continue
    }
    // Redirections: `2>&1`, `>> log`, `< in`, `&> all` (a leading fd number belongs to the operator).
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else {
        endWord()
      }
      i += c === '&' ? 2 : 1
      if (src[i] === '>') i++
      if (src[i] === '&') {
        i++
        while (i < src.length && /[0-9-]/.test(src[i]!)) i++
        continue
      }
      isTarget = true
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCmd()
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    word += c
    hasWord = true
    i++
  }
  endCmd()

  return cmds
}

const WRAPPERS = new Set(['timeout', 'env', 'sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'npx', 'call'])

/** A program's name: its path's last part, lower case, without `.exe` / `.cmd`. */
const progName = (w: string) => (w.split(/[\\/]/).pop() ?? w).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')

/** Options that take the next word as their value, per program (lower case): skipped with it. */
const VALUED: Record<string, readonly string[]> = {
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  env: ['-u', '--unset', '-c', '--chdir', '-s', '--split-string'],
  sudo: ['-u', '--user', '-g', '--group'],
  nice: ['-n', '--adjustment'],
  npx: ['-p', '--package', '-c', '--call'],
  git: ['-c', '--git-dir', '--work-tree', '--namespace'],
  gh: ['-r', '--repo', '--hostname'],
  npm: ['-w', '--workspace', '--prefix', '--registry', '--userconfig'],
  pnpm: ['-c', '--dir', '-f', '--filter', '--registry'],
  yarn: ['--cwd', '--registry'],
  vercel: ['-s', '--scope', '-t', '--token', '--cwd', '-a', '--local-config', '-t', '--team', '-m', '--meta', '-e', '--env', '-b', '--build-env'],
}

/** The words of a command with leading `VAR=value` words and wrappers (`timeout 60`, `env X=1`, `npx -y`) dropped. */
export function coreWords(words: readonly string[]): [string, ...string[]] {
  let i = 0
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
    if (i >= words.length || !WRAPPERS.has(progName(words[i]!))) break
    const wrapper = progName(words[i]!)
    const valued = VALUED[wrapper] ?? []
    i++
    while (i < words.length) {
      const w = words[i]!.toLowerCase()
      if (valued.includes(w)) i += 2
      else if (w.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
      else break
    }
    if (wrapper === 'timeout' && i < words.length && /^\d/.test(words[i]!)) i++
  }

  return [progName(words[i] ?? ''), ...words.slice(i + 1)]
}

/** The arguments that are not options; an option that takes a value (per program) takes it with it. */
function operands(args: readonly string[], valued: readonly string[] = []) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (valued.includes(a)) {
      i++
      continue
    }
    if (!a.startsWith('-')) out.push(a)
  }

  return out
}

const isLocalHost = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)

/** What one parsed command sends off the machine, if it does: `git push`, `npm publish`, `curl POST host`… */
export function outwardOfCommand(words: readonly string[], extra: readonly RegExp[] = []): string | undefined {
  const [prog, ...args] = coreWords(words)
  const lower = args.map(a => a.toLowerCase())
  // git's -C dir lowers to -c, which VALUED.git already holds.
  const ops = operands(lower, VALUED[prog] ?? [])
  const isDry = lower.includes('--dry-run')
  if (prog === 'git' && ops[0] === 'push' && !isDry && !lower.includes('-n')) return 'git push'
  if (prog === 'gh') {
    const [a, b] = ops
    if ((a === 'repo' && (b === 'create' || b === 'delete')) || (a === 'release' && b === 'create') || (a === 'pr' && (b === 'create' || b === 'merge')))
      return `gh ${a} ${b}`
  }
  if ((prog === 'npm' || prog === 'pnpm' || prog === 'yarn') && ops[0] === 'publish' && !isDry) return `${prog} publish`
  if (prog === 'vercel' && (lower.includes('--prod') || ops[0] === undefined || ops[0] === 'deploy')) return 'vercel deploy'
  if (/^python[0-9.]*$|^py$/.test(prog)) {
    const at = lower.findIndex(a => progName(a) === 'handoff.py')
    if (at >= 0 && operands(lower.slice(at + 1))[0] === 'send') return 'handoff send'
  }
  if (prog === 'curl') {
    const url = args.find(a => /^https?:\/\//i.test(a))
    let method = ''
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-X' || args[i] === '--request') method = (args[i + 1] ?? '').toUpperCase()
      else if (/^-X[A-Za-z]+$/.test(args[i]!)) method = args[i]!.slice(2).toUpperCase()
    }
    const hasData = lower.some(a => /^(-d|--data.*|-f|--form.*|--json|--upload-file|-t)$/.test(a))
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || hasData
    if (url !== undefined && isWrite && !isLocalHost(url)) {
      const host = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]

      return `curl ${method || 'POST'} ${host}`
    }
  }
  const line = [prog, ...args].join(' ')
  if (extra.some(re => re.test(line))) return line.slice(0, 60)

  return undefined
}

const MCP_VERBS = ['deploy', 'publish', 'send', 'merge', 'apply_migration', 'create_deployment', 'create_project']
const MCP_NOT = ['draft', 'preview', 'list', 'get', 'estimate', 'quote']

/** What a tool call sends off the machine, if it does, from its name and input (no model call). */
export function outwardOf(tool: string, input: Record<string, unknown>, extra: readonly RegExp[] = []): string | undefined {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''
    for (const words of parseCommands(command)) {
      const out = outwardOfCommand(words, extra)
      if (out !== undefined) return out
    }

    return undefined
  }
  if (tool === 'Artifact') return input.action === undefined || input.action === 'publish' ? 'Artifact publish' : undefined
  if (tool === 'SendMessage' || tool === 'PushNotification') return tool
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    const name = (parts.at(-1) ?? '').toLowerCase()
    // Excluded when any segment contains an excluded word (a missed ⇪ is safer than a false one).
    const segments = name.split('_')
    if (segments.some(s => MCP_NOT.some(n => s.includes(n)))) return undefined
    if (MCP_VERBS.some(v => name === v || name.startsWith(`${v}_`))) return `${parts[1] ?? 'mcp'} ${name}`
  }

  return undefined
}

/** Compiles the `outwardPatterns` setting; an invalid pattern is left out and named in `bad`. */
export function compilePatterns(setting: string): { patterns: RegExp[]; bad: string[] } {
  const patterns: RegExp[] = []
  const bad: string[] = []
  for (const p of setting.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      patterns.push(new RegExp(p, 'i'))
    } catch {
      bad.push(p)
    }
  }

  return { patterns, bad }
}

// ---- what a call acted on, to tell a retry of it --------------------------------------------------------------

const NOISE = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'echo', 'sleep', 'true', 'printf'])
const VOLATILE = new Set(['description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'])

const hash = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0

  return (h >>> 0).toString(36)
}

/**
 * What a call acted on: for a shell command, the directory it changed to and its first real program with its
 * subcommand and first operand (`npm test`, `git push origin`); for a file tool, the file; otherwise the tool and
 * a hash of its input without volatile keys. A later call with the same target that succeeds is a retry that
 * worked. Kept in the mod's state only, never sent.
 */
/** Short options spelled out, per program, so `-R x` and `--repo x` key alike. */
const LONG: Record<string, Record<string, string>> = {
  gh: { '-r': '--repo' },
  npm: { '-w': '--workspace' },
  pnpm: { '-c': '--dir', '-f': '--filter' },
  vercel: { '-s': '--scope', '-t': '--token', '-a': '--local-config', '-m': '--meta', '-e': '--env', '-b': '--build-env' },
}

/**
 * The value-taking options of a command, in every form (`-C /a`, `-C/a`, `--repo x`, `--repo=x`), as
 * [long name, value] pairs. git's `-C` (folder) and `-c` (setting) differ only by case: kept apart here.
 */
function optionValues(prog: string, args: readonly string[]): [string, string][] {
  const valued = VALUED[prog] ?? []
  const name = (opt: string) => {
    if (prog === 'git' && opt === '-C') return '-C'
    const l = opt.toLowerCase()

    return LONG[prog]?.[l] ?? l
  }
  const out: [string, string][] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const l = a.toLowerCase()
    if (valued.includes(l)) {
      if (i + 1 < args.length) out.push([name(a), args[i + 1]!])
      i++
      continue
    }
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 2 && valued.includes(l.slice(0, eq))) {
      out.push([name(a.slice(0, eq)), a.slice(eq + 1)])
      continue
    }
    // An attached short form: `-C/a`.
    if (/^-[A-Za-z]./.test(a) && !a.startsWith('--') && valued.includes(l.slice(0, 2))) out.push([name(a.slice(0, 2)), a.slice(2)])
  }

  return out
}

export function targetOf(tool: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.notebook_path
  if (typeof path === 'string') return `file:${path}`
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    let dir = ''
    for (const words of parseCommands(input.command)) {
      const [prog, ...args] = coreWords(words)
      if (prog === 'cd' || prog === 'pushd') {
        dir = args[0] ?? ''
        continue
      }
      if (NOISE.has(prog) || prog === '') continue
      const lower = args.map(a => a.toLowerCase())
      const valued = VALUED[prog] ?? []
      const ops = operands(lower, valued)
      // Option values that pick the repository, folder or project (`git -C /a`, `--repo`, `--scope`) are part of
      // what the call acted on, so two repositories never share a target. Keyed and sorted, so the order and form
      // (`-C /a`, `-C/a`, `--repo=x`, `-R x`) do not matter; credentials are never kept.
      const where = optionValues(prog, args)
        .filter(([k]) => !/token|password|secret|auth/.test(k))
        .map(([k, v]) => `${k}=${v}`)
        .sort()

      return `cmd:${dir}|${[prog, ...ops.slice(0, 2)].join(' ')}${where.length > 0 ? ` @${where.join(' ')}` : ''}`
    }

    return `cmd:${dir}|`
  }
  const kept = Object.keys(input)
    .filter(k => !VOLATILE.has(k))
    .sort()
    .map(k => [k, input[k]])

  return `${tool}#${hash(JSON.stringify(kept))}`
}

// ---- failures and whether they were resolved ------------------------------------------------------------------

/** A failed call's own entry, not the carrier of an earlier call's result. */
export const isCarrier = (t: StepTool) => t.brief.startsWith('(') || t.brief.endsWith(' (result)')

export type Failure = {
  id: string
  toolId: string
  stepId: string
  brief: string
  error?: string
  target?: string
  isOpen: boolean
  /** How it was resolved: a retry of the same target succeeded, a later step fixed it, or it was expected. */
  how?: 'retry' | 'fixed' | 'expected'
}

/**
 * Every failure of the listed steps in order, each once (by its id), and whether it is still open. A failure is
 * resolved by a later call to the same target that succeeded (a result observed, no error), by a later step whose
 * summary names it in `fixes`, or by its own step's summary naming it in `expected`.
 */
export function failures(list: readonly Step[]): Failure[] {
  const targets = new Map<string, string>()
  for (const s of list) for (const t of s.tools) if (t.target !== undefined) targets.set(t.id, t.target)
  const out: Failure[] = []
  const byId = new Map<string, Failure>()
  for (const s of list) {
    for (const id of s.fixes ?? []) {
      const f = byId.get(id)
      if (f?.isOpen) Object.assign(f, { isOpen: false, how: 'fixed' })
    }
    for (const t of s.tools) {
      if (t.seen === true && t.isError !== true && t.target !== undefined) {
        for (const f of out) if (f.isOpen && f.target === t.target) Object.assign(f, { isOpen: false, how: 'retry' })
      }
      if (t.fail === undefined || byId.has(t.fail)) continue
      const f: Failure = {
        id: t.fail,
        toolId: t.id,
        stepId: s.id,
        brief: t.brief.replace(/ \(result\)$/, ''),
        isOpen: true,
      }
      if (t.error !== undefined) f.error = t.error
      const target = t.target ?? targets.get(t.id)
      if (target !== undefined) f.target = target
      out.push(f)
      byId.set(t.fail, f)
    }
    for (const id of s.expected ?? []) {
      const f = byId.get(id)
      if (f?.isOpen && f.stepId === s.id) Object.assign(f, { isOpen: false, how: 'expected' })
    }
  }

  return out
}

/** What a step sent off the machine: observed (a result seen, no error) and not yet seen. */
export function outwardOfStep(step: Step): { sent: string[]; unseen: string[] } {
  const sent = new Set<string>()
  const unseen = new Set<string>()
  for (const t of step.tools) {
    if (t.out === undefined || t.isError === true || isCarrier(t)) continue
    if (t.seen === true) sent.add(t.out)
    else unseen.add(t.out)
  }

  return { sent: [...sent], unseen: [...unseen].filter(o => !sent.has(o)) }
}

// ---- the rule excerpt -------------------------------------------------------------------------------------------

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()
const RULE_WORD = /\b(never|always|must|only|don['’]t|do not|required|requires|critical|mandatory)\b|\bbefore\b[^.\n]{0,80}\b(ask|approv|confirm|ok\b)/i
const isBullet = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l)

/**
 * Splits a markdown file into units: a whole bullet item with its continuation lines, a whole paragraph, or one
 * table row. Headings, rules, fences and blank lines end a unit and are not one.
 */
export function units(text: string): string[] {
  const out: string[] = []
  let cur: string[] | null = null
  const flush = () => {
    if (cur !== null && cur.length > 0) out.push(squash(cur.join(' ')))
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line) || /^\s*(```|---\s*$|\*\*\*\s*$)/.test(line)) {
      flush()
      continue
    }
    if (/^\s*\|/.test(line)) {
      flush()
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) out.push(squash(line))
      continue
    }
    if (isBullet(line)) {
      flush()
      cur = [line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')]
      continue
    }
    if (cur === null) cur = []
    ;(cur as string[]).push(line.trim())
  }
  flush()

  return out
}

export type RuleSource = { text: string; isFeedback?: boolean }

export const RULES_MAX = 6000
const HOOK_LINES_MAX = 20

/**
 * The rule excerpt sent for ⚑ deviation: each unit of the sources that states a rule, whole (never cut, so no
 * condition or negation is lost), deduplicated. Over the budget, whole units are left out, the feedback memories
 * and CRITICAL units last. The stored hooks follow as "automated checks", one line each.
 */
export function extractRules(sources: readonly RuleSource[], hookLines: readonly string[] = [], budget = RULES_MAX) {
  const seen = new Set<string>()
  const all: { text: string; rank: number; at: number }[] = []
  for (const src of sources) {
    for (const u of units(src.text)) {
      if (!RULE_WORD.test(u)) continue
      const key = u.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      all.push({ text: u, rank: src.isFeedback === true || /\bCRITICAL\b/.test(u) ? 0 : 1, at: all.length })
    }
  }
  const head = "Excerpt of the person's standing rules and procedures (may be incomplete: a rule missing here is not evidence of anything):"
  const hooksHead = 'Automated checks that run (hooks: event, matcher → script):'
  // The whole excerpt stays within the budget: rule units first (by rank), then hook lines while room is left.
  let room = budget - head.length - 1
  const kept: typeof all = []
  for (const u of [...all].sort((a, b) => a.rank - b.rank || a.at - b.at)) {
    const cost = u.text.length + 3
    if (cost > room) continue
    kept.push(u)
    room -= cost
  }
  const hooks: string[] = []
  room -= hooksHead.length + 1
  for (const l of hookLines.slice(0, HOOK_LINES_MAX)) {
    const line = `- ${l}`
    if (line.length + 1 > room) continue
    hooks.push(line)
    room -= line.length + 1
  }
  if (kept.length === 0 && hooks.length === 0) return ''
  const body = kept.sort((a, b) => a.at - b.at).map(u => `- ${u.text}`)

  return [head, ...body, ...(hooks.length > 0 ? [hooksHead, ...hooks] : [])].join('\n')
}

/** The stored hooks as one line each: event, matcher, and the script the command runs (its name only). */
export function hookLines(hooks: unknown): string[] {
  if (hooks === null || typeof hooks !== 'object') return []
  const lines: string[] = []
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      if (g === null || typeof g !== 'object') continue
      const matcher = typeof (g as { matcher?: unknown }).matcher === 'string' && (g as { matcher: string }).matcher !== '' ? (g as { matcher: string }).matcher : '*'
      const list = (g as { hooks?: unknown }).hooks
      if (!Array.isArray(list)) continue
      for (const h of list) {
        const command = h !== null && typeof h === 'object' ? (h as { command?: unknown }).command : undefined
        if (typeof command !== 'string') continue
        const words = parseCommands(command)[0] ?? []
        const script = words.find(w => /\.(py|js|mjs|cjs|ts|sh|ps1|cmd|bat)$/i.test(w)) ?? words[0] ?? ''
        const name = (script.split(/[\\/]/).pop() ?? '').slice(0, 60)
        if (name !== '') lines.push(`${event} ${matcher.slice(0, 60)} → ${name}`)
      }
    }
  }

  return lines
}

/**
 * Whether a quote is word for word in its source, at least 12 characters. Only runs of whitespace are evened out
 * (the model reads a line break as a space); case and every other character must match.
 */
export const isQuotedFrom = (quote: string, source: string) => {
  const q = squash(quote)

  return q.length >= 12 && squash(source).includes(q)
}
