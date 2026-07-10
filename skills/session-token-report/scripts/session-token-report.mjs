#!/usr/bin/env node
/**
 * session-token-report — parse a Claude Code session transcript (JSONL) and
 * generate a Markdown token-usage + cost report, including subagents and
 * per-stage (plan vs execution) breakdowns.
 *
 * Usage:
 *   node session-token-report.mjs [--session <name|uuid-prefix|latest>]
 *                                 [--project <slug-or-path>]
 *                                 [--out <dir>] [--json]
 *
 * Zero dependencies. Node >= 20.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Pricing (USD per million tokens, API list prices)
// ---------------------------------------------------------------------------
const PRICING_AS_OF = '2026-07-10';
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
// Longest-prefix match against the message's model id.
const MODEL_PRICING = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos-5', input: 10, output: 50 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25 },
  { prefix: 'claude-opus-4-5', input: 5, output: 25 },
  { prefix: 'claude-sonnet-5', input: 3, output: 15 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15 },
  { prefix: 'claude-sonnet-4-5', input: 3, output: 15 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 },
];

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const IN_PROGRESS_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { session: 'latest', project: null, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') args.session = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: session-token-report.mjs [--session <name|uuid-prefix|latest>] [--project <slug-or-path>] [--out <dir>] [--json]',
      );
      process.exit(0);
    } else {
      // bare positional argument == session selector
      args.session = a;
    }
  }
  return args;
}

function projectSlug(cwdOrSlug) {
  if (!cwdOrSlug.includes('/')) return cwdOrSlug; // already a slug
  return cwdOrSlug.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------
function emptyAgg() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0, unpricedTokens: 0, messages: 0 };
}

function totalTokens(agg) {
  return agg.input + agg.output + agg.cacheRead + agg.cacheWrite5m + agg.cacheWrite1h;
}

function priceFor(model) {
  if (!model) return null;
  return MODEL_PRICING.find((p) => model.startsWith(p.prefix)) ?? null;
}

function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.input * CACHE_READ_MULTIPLIER +
      u.cacheWrite5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
      u.cacheWrite1h * p.input * CACHE_WRITE_1H_MULTIPLIER) /
    1_000_000
  );
}

function addUsage(agg, u, cost) {
  agg.input += u.input;
  agg.output += u.output;
  agg.cacheRead += u.cacheRead;
  agg.cacheWrite5m += u.cacheWrite5m;
  agg.cacheWrite1h += u.cacheWrite1h;
  agg.messages += 1;
  if (cost === null) agg.unpricedTokens += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  else agg.cost += cost;
}

function normalizeUsage(usage) {
  const cc = usage.cache_creation ?? null;
  const write5m = cc ? (cc.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0);
  const write1h = cc ? (cc.ephemeral_1h_input_tokens ?? 0) : 0;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

const TOOL_CATEGORIES = {
  research: new Set(['WebSearch', 'WebFetch']),
  investigation: new Set(['Read', 'Grep', 'Glob']),
  implementation: new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
};
const TEST_BUILD_RE = /\b(test|jest|vitest|spec|lint|tsc|build|format:check|check)\b/i;

/**
 * Stream-parse one transcript file. Handles both main transcripts (with stage
 * tracking) and subagent transcripts (stages irrelevant but harmless).
 */
async function parseTranscript(filePath) {
  const result = {
    stagesSeen: false,
    // per unique message.id
    messages: new Map(), // id -> { model, stage, usage, cost }
    // stage wall-clock segments
    stageDurations: { plan: 0, execution: 0 },
    // Agent/Task tool_use spawns: toolUseId -> { description, subagentType, stage }
    agentSpawns: new Map(),
    toolCounts: new Map(), // tool name -> count
    activity: { research: 0, investigation: 0, implementation: 0, tests: 0, otherBash: 0 },
    title: null,
    firstUserPrompt: null,
    firstTimestamp: null,
    lastTimestamp: null,
    sessionId: null,
    gitBranch: null,
    version: null,
  };

  let stage = 'execution'; // permission-mode "default"
  let segStart = null;
  let lastTs = null;

  const closeSegment = () => {
    if (segStart !== null && lastTs !== null && lastTs > segStart) {
      result.stageDurations[stage] += lastTs - segStart;
    }
    segStart = null;
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === 'permission-mode') {
      result.stagesSeen = true;
      closeSegment();
      stage = obj.permissionMode === 'plan' ? 'plan' : 'execution';
      continue;
    }
    if (obj.type === 'ai-title' && obj.aiTitle) {
      result.title = obj.aiTitle;
      continue;
    }
    if (obj.type === 'agent-name' && obj.agentName) {
      if (!result.title) result.title = obj.agentName;
      continue;
    }

    if (obj.timestamp) {
      const ts = Date.parse(obj.timestamp);
      if (!Number.isNaN(ts)) {
        if (result.firstTimestamp === null) result.firstTimestamp = ts;
        result.lastTimestamp = ts;
        if (segStart === null) segStart = ts;
        lastTs = ts;
      }
    }
    if (obj.sessionId && !result.sessionId) result.sessionId = obj.sessionId;
    if (obj.gitBranch && !result.gitBranch) result.gitBranch = obj.gitBranch;
    if (obj.version && !result.version) result.version = obj.version;

    if (obj.type === 'user' && !obj.isMeta && result.firstUserPrompt === null) {
      const text = extractUserText(obj.message);
      if (text) result.firstUserPrompt = text;
    }

    if (obj.type !== 'assistant' || !obj.message) continue;
    const msg = obj.message;

    // tool_use blocks (repeat across the message's split lines; count once per block id)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type !== 'tool_use' || !block.id) continue;
        if (result.agentSpawns.has(block.id) || result.toolCounts.has(`seen:${block.id}`)) continue;
        result.toolCounts.set(`seen:${block.id}`, 1); // dedupe marker
        result.toolCounts.set(block.name, (result.toolCounts.get(block.name) ?? 0) + 1);
        classifyTool(result.activity, block);
        if ((block.name === 'Agent' || block.name === 'Task') && block.input) {
          result.agentSpawns.set(block.id, {
            description: block.input.description ?? '',
            subagentType: block.input.subagent_type ?? 'general-purpose',
            stage,
          });
        }
      }
    }

    // usage — once per unique message.id
    const id = msg.id;
    if (!id || !msg.usage || result.messages.has(id)) continue;
    const model = msg.model ?? 'unknown';
    if (model === '<synthetic>') continue;
    const usage = normalizeUsage(msg.usage);
    const cost = costOf(model, usage);
    result.messages.set(id, { model, stage, usage, cost });
  }

  closeSegment();
  // drop dedupe markers from toolCounts
  for (const key of result.toolCounts.keys()) if (key.startsWith('seen:')) result.toolCounts.delete(key);
  return result;
}

function classifyTool(activity, block) {
  const name = block.name;
  if (TOOL_CATEGORIES.research.has(name)) activity.research += 1;
  else if (TOOL_CATEGORIES.investigation.has(name)) activity.investigation += 1;
  else if (TOOL_CATEGORIES.implementation.has(name)) activity.implementation += 1;
  else if (name === 'Bash') {
    const cmd = String(block.input?.command ?? '');
    if (TEST_BUILD_RE.test(cmd)) activity.tests += 1;
    else activity.otherBash += 1;
  }
}

function extractUserText(message) {
  if (!message) return null;
  let text = null;
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) {
    const t = message.content.find((b) => b?.type === 'text' && b.text);
    text = t?.text ?? null;
  }
  if (!text) return null;
  // strip harness noise so the excerpt shows the human's actual ask
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .trim();
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------
function listSessionFiles(projectDir) {
  return fs
    .readdirSync(projectDir)
    .filter((f) => SESSION_FILE_RE.test(f))
    .map((f) => {
      const full = path.join(projectDir, f);
      return { file: full, uuid: f.replace('.jsonl', ''), mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function quickTitle(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let title = null;
  for await (const line of rl) {
    if (!line.includes('"ai-title"') && !line.includes('"agent-name"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle;
      else if (obj.type === 'agent-name' && obj.agentName && !title) title = obj.agentName;
    } catch {
      /* skip */
    }
  }
  return title;
}

async function resolveSession(projectDir, selector) {
  const sessions = listSessionFiles(projectDir);
  if (sessions.length === 0) throw new Error(`no session transcripts found in ${projectDir}`);
  if (!selector || selector === 'latest') return sessions[0];
  if (/^[0-9a-f-]{4,36}$/.test(selector)) {
    const byUuid = sessions.find((s) => s.uuid.startsWith(selector));
    if (byUuid) return byUuid;
  }
  const needle = selector.toLowerCase();
  for (const s of sessions) {
    const title = await quickTitle(s.file);
    if (title && title.toLowerCase().includes(needle)) return { ...s, title };
  }
  throw new Error(`no session matching "${selector}" (by uuid prefix or title) in ${projectDir}`);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fmtInt = (n) => n.toLocaleString('en-US');
const fmtCost = (agg) => {
  if (agg.unpricedTokens > 0 && agg.cost === 0) return 'unpriced';
  const s = `$${agg.cost.toFixed(agg.cost >= 1 ? 2 : 4)}`;
  return agg.unpricedTokens > 0 ? `${s}+` : s;
};
function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return `${Math.round(ms / 1000)}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const fmtTs = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function buildReport(data) {
  const { main, subagents, meta } = data;

  const stageAgg = { plan: emptyAgg(), execution: emptyAgg() };
  const stageSubTokens = { plan: 0, execution: 0 };
  const modelAgg = new Map();

  const bump = (map, model, usage, cost) => {
    if (!map.has(model)) map.set(model, emptyAgg());
    addUsage(map.get(model), usage, cost);
  };

  for (const { model, stage, usage, cost } of main.messages.values()) {
    addUsage(stageAgg[stage], usage, cost);
    bump(modelAgg, model, usage, cost);
  }

  for (const sub of subagents) {
    const stage = sub.stage;
    for (const { model, usage, cost } of sub.parsed.messages.values()) {
      addUsage(stageAgg[stage], usage, cost);
      bump(modelAgg, model, usage, cost);
      stageSubTokens[stage] += totalTokens({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h });
    }
  }

  const total = emptyAgg();
  for (const agg of Object.values(stageAgg)) {
    total.input += agg.input;
    total.output += agg.output;
    total.cacheRead += agg.cacheRead;
    total.cacheWrite5m += agg.cacheWrite5m;
    total.cacheWrite1h += agg.cacheWrite1h;
    total.cost += agg.cost;
    total.unpricedTokens += agg.unpricedTokens;
    total.messages += agg.messages;
  }

  const act = main.activity;
  const spawnList = [...main.agentSpawns.values()];
  const unpricedModels = [...modelAgg.entries()].filter(([m]) => !priceFor(m)).map(([m]) => m);

  const stageRow = (label, agg, subTokens, duration) =>
    `| ${label} | ${fmtInt(agg.input)} | ${fmtInt(agg.output)} | ${fmtInt(agg.cacheRead)} | ${fmtInt(agg.cacheWrite5m + agg.cacheWrite1h)} | ${fmtInt(totalTokens(agg))} | ${fmtInt(subTokens)} | ${duration} | ${fmtCost(agg)} |`;

  const lines = [];
  lines.push(`# Session report: ${meta.title} — ${meta.date}${meta.inProgress ? ' ⏳ *(session in progress)*' : ''}`);
  lines.push('');
  lines.push(`Session \`${meta.uuid}\` · ${fmtTs(main.firstTimestamp)} → ${fmtTs(main.lastTimestamp)} · duration ${fmtDuration((main.lastTimestamp ?? 0) - (main.firstTimestamp ?? 0))}${main.gitBranch ? ` · branch \`${main.gitBranch}\`` : ''}`);
  lines.push('');
  lines.push('## Task');
  lines.push('');
  lines.push('<!-- claude:rewrite — replace this section with a 1–3 sentence summary of what the session was about -->');
  lines.push(`- Session title: ${meta.title}`);
  if (main.firstUserPrompt) lines.push(`- First user prompt (excerpt): "${main.firstUserPrompt.replace(/\n+/g, ' ')}"`);
  lines.push('');
  lines.push('## Process');
  lines.push('');
  lines.push('<!-- claude:rewrite — replace this section with a short prose narrative of how the work unfolded, grounded in the counts below -->');
  lines.push(`- Research (web search/fetch): ${act.research} calls`);
  lines.push(`- Code investigation (read/grep/glob): ${act.investigation} calls`);
  lines.push(`- Implementation (edit/write): ${act.implementation} calls`);
  lines.push(`- Test/build/lint commands: ${act.tests} calls`);
  lines.push(`- Other shell commands: ${act.otherBash} calls`);
  lines.push(`- Subagents spawned: ${spawnList.length}${spawnList.length ? ` (${spawnList.map((s) => `${s.subagentType}: ${s.description || 'unnamed'}`).join('; ')})` : ''}`);
  lines.push('');
  lines.push('## Token usage');
  lines.push('');
  lines.push('| Stage | Input | Output | Cache read | Cache write | Total | of which subagents | Duration | ~Cost |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  if (main.stagesSeen || stageAgg.plan.messages > 0) {
    lines.push(stageRow('Plan', stageAgg.plan, stageSubTokens.plan, fmtDuration(main.stageDurations.plan)));
  }
  lines.push(stageRow('Execution', stageAgg.execution, stageSubTokens.execution, fmtDuration(main.stageDurations.execution)));
  lines.push(stageRow('**TOTAL**', total, stageSubTokens.plan + stageSubTokens.execution, fmtDuration((main.lastTimestamp ?? 0) - (main.firstTimestamp ?? 0))));
  lines.push('');
  lines.push('*Stage rows include tokens of subagents spawned during that stage. Durations are main-thread wall clock.*');
  lines.push('');
  lines.push('## Per model');
  lines.push('');
  lines.push('| Model | API calls | Input | Output | Cache read | Cache write | ~Cost |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [model, agg] of [...modelAgg.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    lines.push(`| \`${model}\` | ${fmtInt(agg.messages)} | ${fmtInt(agg.input)} | ${fmtInt(agg.output)} | ${fmtInt(agg.cacheRead)} | ${fmtInt(agg.cacheWrite5m + agg.cacheWrite1h)} | ${fmtCost(agg)} |`);
  }
  lines.push('');
  lines.push('## Per subagent');
  lines.push('');
  if (subagents.length === 0) {
    lines.push('*No subagents were spawned in this session.*');
  } else {
    lines.push('| Agent | Task | Stage | Tokens | Duration | ~Cost |');
    lines.push('|---|---|---|---:|---:|---:|');
    for (const sub of subagents) {
      const agg = emptyAgg();
      for (const { usage, cost } of sub.parsed.messages.values()) addUsage(agg, usage, cost);
      const dur = (sub.parsed.lastTimestamp ?? 0) - (sub.parsed.firstTimestamp ?? 0);
      lines.push(`| ${sub.agentType} | ${sub.description || '—'} | ${sub.stage} | ${fmtInt(totalTokens(agg))} | ${fmtDuration(dur)} | ${fmtCost(agg)} |`);
    }
  }
  lines.push('');
  lines.push('## Cost estimate');
  lines.push('');
  lines.push(`**Approximate total: ${fmtCost(total)}** (${fmtInt(totalTokens(total))} tokens across ${fmtInt(total.messages)} API calls)`);
  lines.push('');
  if (unpricedModels.length > 0) {
    lines.push(`> ⚠️ No pricing known for: ${unpricedModels.map((m) => `\`${m}\``).join(', ')} — their tokens are counted but excluded from the cost figure.`);
    lines.push('');
  }
  lines.push(`> Cost is an approximation from Anthropic API list prices as of ${PRICING_AS_OF}`);
  lines.push(`> (cache read = ${CACHE_READ_MULTIPLIER}× input, cache write = ${CACHE_WRITE_5M_MULTIPLIER}×/5m or ${CACHE_WRITE_1H_MULTIPLIER}×/1h input).`);
  lines.push('> On a subscription plan (Pro/Max) the marginal cost is $0 — read this as "API-equivalent value".');
  lines.push('');
  return { markdown: lines.join('\n'), stageAgg, stageSubTokens, modelAgg, total };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = projectSlug(args.project ?? process.cwd());
  const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
  if (!fs.existsSync(projectDir)) throw new Error(`project transcript dir not found: ${projectDir}`);

  const session = await resolveSession(projectDir, args.session);
  const parsed = await parseTranscript(session.file);

  // subagents
  const subagentsDir = path.join(projectDir, session.uuid, 'subagents');
  const subagents = [];
  if (fs.existsSync(subagentsDir)) {
    for (const f of fs.readdirSync(subagentsDir)) {
      if (!/^agent-[0-9a-f]+\.jsonl$/.test(f)) continue;
      const agentFile = path.join(subagentsDir, f);
      const metaFile = agentFile.replace(/\.jsonl$/, '.meta.json');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      } catch {
        /* meta optional */
      }
      const spawn = meta.toolUseId ? parsed.agentSpawns.get(meta.toolUseId) : undefined;
      subagents.push({
        file: agentFile,
        agentType: meta.agentType ?? spawn?.subagentType ?? 'unknown',
        description: meta.description ?? spawn?.description ?? '',
        stage: spawn?.stage ?? 'execution',
        parsed: await parseTranscript(agentFile),
      });
    }
  }

  const title = parsed.title ?? session.title ?? session.uuid;
  const date = parsed.firstTimestamp ? new Date(parsed.firstTimestamp).toISOString().slice(0, 10) : 'unknown-date';
  const inProgress = Date.now() - session.mtime < IN_PROGRESS_WINDOW_MS;
  const meta = { title, date, uuid: session.uuid, inProgress };

  const report = buildReport({ main: parsed, subagents, meta });

  const outDir = args.out ?? path.join(os.homedir(), '.claude', 'token-reports', slug);
  fs.mkdirSync(outDir, { recursive: true });
  const safeTitle = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || session.uuid;
  const outFile = path.join(outDir, `${safeTitle}-${date}.md`);
  fs.writeFileSync(outFile, report.markdown);

  if (args.json) {
    const aggJson = (agg) => ({ ...agg, totalTokens: totalTokens(agg) });
    console.log(
      JSON.stringify(
        {
          reportFile: outFile,
          session: { uuid: session.uuid, title, date, inProgress, branch: parsed.gitBranch, cliVersion: parsed.version },
          timing: {
            start: parsed.firstTimestamp,
            end: parsed.lastTimestamp,
            durationMs: (parsed.lastTimestamp ?? 0) - (parsed.firstTimestamp ?? 0),
            stageDurationsMs: parsed.stageDurations,
          },
          stages: {
            plan: { ...aggJson(report.stageAgg.plan), subagentTokens: report.stageSubTokens.plan },
            execution: { ...aggJson(report.stageAgg.execution), subagentTokens: report.stageSubTokens.execution },
          },
          models: Object.fromEntries([...report.modelAgg.entries()].map(([m, a]) => [m, aggJson(a)])),
          subagents: subagents.map((s) => {
            const agg = emptyAgg();
            for (const { usage, cost } of s.parsed.messages.values()) addUsage(agg, usage, cost);
            return {
              agentType: s.agentType,
              description: s.description,
              stage: s.stage,
              ...aggJson(agg),
              durationMs: (s.parsed.lastTimestamp ?? 0) - (s.parsed.firstTimestamp ?? 0),
            };
          }),
          total: aggJson(report.total),
          activity: parsed.activity,
          pricingAsOf: PRICING_AS_OF,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Report written: ${outFile}`);
    console.log(`Total: ${fmtInt(totalTokens(report.total))} tokens · ${fmtCost(report.total)}`);
  }
}

main().catch((err) => {
  console.error(`session-token-report: ${err.message}`);
  process.exit(1);
});
