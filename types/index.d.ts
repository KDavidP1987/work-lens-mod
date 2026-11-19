/** ● planned (evidence found), ○ planned but unconfirmed, ◆ new, ✚ fix. */
export type Kind = 'planned' | 'unconfirmed' | 'new' | 'fix'

export type StepTool = {
  id: string
  brief: string
  isError?: true
  /** A result of the call was seen in the transcript (text stored): the only proof it ran. */
  seen?: true
  /** What the call sends off the machine (`git push`, `npm publish`…), from its input alone. */
  out?: string
  /** What the call acted on, to recognize a retry of it (kept here, never sent). */
  target?: string
  /** A failed call: its error's first 300 characters, redacted. */
  error?: string
  /** A failed call: its failure id (f1, f2, …), one per tool_use_id for the session. */
  fail?: string
}

/** A step that breaks a stated rule: the rule quoted from the excerpt, how, and the call or words that did it. */
export type Deviation = { rule: string; how: string; toolId?: string; quote?: string }

/** One step of work: an assistant text row and the tool calls that follow it, or a run of tool calls alone. */
export type Step = {
  /** The uuid of the step's first row; `<id>#<part>` for the later parts of a long step. */
  id: string
  /** The step's place in the session (1, 2, ...), set when it closes. */
  n?: number
  part: number
  parentId?: string
  /** The row uuids the step holds, oldest first. */
  rows: string[]
  /** The uuid of the row holding the step's opening text, absent for a tools-only step. */
  textRow?: string
  toolIds: string[]
  text: string
  tools: StepTool[]
  status: 'open' | 'queued' | 'running' | 'done' | 'unavailable' | 'skipped'
  note?: string
  summary?: string
  category?: string
  kind?: Kind
  relates?: string | null
  isRelatesVerified?: boolean
  /** A tool call failed in the step before this one: the evidence a fix needs. */
  errorBefore?: boolean
  /**
   * The step asks the person for input now: a question card, a plan to approve (both from the tool calls), or a
   * question in the text of a turn's last step (from its summary's `asks_now`). Input noted for later is not.
   */
  asks?: 'card' | 'plan' | 'text'
  /** The person has replied since the step (a card or plan answered, or a prompt typed after the turn). */
  isReplied?: boolean
  /** The last step with text of a turn of the main conversation: its report to the person. */
  isTurnEnd?: boolean
  /** The person's latest typed message before the step (first 300 characters), the context for approvals. */
  latest?: string
  /** Failure ids (of earlier steps) its summary says it repairs. */
  fixes?: string[]
  /** Failure ids of its own calls its summary says were intended or harmless. */
  expected?: string[]
  /** ⚑ A material break of a stated rule, grounded in a call or the step's own words. */
  deviation?: Deviation
  /** ◇ A choice the person did not ask for or decide, worth a look. */
  assumption?: string
  /** Successful results in this step whose calls closed in an earlier read: those calls are marked seen. */
  seenEarlier?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'work-lens': {
      /** Closed steps, oldest first (the open one is not listed). */
      steps: Step[]
      /** 'all', a category, or a kind (planned, new, fix). */
      filter: string
      /** Steps the person expanded (or, with collapse off, collapsed): step id -> true. */
      toggled: Record<string, true>
      /** Calls tried and calls answered this session. */
      calls: { tried: number; answered: number }
      /** The uuid of the last row already split into closed steps; null before the first scan. */
      anchor: string | null
      /** Whether the rows from before the mod started have been listed (as collapsed "earlier history" steps). */
      backfilled: boolean
      /** The last failure id handed out (f1, f2, …): only grows, so an id is never reused. */
      failSeq: number
      /** The label group opened in the chips (grouped detail), or null for the groups themselves. */
      openGroup: string | null
    }
  }
}
