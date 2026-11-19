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

### What never folds before you have seen it

Folding is for routine work. The moments that need you stay open until you reply:

| Badge | Meaning |
| --- | --- |
| **❗ input** (amber, bold) | the model is waiting on you now: a question card, a plan to approve, or a question in its last message of a turn |
| ★ report | the last message of the newest turn, its report to you |
| ? unread | an older turn's last message that has no summary yet (it may be asking), kept until you reply |
| ✔ decided | a question you answered: folded, still found by the `❗ input` filter |

Only a turn's last message can be waiting on you in text, so only that one is checked, by the same summary call
(no extra request). Input noted for later, such as a backlog item or a decision put off, is not ❗. A waiting
question passes every filter, and the line above the prompt shows `❗ n waiting on you`. Your reply (a prompt
you type; slash commands and background notices don't count) marks it decided.

### Critical work, flagged

Four flags draw after the badge, so work that matters is visible even when its step is folded:

| Flag | Meaning | How it is found |
| --- | --- | --- |
| ⚠ unresolved (red) | a call failed and nothing has resolved it yet | the tool results; resolved by a later call to the same target that succeeds (a retry), by a later step whose summary names that failure as fixed, or by its own step's summary calling it expected (a search with no match, a test written to fail first) |
| ⇪ outward (amber) | the step sent something off this machine: a push, publish, deploy, release, PR, a message, an artifact, a handoff note | the parsed command or tool name, no model call; only with a result seen (`⇪?` while it is not). Local deletions are not outward. Add your own with `outwardPatterns` |
| ⚑ deviation (red) | the step **materially** broke one of your standing rules: an action against a rule (a plan, code or data changed, a push, a deploy, a decision reserved for you), or a required part of an action it took skipped (a push without its approval). A procedure whose trigger did not occur is not a deviation | the summary call, against an excerpt of your rules; kept only when the rule is quoted from that excerpt and the breaking call or words are named |
| ◇ assumption (dim) | a choice you did not ask for or decide (a picked default, an inferred intent, a widened scope) | the summary call |

⚑ and ◇ are model judgments and can be wrong; the pane and `/worklog` show the quoted rule and what the step did,
so you can judge them. Each flag is a filter, and the line above the prompt shows `⚠ n unresolved` while any are
open.

### Label groups

The labels fall into four groups:

| Group | Labels | |
| --- | --- | --- |
| **Needs you** | ❗ input, ★ report, ⚠ unresolved, ⚑ deviation | what to act on |
| **Review** | ⇪ outward, ◇ assumption | what to look over |
| **Purpose** | ● planned, ◆ new, ✚ fix | why the step was done |
| **Work** | your categories | what kind of work it was |

The value (▲ green, ■ gray, ▼ red) follows from purpose and category, so it is the marker's color, not a group.

The line above the prompt and the pane show one chip per group (`labelDetail: grouped`, the default). Needs you
and Review carry a count. **Every chip is a filter**:
- Press a group to filter by it (a step with any of its labels) and to open it into its labels, each with its own
  count. `‹ groups` goes back.
- Press a label to show only its steps; press it again to show all.
- Focus the line with ctrl+x tab.

`labelDetail: all` shows every label as its own chip instead, side by side, value chips (▲ positive, ■ neutral,
▼ negative) included: the layout before 0.5.1. Filtering by ▼ negative is a quick way to review how much of a
session went to repairs.

Under a filter, steps without a summary stay in view, because they have no label to filter on. The line says how
many there are and why: "earlier history" is work from before the mod started, which is never summarized unless
you ask (`/worklog summarize`). The other reasons are the call cap, a full queue, a session that ended, or a
summary that failed. Example: `· 100 without a summary, kept in view (92 earlier history, 8 call cap reached;
/worklog summarize)`.

`labelGroups` picks the groups drawn at all. For example, `needs, work` hides ⇪/◇ and the purpose glyphs from
rows, chips and `/worklog` lines. A hidden label still filters when typed (`/worklog outward`), marked
"(hidden group)". Hiding is display only: what is sent to the model does not change (see `judgeRules` and
`sendFailureText`).

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
- `/worklog needs|review|purpose|work` filters by a group. `/worklog positive|neutral|negative` filters by value (it
  is no longer offered as a chip). `/worklog input` lists every
  question and decision, `/worklog report` every turn's report, and `/worklog unresolved|outward|deviation|assumption`
  the flagged steps with their reasons. In this layout a summary that asks for your input
  is logged with `❗ input needed` in front.
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
| `labelDetail` | grouped | grouped: one chip per label group, opened by pressing; all: every label as a chip, value included (the layout before 0.5.1) |
| `labelGroups` | needs, review, purpose, work | the label groups drawn (display only; an unknown name is logged) |
| `outwardPatterns` | (none) | comma-separated regexes over a parsed command that also count as ⇪ |
| `judgeRules` | on | off: no rule excerpt and no latest message are sent, and ⚑/◇ are not asked |
| `sendFailureText` | on | off: a failure is named by its call only, without its error text |

## What it sends, and what it costs

Each step is one extra model request (the default `haiku`, a few hundred tokens out), made through **your
session's own API client and provider** and listed in `/cost`. Calls run one at a time, time out after 60 s,
and stop at the cap. Each request carries:

- the step's text, up to 4,000 characters (for a turn's last message, also the question whether it asks you
  for input now);
- each tool call reduced to its name plus its file path or the first 120 characters of its command; no other
  input of any tool (never the contents of a write or edit, a URL, a search pattern or a subagent prompt);
- up to 8,000 characters from the project's plan files, if present at the session root: `BACKLOG.md`,
  `docs/dod/README.md`, `.orchestration/handoff.md`, `PLAN.md`, `TODO.md`. **The session itself may never have
  sent these files**, so this is data the mod adds;
- for a failed call, the first 300 characters of its error, and for a step after a failure, up to 5 failures
  still open (`sendFailureText` off: their calls only);
- with `judgeRules` on (the default):
  - up to 6,000 characters of rule lines (whole bullets or paragraphs holding never, always, must, only, do not,
    required, CRITICAL…) from the instruction files the session already sends (your CLAUDE.md files, the memory
    index);
  - the **feedback memories** beside that index (files named `feedback*` or typed `feedback`), which the session
    does not otherwise send;
  - your stored hooks, reduced to event, matcher and script name (never the full command or any other setting);
  - the first 300 characters of your latest typed message, so an approval can be judged.

  The excerpt is sent first and marked for the prompt cache.

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
