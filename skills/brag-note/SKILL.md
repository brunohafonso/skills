---
name: brag-note
description: Turn a ticket, task, PR, or any description of work the user did into a structured brag-book entry and save it to their brag book. Use whenever the user wants to record an accomplishment or win, mentions their brag book / brag document / brag note, wants to log work for a performance review, promotion, raise, or resume, or pastes a ticket/PR/task summary and asks to document what they did. Also trigger when the user says things like "add this to my brag book", "log this win", "brag note this", or shares praise they received and wants it captured.
---

# Brag Note

Help the user capture one unit of work as a brag-book entry: evidence of the
value they delivered, written so it can be lifted straight into a performance
review, promotion packet, raise negotiation, or resume months later. The whole
point is that memory fades — the entry must stand on its own when the context
is long gone.

The brag book lives at `~/brag-book/BRAG_BOOK.md`. Praise screenshots live in
`~/brag-book/praise/`.

## Workflow

### 1. Ingest the input

The user provides something describing the work: pasted ticket text, a Jira
ID, a GitHub issue/PR URL, a file path, a git branch, or just a sentence
("shipped the new auth flow"). Gather what you can yourself before asking
anything:

- GitHub URL or `#123` reference → fetch it (`gh pr view` / `gh issue view`).
- File path → read it.
- If they're vague and you're in a repo, recent `git log --author` can jog
  details — but only offer this, don't dump history unasked.

### 2. Extract, then draft

Fill in every field you can from the input alone. Then look at what's missing
or weak. The fields:

| Field            | What it holds                                                                 | Required |
| ---------------- | ----------------------------------------------------------------------------- | -------- |
| **Date**         | When the work happened/shipped (ISO `YYYY-MM-DD`). Default to today only if the user confirms it's recent. | yes |
| **Task/Project** | Short title + ticket ID / PR link when one exists                              | yes |
| **Contribution** | What *the user specifically* did — decisions, actions, things that wouldn't have happened without them | yes |
| **Impact**       | The business result: revenue, cost, customer satisfaction, efficiency, reliability, risk removed. Quantified whenever possible | yes |
| **Stakeholders** | Who was involved, unblocked, or benefited (people, teams, customers)           | optional |
| **Praise**       | Quotes received about this work; reference screenshots saved to `~/brag-book/praise/` | optional |
| **Skills**       | Skills used or newly gained; courses/training completed as part of this        | optional |

Two distinctions matter more than anything else here:

- **Contribution ≠ task description.** The ticket says what was asked; the
  contribution says what the user did about it. "Implemented the feature" is
  the ticket talking. "Redesigned the retry logic after finding the queue was
  double-processing, and got two other teams to adopt the fix" is a
  contribution.
- **Impact ≠ output.** "Shipped the migration" is output. "Cut deploy time
  from 40 min to 8, unblocking daily releases" is impact. At review time,
  unquantified impact reads as opinion; numbers read as evidence.

### 3. Interview — grouped, minimal

Ask only about what's missing or weak, grouped into one round (two at most).
Use the AskUserQuestion tool when available so the user can answer everything
in one pass; otherwise ask as a compact list. Never walk field-by-field
through things the input already answered — re-asking what they just pasted
is friction that kills the habit.

When the impact is unquantified, push once for a number: "Roughly how much
time/money/tickets did this save? An estimate is fine." An honest estimate
("~2h/week saved for the on-call") beats a blank. If the user genuinely
doesn't know, keep the qualitative version — don't invent figures, and don't
nag.

If the user mentions praise, remind them to screenshot it into
`~/brag-book/praise/` and reference the filename in the entry.

### 4. Write the entry

Insert the entry at the **top** of `~/brag-book/BRAG_BOOK.md` (newest first,
directly under the file header) so the most recent wins are the first thing
seen at review time. If the file doesn't exist yet, create it with the header
below. Omit optional fields that are empty — no "N/A" noise.

```markdown
# Brag Book

Evidence of the value I bring. One entry per win, newest first.
Praise screenshots: ./praise/

---

## 2026-07-03 — Migrated payments service off legacy ORM
- **Task/Project:** PAY-142 — https://github.com/org/repo/pull/87
- **Contribution:** Led the migration plan, wrote the compatibility layer that
  let us ship incrementally instead of big-bang, and unblocked two stalled
  feature teams waiting on it.
- **Impact:** Removed the last blocker for the Postgres 18 upgrade; cut query
  p99 from 900ms to 210ms on the checkout path.
- **Stakeholders:** Checkout team, platform team, on-call rotation
- **Praise:** "This migration was the smoothest I've seen" — Eng Manager
  (praise/2026-07-03-payments-migration.png)
- **Skills:** Drizzle ORM, zero-downtime migration patterns
```

Write the contribution in first person implied, past tense, action verbs —
resume-ready. Keep the entry tight: 3–6 lines of substance, not a project
report.

### 5. Confirm

Show the final entry in the conversation and confirm it was saved, with the
file path. If the user corrects anything, edit the entry in place.
