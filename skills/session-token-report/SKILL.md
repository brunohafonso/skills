---
name: session-token-report
description: Generate a Markdown token-usage and cost report for a Claude Code session — total tokens including subagents, broken down per stage (plan vs execution), per model, and per subagent/task, with wall-clock durations and an approximate USD cost. Use whenever the user asks how many tokens a session used or spent, how much a session (or "this session") cost, wants a token/usage/cost report, asks about token spend per subagent, per task, or per stage, or says things like "generate the session report", "how expensive was that", "token breakdown", or "what did that run cost me". Also use for reporting on past sessions referenced by name.
---

# Session Token Report

Produce a per-session token-usage + cost report from the local Claude Code
transcripts in `~/.claude/projects/`. The bundled script does all the parsing,
math, and table generation; your job is to run it and then polish two
narrative sections it can't infer.

## How to run

The script lives in this skill's directory. From the project the session
belongs to (it derives the project from the cwd):

```bash
node <skill-base-dir>/scripts/session-token-report.mjs [selector] [--json]
```

- **No selector** → the most recent session for this project. When invoked
  from inside a live session, that IS the current session — the report gets a
  "session in progress" marker automatically.
- **Selector** → a session title fragment (e.g. `auth-header`) or a uuid
  prefix. The script scans each transcript's `ai-title` lines to match names.
- `--project <slug-or-path>` targets another project's sessions;
  `--out <dir>` overrides the default report directory.

Prefer running with `--json`: it still writes the Markdown report (path in
`reportFile`) and gives you the aggregate object for your summary to the user.

Reports are written to `~/.claude/token-reports/<project-slug>/<title>-<date>.md`
and **overwritten on re-run** — one canonical report per session.

## After the script runs — polish the narrative

Open the generated report. Two sections carry a `<!-- claude:rewrite -->`
marker with raw material underneath. Rewrite **only those two sections** into
prose (keep the headings, delete the marker and the bullet hints):

1. **Task** — 1–3 sentences on what the session was about, based on the
   session title and the first-user-prompt excerpt the script embedded.
2. **Process** — a short narrative of how the work unfolded (research, code
   investigation, implementation, test execution, subagent delegation),
   grounded in the tool-call counts and subagent list the script embedded.
   Don't recite the counts as a list — tell the story they imply. If you were
   part of the session being reported, use what you actually know about it.

Leave every table and the Cost estimate section exactly as generated — they
are deterministic script output, and re-runs must stay comparable.

Finish by telling the user: the report path, the total tokens, the total
approximate cost, and the plan/execution split in one or two sentences.

## Notes and limits

- Cost figures are **API list prices** (snapshot date is printed in the
  report). Subscription (Pro/Max) users pay $0 marginally — the number is
  "API-equivalent value". Never present it as an actual charge.
- Unknown model ids are counted in tokens but flagged as unpriced rather than
  priced by guesswork. If the user asks about one, check current pricing
  before answering.
- When Anthropic pricing changes, update `MODEL_PRICING` and `PRICING_AS_OF`
  at the top of `scripts/session-token-report.mjs`.
- The parser dedupes API responses by `message.id` (the transcript repeats
  the same usage object on every content-block line) — if you ever cross-check
  totals with `jq`, dedupe the same way or you will overcount.
- v1 is single-session. For "how much did I spend this week", run the script
  per session for now (the `--json` output makes summing easy) — a proper
  aggregate mode is a planned follow-up.
