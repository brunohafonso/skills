# skills

My personal collection of [agent skills](https://agentskills.io) — reusable instruction sets that teach coding agents (Claude Code, Cursor, and others) how to do a specific task well.

Each skill is a folder under [`skills/`](./skills) containing a `SKILL.md` with frontmatter (name + trigger description) and the instructions the agent follows.

## Skills

| Skill | Description |
| ----- | ----------- |
| [`brag-note`](./skills/brag-note) | Turns a ticket, PR, task description, or any summary of work you did into a structured brag-book entry. It extracts what it can from the input, interviews you about the gaps (contribution, business impact, stakeholders, praise, skills), pushes for quantified impact, and saves the entry newest-first to `~/brag-book/BRAG_BOOK.md` — evidence ready for performance reviews, raises, and resume updates. |

## Install

Skills are installed with the [`skills` CLI](https://github.com/vercel-labs/skills) — no setup needed beyond Node:

```bash
# Install all skills from this repo
npx skills add brunohafonso/skills

# Install a single skill
npx skills add brunohafonso/skills@brag-note

# Install globally (available in every project)
npx skills add brunohafonso/skills -g

# See what's available without installing
npx skills add brunohafonso/skills --list
```

By default the CLI detects the agents you have and asks where to install. To target a specific agent:

```bash
npx skills add brunohafonso/skills --agent claude-code
```

## Usage

After installing, just talk to your agent naturally — skills trigger from their descriptions. For example, with `brag-note` installed:

> "Add this to my brag book: https://github.com/org/repo/pull/87"

The agent reads the PR, asks you a short round of questions about your contribution and its impact, and appends the finished entry to your brag book.

## License

[MIT](./LICENSE)
