---
name: brag-harvest
description: Automatically collect the user's recent contributions from GitHub (gh CLI), Jira (MCP), and Slack (MCP), dedupe them against the brag book, and turn the fresh ones into brag notes via the brag-note skill. Use whenever the user wants to harvest their wins, update their brag book from recent activity, asks "what did I ship this week/sprint/month", wants to collect contributions for a performance review, or wants brag notes created from Jira tickets, merged PRs, or Slack activity. Also use for scheduled/headless brag-book runs.
---

# Brag Harvest

Automate the front half of the brag-book habit: instead of the user pasting a
ticket, find what they shipped, filter out what's already recorded, and hand
each fresh win to the `brag-note` skill for its interview. The failure mode
this skill exists to prevent is silent loss — work that happened, was never
written down, and is gone by review time.

Files: brag book at `~/brag-book/BRAG_BOOK.md`, harvest state at
`~/brag-book/.harvest-state`, pending inbox at `~/brag-book/PENDING.md`.

## Guiding rule: degrade, never abort

Sources WILL be missing: `gh` not installed or unauthenticated, no Jira MCP,
no Slack MCP, an MCP present but unauthenticated or unable to say who the
user is. A partial harvest that completes is worth infinitely more than a
complete harvest that errors out. So probe each source independently, warn
plainly about what's unavailable (never silently omit a source — the warning
tells the user what the harvest didn't see), and continue with whatever
works. Never abort the run because a source is down.

## Interactive run

### 0. Check the pending inbox

Read `~/brag-book/PENDING.md` first. If it has items (left by a scheduled
run), skip harvesting entirely: jump to step 4 with the pending list as the
candidates, clear the file after they're processed, and at the end offer one
fresh sweep in case the inbox is stale. If the file is empty or missing,
continue below.

### 1. Determine the window

Anchor = the most recent of: the `last-run:` date in `.harvest-state`, and
the newest `## YYYY-MM-DD` heading in `BRAG_BOOK.md`. Neither exists → last
7 days. Harvest from the anchor to today, and tell the user the window
you're using.

### 2. Probe sources, then harvest

Probe all three, then print a one-line status board **before** harvesting,
e.g.:

> GitHub ok · Jira unavailable (no MCP configured) · Slack unavailable (not authenticated)

- **GitHub** — healthy when `gh` exists and `gh auth status` passes. Harvest
  PRs the user authored that merged in the window
  (`gh search prs --author @me --merged --merged-at ">=<anchor>"`) and
  issues they authored or were assigned that closed in the window. No
  org/repo filters — everything they have access to; the selection step is
  the filter.
- **Jira** — MCP only. Find Jira/Atlassian tools via ToolSearch. Identify
  the user through the MCP itself (a `myself`/current-user capability) —
  never ask for or persist a Jira handle. Healthy → issues assigned to the
  user that were resolved or meaningfully updated in the window. Any failure
  (no MCP, auth error, identity unresolvable) → warn + skip.
- **Slack** — MCP only, identity via the MCP, same failure rule. Three
  categories, each capped (~10) and judgment-filtered:
  1. **Kudos** — messages mentioning the user that read as recognition.
  2. **Incidents** — incident/outage threads where the user contributed
     analysis or solutions.
  3. **Helping coworkers** — threads where the user's replies unblocked
     someone.
  If the MCP lacks search, treat Slack as partially available: warn about
  the limitation and use what works.

### 3. Dedup

Normalize every finding to `(date, title, source, link/ID)`. Drop candidates
already covered — the ticket ID, PR URL, or an obvious title match appears
in `BRAG_BOOK.md` — and candidates previously dismissed (listed in
`.harvest-state`). Report covered/dismissed only as counts. Slack kudos that
match a surviving candidate (same work, by date/keywords) don't become their
own candidate: attach them to pre-fill that note's **Praise** field.

### 4. Select

Present the fresh candidates — AskUserQuestion with multiSelect when
available, a numbered list otherwise — and let the user pick which deserve
notes. Raw harvests often exceed what a selector fits (and what a reader
scans): first group related items into themed candidates — the PRs of one
initiative are one win, not four — and bundle obvious noise (dependency
bumps, config chores) into a single "probably skip" group. One brag note
per *win*, not per artifact. Expect them to drop noise (dependency bumps, typo fixes). Append every
presented-but-unselected candidate's ID/URL to `.harvest-state` as dismissed:
rejected once means never offered again. The file is plain text, one entry
per line, so the user can hand-delete a line to resurrect an item.

### 5. Create the notes

For each selected candidate, **sequentially** (one at a time, so each note
gets attention while its context is on screen, and an interrupted run still
leaves finished notes behind):

1. Deep-fetch its context — full PR body and review comments, the linked
   ticket, the Slack thread — only now, only for selected items.
2. Follow the `brag-note` skill (load via the Skill tool if installed;
   fallback: read the sibling `../brag-note/SKILL.md` in this repo) with the
   fetched context as the input. Rich input collapses the interview to the
   real gaps — usually just the quantified impact. Attached kudos pre-fill
   the Praise field.

When done, write `last-run: <today ISO>` into `.harvest-state`.

### 6. Offer a schedule (once)

After a successful fresh harvest, offer — once, don't nag on every run — to
schedule recurring harvests (suggest weekly, e.g. Friday afternoon while the
week is fresh). Beware the obvious trap: Claude Code's in-session Cron tools
are **session-only** (in-memory, gone when the session ends) — they cannot
deliver a durable weekly schedule. Use the OS scheduler instead: a launchd
job (macOS) or crontab entry (Linux) running `claude -p "<headless harvest
prompt>"`. Grant the headless run the **narrowest** tool allowlist that
works — read-only `gh` commands (`gh auth status`, `gh search:*`,
`gh pr view:*`, `gh issue view:*`), Read/Glob/Grep/ToolSearch/Skill, and
Write scoped to `~/brag-book/**` only — because a scheduled agent runs
unsupervised, and its permissions are the whole security story. Installing
an unsupervised job is an action the user must explicitly approve; show
them the job definition before loading it.

## Headless run (scheduled — no user to interview)

An interview needs the user, so a headless run does only the harvest half.
Note that interactively-authenticated MCPs are often absent in scheduled
sessions — a GitHub-only harvest with warnings is a normal, successful
outcome:

1. Run steps 1–3 with whatever sources are reachable.
2. Append fresh candidates to `~/brag-book/PENDING.md`, dated, with source
   and link — enough for the next interactive run to select from without
   re-searching.
3. Stamp `last-run:` in `.harvest-state`.
4. If a push-notification tool is available, notify: "brag-harvest: N
   candidates waiting". Otherwise finish silently — the inbox is the record.
5. Never fabricate interview answers or write brag-book entries headlessly —
   a brag note without the user's judgment on contribution and impact is
   exactly the vague entry the brag book must not contain.
