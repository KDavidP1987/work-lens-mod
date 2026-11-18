# work-lens

A Claude Code mod that turns the transcript's wall of text into a work log: every step of work gets a one-line
summary you can expand or collapse, a category, the plan item it relates to, and a marker.

| Marker | Meaning |
| --- | --- |
| ● planned | carries out an item found in the project's plan files |
| ○ planned (unconfirmed) | the model called it planned, but the item was not found in the plan |
| ◆ new | work that came up along the way |
| ✚ fix | repairs something that failed earlier in the session |

A **step** is one assistant text block and the tool calls that follow it, or a run of tool calls on its own.

Each marker is colored by the kind of effort the step was:

| Color | Valence | Which steps |
| --- | --- | --- |
| green | ▲ positive | work that moves the build forward |
| gray | ■ neutral | upkeep with no direct value: the `neutralCategories` (default: notes) |
| red | ▼ negative | fixing an error (✚ fix) |

The line above the prompt counts the steps per valence, marker and category, and **every count is a filter**:
click it (or focus the line with ctrl+x tab) to show only those steps; click it again to show all. Filtering by
▼ negative is a quick way to review how much of a session went to repairs.

## Use

- **Fullscreen layout** (`/config` › fullscreen): each finished step shows as a header line, collapsed by
  default: its text, its tool calls and their output (command output, diffs, file reads) all fold into that one
  line. Press it to expand or collapse. The step in progress stays open until its summary arrives. Work from
  before the mod started (a resumed session) folds too, as "earlier history" steps; `/worklog summarize` labels
  them if you want (each is one model call). Before the conversation compacts, the mod reads every step up to
  that point, so the work still on screen after a compaction folds too. `/worklog` opens the *Work log* pane: filter buttons per category and
  per marker (hotkeys 1-9) and the list of steps. A filter hides every step outside it, text and tool rows alike;
  the line above the prompt says how many are hidden. A grouped tool row that holds calls of two steps stays
  visible while either step is shown.
- **Default layout**: the terminal has already printed past rows, so they cannot fold. Each summary arrives as a
  log line naming the step (`work-lens step 12 "Running the lab CI…" — ● auditing · D19 · …`), and
  `/worklog [all|planned|new|fix|<category>]` prints the filtered list.
- `/worklog positive|neutral|negative` filters by valence from the command line too.
- `/worklog summarize` summarizes the steps that were skipped (summaries off, queue full, call cap).

`ctrl+o` shows tool rows in full as usual; the text of a collapsed step shows when you press its header.

Known limitation: a header is placed on the text block that opens its step, matched by its first 60 characters.
If one reply row holds two blocks that begin identically, both show the header. Earlier history folds only
within the newest 4,096 transcript rows (the most a mod can read by id).

## Settings (`/plugin` › work-lens › configure)

| Setting | Default | |
| --- | --- | --- |
| `categories` | notes, backlog & artifacts, code, auditing, evaluating | comma-separated |
| `neutralCategories` | notes | categories counted as neutral (gray) |
| `model` | haiku | haiku or sonnet |
| `autoSummarize` | on | off: nothing is sent until `/worklog summarize` |
| `collapseByDefault` | on | fullscreen headers start collapsed |
| `maxCalls` | 200 | per session; every attempt counts, retries included |

## What it sends, and what it costs

Each step is one extra model request (the default `haiku`, a few hundred tokens out), made through **your
session's own API client and provider** and listed in `/cost`. Calls run one at a time, time out after 60 s,
and stop at the cap. Each request carries:

- the step's text, up to 4,000 characters;
- each tool call reduced to its name plus its file path or the first 120 characters of its command; no other
  input of any tool (never the contents of a write or edit, a URL, a search pattern or a subagent prompt);
- up to 8,000 characters from the project's plan files, if present at the session root: `BACKLOG.md`,
  `docs/dod/README.md`, `.orchestration/handoff.md`, `PLAN.md`, `TODO.md`. **The session itself may never have
  sent these files**, so this is data the mod adds.

Before sending, text shaped like a secret (`sk-…`, `ghp_…`, `AKIA…`, `xox…-`, private key blocks,
`password=`/`token:` pairs, long base64 or hex runs) is replaced with `[redacted]`. Redaction is a pattern match,
not a guarantee. Turn `autoSummarize` off in a session that handles material you would not send.

The mod writes nothing to disk; its log lives in the session and starts over on `/clear`.

## Install

```
claude plugin marketplace add KDavidP1987/work-lens-mod
claude plugin install work-lens@work-lens-mod --scope user
```

Requires Claude Code 2.1.327 or later. Running sessions pick it up when restarted.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT © SkillEra IO, LLC
