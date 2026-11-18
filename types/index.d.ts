/** ● planned (evidence found), ○ planned but unconfirmed, ◆ new, ✚ fix. */
export type Kind = 'planned' | 'unconfirmed' | 'new' | 'fix'

export type StepTool = { id: string; brief: string; isError?: true }

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
    }
  }
}
