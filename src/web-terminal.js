#!/usr/bin/env node
const http = require('http');
const { URL } = require('url');
const Anthropic = require('@anthropic-ai/sdk').default;

// ── Config from env ──────────────────────────────────────────────
const HOST = process.env.WEB_TERMINAL_HOST || '0.0.0.0';
const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '8000', 10);
const FNS_BASE_URL = (process.env.FNS_BASE_URL || 'http://20.205.107.61:9000').replace(/\/+$/, '');
const FNS_TOKEN = process.env.FNS_TOKEN || '';
const DEFAULT_VAULT = process.env.FNS_DEFAULT_VAULT || 'Life-Learing';
const TASKS_PREFIX = process.env.FNS_TASKS_PREFIX || '000 PARA/020 Areas/AI任务/';
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Shanghai';
process.env.TZ = process.env.TZ || APP_TIME_ZONE;

const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'deepseek-v4-pro';
const CLAUDE_MODELS = (process.env.ANTHROPIC_MODELS || process.env.CLAUDE_MODELS || DEFAULT_CLAUDE_MODEL)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
const JOB_HISTORY_LIMIT = parseInt(process.env.JOB_HISTORY_LIMIT || '20', 10);
const MAX_TOOL_ROUNDS = parseInt(process.env.CLAUDE_MAX_TOOL_ROUNDS || '5', 10);

const jobs = [];
let activeJob = null;

// ── Anthropic client ─────────────────────────────────────────────
const anthropic = ANTHROPIC_AUTH_TOKEN
  ? new Anthropic({ apiKey: ANTHROPIC_AUTH_TOKEN, baseURL: ANTHROPIC_BASE_URL })
  : null;

// ── FNS tool definitions for Claude ──────────────────────────────
const FNS_TOOLS = [
  {
    name: 'fns_health',
    description: '检查 FNS 笔记服务的健康状态。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fns_vaults',
    description: '列出所有可用的 vault（笔记库）。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fns_list',
    description: '列出指定 vault 中的笔记列表。仅在用户明确要求浏览列表时使用。',
    input_schema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
        page: { type: 'integer', description: '页码，默认 1' },
      },
      required: [],
    },
  },
  {
    name: 'fns_search',
    description: `在笔记中搜索关键词。这是查找笔记的首选方式——提取 1-3 个关键词精准查询。`,
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'fns_folder',
    description: `列出指定文件夹前缀下的笔记。用于查看任务范式时使用前缀 "${TASKS_PREFIX}"。`,
    input_schema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: '文件夹路径前缀' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['prefix'],
    },
  },
  {
    name: 'fns_get',
    description: '获取指定路径笔记的完整内容。修改笔记前应先读取。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记完整路径，如 "folder/note.md"' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['path'],
    },
  },
  {
    name: 'fns_save',
    description: '创建新笔记或覆盖已有笔记的完整内容。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记完整路径' },
        content: { type: 'string', description: '笔记的完整 Markdown 内容' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fns_append',
    description: '在笔记末尾追加内容。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记完整路径' },
        content: { type: 'string', description: '要追加的内容' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fns_prepend',
    description: '在笔记开头插入内容。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记完整路径' },
        content: { type: 'string', description: '要插入的内容' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fns_replace',
    description: '替换笔记中的指定文本。需提供精确的旧文本和新文本。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '笔记完整路径' },
        old: { type: 'string', description: '要被替换的旧文本（需精确匹配）' },
        new: { type: 'string', description: '替换后的新文本' },
        vault: { type: 'string', description: `Vault 名称，默认 ${DEFAULT_VAULT}` },
      },
      required: ['path', 'old', 'new'],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function fnsRequest(path, { method = 'GET', params, body } = {}) {
  if (!FNS_TOKEN) throw new Error('FNS_TOKEN is required');
  const url = new URL(FNS_BASE_URL + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${FNS_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok) throw new Error((data && data.message) || text || `HTTP ${resp.status}`);
  return data;
}

function unwrap(data) {
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}

function appNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
    timeZone: APP_TIME_ZONE,
  };
}

// ── System prompt builder ────────────────────────────────────────

function buildSystemPrompt(task) {
  const now = appNow();
  const taskBlock = task?.content
    ? `\n本次必须优先遵守以下任务范式，来自笔记：${task.path}\n\n${task.content}\n`
    : '\n本次未选择任务范式，按默认笔记助理原则执行。\n';

  return `你是我的手机笔记助理。用户会用自然语言描述要记录、查询、整理或修改的内容。

你必须自己决定要搜索、读取、追加、替换还是新建笔记。你可以使用提供的工具来操作 FNS 笔记服务。

默认 vault 是 "${DEFAULT_VAULT}"。核心原则：
- 不要全库遍历。需要找笔记时，根据用户输入提取 1-3 个关键词，用 fns_search 精准查询。
- 修改笔记前必须先读取（fns_get）。
- 只有用户明确要求浏览列表时才使用 fns_list。
- 涉及任务范式时使用 fns_folder 查询 "${TASKS_PREFIX}" 文件夹。
- 完成后用中文简短说明你修改了哪条笔记、写入了什么。

当前日期是 ${now.date}，当前时间是 ${now.time}，时区是 ${now.timeZone}。
用户提到"明天"、"下周"等相对日期时，请按这个时区换算成明确日期写入笔记。
${taskBlock}`;
}

// ── Tool execution ───────────────────────────────────────────────

async function executeToolCall(name, input) {
  const vault = input.vault || DEFAULT_VAULT;
  switch (name) {
    case 'fns_health':
      return await fnsRequest('/api/health');
    case 'fns_vaults':
      return await fnsRequest('/api/vault');
    case 'fns_list':
      return await fnsRequest('/api/notes', { params: { vault, page: input.page || 1 } });
    case 'fns_search':
      return await fnsRequest('/api/notes', {
        params: { vault, keyword: input.keyword, searchContent: true, page: 1 },
      });
    case 'fns_folder': {
      const prefix = input.prefix || '';
      const keyword = prefix.split('/').filter(Boolean).at(-1) || prefix;
      const result = await fnsRequest('/api/notes', {
        params: { vault, keyword, searchContent: false, page: 1 },
      });
      const data = unwrap(result);
      const list = Array.isArray(data) ? data : (data?.list || []);
      const filtered = list.filter((note) => String(note.path || '').startsWith(prefix));
      return { ...result, data: { ...(result.data || {}), list: filtered, total: filtered.length } };
    }
    case 'fns_get':
      return await fnsRequest('/api/note', { params: { vault, path: input.path } });
    case 'fns_save':
      return await fnsRequest('/api/note', {
        method: 'POST', body: { vault, path: input.path, content: input.content || '' },
      });
    case 'fns_append':
      return await fnsRequest('/api/note/append', {
        method: 'POST', body: { vault, path: input.path, content: input.content || '' },
      });
    case 'fns_prepend':
      return await fnsRequest('/api/note/prepend', {
        method: 'POST', body: { vault, path: input.path, content: input.content || '' },
      });
    case 'fns_replace':
      return await fnsRequest('/api/note/replace', {
        method: 'POST', body: { vault, path: input.path, old: input.old || '', new: input.new || '' },
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Model normalization ──────────────────────────────────────────

function normalizeModel(model) {
  if (!model) return DEFAULT_CLAUDE_MODEL;
  return CLAUDE_MODELS.includes(model) ? model : DEFAULT_CLAUDE_MODEL;
}

// ── Run Claude with tool-use loop ────────────────────────────────

async function runClaude(userText, task, model) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);

  const messages = [{ role: 'user', content: userText }];
  let reply = '';
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const response = await anthropic.messages.create({
      model: selectedModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
      tools: FNS_TOOLS,
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

    reply = textBlocks.map((b) => b.text).join('\n').trim();

    if (toolBlocks.length === 0) break;

    // Execute each tool call
    const toolResults = [];
    for (const tool of toolBlocks) {
      try {
        const result = await executeToolCall(tool.name, tool.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify({ error: err.message || String(err) }),
          is_error: true,
        });
      }
    }

    // Append assistant + tool results to conversation
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  return reply || '完成';
}

// ── Run Claude with streaming ─────────────────────────────────────

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function runClaudeStreaming(userText, task, model, res) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const messages = [{ role: 'user', content: userText }];
  let fullReply = '';
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const stream = await anthropic.messages.create({
      model: selectedModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: FNS_TOOLS,
      stream: true,
    });

    const contentBlocks = [];
    let currentToolUse = null;
    let currentText = '';

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'text') {
            currentText = '';
          } else if (event.content_block.type === 'tool_use') {
            currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: '' };
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text;
            sseWrite(res, 'text', { delta: event.delta.text });
          } else if (event.delta.type === 'input_json_delta') {
            currentToolUse.input += event.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (currentText) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          if (currentToolUse) {
            try { currentToolUse.input = JSON.parse(currentToolUse.input); } catch {}
            contentBlocks.push({ type: 'tool_use', ...currentToolUse });
            sseWrite(res, 'tool', { name: currentToolUse.name, status: 'running' });
            currentToolUse = null;
          }
          break;
      }
    }

    const toolBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    const textBlocks = contentBlocks.filter((b) => b.type === 'text');
    fullReply = textBlocks.map((b) => b.text).join('\n').trim();

    if (toolBlocks.length === 0) break;

    const toolResults = [];
    for (const tool of toolBlocks) {
      try {
        const result = await executeToolCall(tool.name, tool.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
        sseWrite(res, 'tool', { name: tool.name, status: 'done' });
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: err.message || String(err) }), is_error: true });
        sseWrite(res, 'tool', { name: tool.name, status: 'error', error: err.message || String(err) });
      }
    }

    messages.push({ role: 'assistant', content: contentBlocks });
    messages.push({ role: 'user', content: toolResults });
  }

  sseWrite(res, 'done', { reply: fullReply || '完成' });
}

// ── Job queue ────────────────────────────────────────────────────

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    model: job.model,
    taskPath: job.task?.path || '',
    reply: job.reply || '',
    error: job.error || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
  };
}

function trimJobs() {
  if (jobs.length > JOB_HISTORY_LIMIT) jobs.length = JOB_HISTORY_LIMIT;
}

function enqueueJob({ message, task, model }) {
  const now = appNow();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'queued',
    message,
    task,
    model: normalizeModel(model),
    createdAt: `${now.date} ${now.time}`,
  };
  jobs.unshift(job);
  trimJobs();
  processQueue();
  return job;
}

async function processQueue() {
  if (activeJob) return;
  const job = [...jobs].reverse().find((item) => item.status === 'queued');
  if (!job) return;
  activeJob = job;
  const now = appNow();
  job.status = 'running';
  job.startedAt = `${now.date} ${now.time}`;
  try {
    job.reply = await runClaude(job.message, job.task, job.model);
    job.status = 'done';
  } catch (err) {
    job.error = err.message || String(err);
    job.status = 'failed';
  } finally {
    const finished = appNow();
    job.finishedAt = `${finished.date} ${finished.time}`;
    activeJob = null;
    processQueue();
  }
}

// ── HTML UI ──────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Claude Notes</title>
  <style>
    :root{--bg:#0c0f10;--panel:#151917;--panel-2:#101413;--line:#2a332f;--line-soft:#202824;--text:#f7f3ea;--muted:#a8b0a7;--accent:#d4a574;--accent-2:#daa520;--ok:#8fe5a7;--bad:#ff9187;--shadow:0 18px 60px rgba(0,0,0,.34)}
    *{box-sizing:border-box}
    html,body{height:100%;max-width:100%;overflow-x:hidden}
    body{width:100%;margin:0;background:radial-gradient(circle at 18% -10%,rgba(218,165,32,.12),transparent 28%),linear-gradient(180deg,#151917 0,#0c0f10 48%,#080a0a 100%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .app{width:100%;max-width:100vw;min-width:0;min-height:100%;min-height:100dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow-x:hidden}
    header{z-index:3;padding:12px max(14px,env(safe-area-inset-left)) 12px max(14px,env(safe-area-inset-right));border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto;gap:10px 12px;background:rgba(12,15,16,.86);position:sticky;top:0;backdrop-filter:blur(16px)}
    .brand{display:flex;align-items:center;gap:10px;min-width:0}
    .mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 10px 30px rgba(218,165,32,.18);display:grid;place-items:center;color:#0b100e;font-weight:900}
    h1{font-size:17px;margin:0;font-weight:780;letter-spacing:0}
    .subtitle{font-size:12px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;max-width:100%}
    .state{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 10px;white-space:nowrap;background:rgba(255,255,255,.03)}
    main{padding:14px;overflow:auto;min-width:0}
    .tasks{width:100%;min-width:0;border-bottom:1px solid var(--line);background:rgba(18,22,20,.78);padding:10px 12px;box-shadow:var(--shadow)}
    .task-panel{width:100%;max-width:880px;min-width:0;margin:0 auto}
    .task-panel summary{height:42px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;color:var(--text);font-weight:720}
    .task-panel summary::-webkit-details-marker{display:none}
    .summary-title{display:flex;align-items:center;gap:8px;min-width:0}
    .summary-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-2);box-shadow:0 0 0 4px rgba(218,165,32,.12)}
    .summary-path{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw}
    .tasks-inner{display:grid;gap:10px;padding-top:2px}
    .task-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
    select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 10px;font:inherit;min-width:0;max-width:100%;outline:none;text-overflow:ellipsis}
    select:focus,textarea:focus{border-color:rgba(212,165,116,.65);box-shadow:0 0 0 3px rgba(212,165,116,.12)}
    .task-editor{min-height:118px;max-height:220px}
    .thread{width:100%;max-width:880px;min-width:0;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
    .msg{border:1px solid var(--line-soft);border-radius:8px;padding:12px 13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.04);box-shadow:0 8px 24px rgba(0,0,0,.12)}
    .msg.user{margin-left:auto;max-width:min(760px,92%);background:rgba(212,165,116,.1);border-color:rgba(212,165,116,.28)}
    .msg.assistant{margin-right:auto;max-width:min(820px,100%);background:rgba(255,255,255,.045)}
    .meta{font-size:12px;color:var(--muted);margin-bottom:4px}
    form{width:100%;min-width:0;z-index:2;padding:10px max(12px,env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-right));border-top:1px solid var(--line);background:rgba(12,15,16,.9);backdrop-filter:blur(16px)}
    .bar{width:100%;max-width:880px;min-width:0;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
    textarea{width:100%;min-height:54px;max-height:160px;resize:none;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:12px;outline:none;font:inherit;line-height:1.45}
    button{height:54px;min-width:76px;border:0;border-radius:8px;background:var(--accent);color:#0d120f;font-weight:800;font:inherit;cursor:pointer}
    button:hover{filter:brightness(1.03)}
    .small{height:42px;min-width:64px}
    button:disabled{opacity:.45}
    .chips,.jobs{width:100%;max-width:880px;min-width:0;margin:0 auto 8px;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
    .chips::-webkit-scrollbar,.jobs::-webkit-scrollbar{display:none}
    .chip{height:36px;min-width:0;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--muted);border-radius:999px;padding:0 12px;font-size:13px;white-space:nowrap;font-weight:650}
    .job{height:32px;min-width:0;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(255,255,255,.03);padding:0 10px;font-size:12px;white-space:nowrap;font-weight:650}
    .job.running{color:var(--accent);border-color:rgba(218,165,32,.35)}
    .job.done{color:var(--ok)}
    .job.failed{color:var(--bad)}
    .typing-dots{display:inline-flex;gap:3px;align-items:center}
    .typing-dots span{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:dotPulse 1.2s infinite}
    .typing-dots span:nth-child(2){animation-delay:.2s}
    .typing-dots span:nth-child(3){animation-delay:.4s}
    @keyframes dotPulse{0%,60%{opacity:.2}30%{opacity:1}}
    .tool-note{font-size:12px;color:var(--muted);margin-top:6px;font-style:italic}
    @media (min-width: 960px){
      html,body{overflow:hidden}
      .app{height:100dvh;grid-template-columns:minmax(300px,370px) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}
      header{grid-column:1 / -1}
      .tasks{grid-column:1;grid-row:2 / 4;border-right:1px solid var(--line);border-bottom:0;padding:16px;overflow:auto;box-shadow:none}
      .task-panel{max-width:none}
      .task-panel summary{cursor:default}
      .summary-path{max-width:210px}
      .tasks-inner{padding-top:10px}
      .task-row{grid-template-columns:1fr}
      .small{width:100%}
      .task-editor{min-height:calc(100dvh - 290px);max-height:none}
      main{grid-column:2;grid-row:2;padding:18px 20px}
      form{grid-column:2;grid-row:3;padding:12px 20px 16px}
    }
    @media (max-width: 640px){
      header{grid-template-columns:1fr;position:sticky;padding:10px 10px 8px}
      .controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"model state";width:100%;gap:6px}
      #modelSelect{grid-area:model}
      .state{grid-area:state;height:28px;display:flex;align-items:center;justify-content:center;padding-inline:7px;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .tasks{padding:6px 12px}
      .task-panel:not([open]) summary{height:38px}
      .summary-path{max-width:54vw}
      .task-editor{min-height:104px;max-height:160px}
      main{padding:12px}
      .msg{padding:11px 12px}
      form{padding-top:8px}
      .chips{margin-bottom:8px}
      .chip{height:34px;font-size:12px}
      .bar{grid-template-columns:1fr}
      #send{width:100%;height:46px}
      textarea{min-height:50px}
    }
    @media (max-width: 380px){
      .brand{gap:8px}
      .mark{width:28px;height:28px}
      h1{font-size:16px}
      .subtitle{font-size:11px}
      .controls{grid-template-columns:1fr;grid-template-areas:"model" "state"}
      select{height:38px;font-size:13px}
      .summary-path{max-width:45vw}
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="brand"><div class="mark">C</div><div><h1>Claude Notes</h1><div class="subtitle">手机笔记助理</div></div></div>
      <div class="controls"><select id="modelSelect"></select><div class="state" id="state">ready</div></div>
    </header>
    <section class="tasks">
      <details class="task-panel" id="taskPanel" open>
        <summary><span class="summary-title"><span class="summary-dot"></span><span>任务范式</span></span><span class="summary-path" id="taskSummary">未选择</span></summary>
        <div class="tasks-inner">
          <div class="task-row"><select id="taskSelect"></select><button class="small" id="saveTask" type="button">保存</button></div>
          <textarea class="task-editor" id="taskEditor" placeholder="选择 AI任务 文件夹下的 Markdown"></textarea>
        </div>
      </details>
    </section>
    <main><div class="thread" id="thread"><div class="msg assistant welcome"><div class="meta">Claude</div><span class="stream-text">直接输入要做的事。</span></div></div></main>
    <form id="form">
      <div class="jobs" id="jobs"></div>
      <div class="chips">
        <button class="chip" id="clearHistory" type="button">清除历史</button>
      </div>
      <div class="bar"><textarea id="input" placeholder="输入一句话"></textarea><button id="send">发送</button></div>
    </form>
  </div>
  <script>
    const thread = document.getElementById('thread');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const state = document.getElementById('state');
    const modelSelect = document.getElementById('modelSelect');
    const taskSelect = document.getElementById('taskSelect');
    const taskEditor = document.getElementById('taskEditor');
    const taskPanel = document.getElementById('taskPanel');
    const taskSummary = document.getElementById('taskSummary');
    const saveTask = document.getElementById('saveTask');
    const jobsEl = document.getElementById('jobs');
    const clearHistory = document.getElementById('clearHistory');
    let activeTaskPath = '';
    const seenDone = new Set();
    const streamedJobs = new Set();
    const taskMedia = window.matchMedia('(min-width: 960px)');
    function syncMobileTaskPanel() {
      taskPanel.open = taskMedia.matches;
    }
    syncMobileTaskPanel();
    taskMedia.addEventListener('change', syncMobileTaskPanel);
    function escapeHtml(text) {
      return text.replace(/[&<>]/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; });
    }
    function classifyError(errMsg) {
      var msg = (errMsg || '').toLowerCase();
      // Network errors
      if (/fetch failed|econnrefused|enotfound|econnreset|etimedout|network|abort/i.test(msg)) {
        return { category: 'network', hint: '网络连接失败，请检查网络后重试', retry: true };
      }
      // Auth errors
      if (/401|unauthorized|token|auth|expired|jwt|bearer/i.test(msg)) {
        return { category: 'auth', hint: '认证失败，Token 可能已过期，请在 local.config.sh 中更新 FNS_TOKEN', retry: false };
      }
      // FNS errors
      if (/fns|vault|note.*fail/i.test(msg)) {
        return { category: 'fns', hint: '笔记服务暂时不可用，请稍后重试', retry: true };
      }
      // Rate limit / model errors
      if (/429|rate.?limit|overloaded|capacity/i.test(msg)) {
        return { category: 'rate', hint: 'AI 服务繁忙，请稍后重试', retry: true };
      }
      if (/400|bad request|invalid/i.test(msg)) {
        return { category: 'badreq', hint: '请求格式有误，请重试', retry: false };
      }
      // Generic fallback — preserve the original for debugging
      return { category: 'unknown', hint: '出错了：' + (errMsg || '未知错误'), retry: false };
    }
    function showErrorBubble(err, retryFn) {
      var classified = classifyError(err.message || String(err));
      var text = classified.hint;
      if (classified.retry && retryFn) {
        text += ' <button class="retry-btn" type="button">重试</button>';
      }
      var div = add('assistant', text);
      saveHistory();
      if (classified.retry && retryFn && div) {
        div.querySelector('.retry-btn')?.addEventListener('click', retryFn);
      }
      return classified;
    }
    var CHAT_STORAGE_KEY = 'autoobsidian_chat_history';
    function saveHistory() {
      var items = [];
      thread.querySelectorAll('.msg').forEach(function(el) {
        var meta = el.querySelector('.meta');
        var streamText = el.querySelector('.stream-text');
        if (meta && streamText) {
          var role = meta.textContent === '你' ? 'user' : 'assistant';
          items.push({ role: role, text: streamText.textContent });
        }
      });
      try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(items)); } catch(e) {}
    }
    function loadHistory() {
      try {
        var raw = localStorage.getItem(CHAT_STORAGE_KEY);
        if (!raw) return false;
        var items = JSON.parse(raw);
        if (!Array.isArray(items) || items.length === 0) return false;
        thread.innerHTML = '';
        items.forEach(function(item) { add(item.role, item.text); });
        return true;
      } catch(e) { return false; }
    }
    function add(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = '<div class="meta">' + (role === 'user' ? '你' : 'Claude') + '</div><span class="stream-text">' + escapeHtml(text) + '</span>';
      thread.appendChild(div);
      div.scrollIntoView({block:'end'});
      // Remove the initial welcome message if it's still there (first real message)
      var welcome = thread.querySelector('.msg.welcome');
      if (welcome && thread.querySelectorAll('.msg').length > 1) welcome.remove();
      saveHistory();
      return div;
    }
    function addStreamingBubble(role) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const metaText = role === 'user' ? '你' : 'Claude';
      div.innerHTML = '<div class="meta">' + metaText + '</div><span class="stream-text"></span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
      thread.appendChild(div);
      div.scrollIntoView({block:'end'});
      var textEl = div.querySelector('.stream-text');
      var dotsEl = div.querySelector('.typing-dots');
      return {
        div: div,
        appendText: function(delta) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          textEl.textContent += delta;
          div.scrollIntoView({block:'end'});
        },
        setText: function(text) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          textEl.textContent = text;
          div.scrollIntoView({block:'end'});
        },
        showTool: function(name) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          var toolNote = div.querySelector('.tool-note');
          if (!toolNote) {
            toolNote = document.createElement('div');
            toolNote.className = 'tool-note';
            div.appendChild(toolNote);
          }
          toolNote.textContent = '🔧 ' + name + '...';
          div.scrollIntoView({block:'end'});
        },
        finishTool: function(name, ok) {
          var toolNote = div.querySelector('.tool-note');
          if (toolNote) toolNote.textContent = (ok ? '✅ ' : '❌ ') + name;
        },
        finalize: function() {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          var toolNote = div.querySelector('.tool-note');
          if (toolNote) toolNote.remove();
          saveHistory();
        }
      };
    }
    var streamingAbort = null;
    async function submit(text) {
      // Abort any in-progress streaming request
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; }
      var prompt = text.trim();
      if (!prompt) return;
      input.value = '';
      add('user', prompt);
      state.textContent = 'thinking';
      send.disabled = true;
      var bubble = addStreamingBubble('assistant');
      var fullText = '';

      try {
        // Try SSE streaming first
        var resp = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: prompt, taskPath: activeTaskPath, taskContent: taskEditor.value, model: modelSelect.value}),
          signal: (streamingAbort = new AbortController()).signal
        });

        if (!resp.ok) {
          var errData = await resp.json().catch(function() { return {error: 'HTTP ' + resp.status}; });
          throw new Error(errData.error || '请求失败');
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream: true});
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';

          var eventType = '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                var data = JSON.parse(line.slice(6));
                if (eventType === 'meta') {
                  streamedJobs.add(data.jobId);
                } else if (eventType === 'text') {
                  fullText += data.delta;
                  bubble.appendText(data.delta);
                } else if (eventType === 'tool') {
                  if (data.status === 'running') bubble.showTool(data.name);
                  else if (data.status === 'done') bubble.finishTool(data.name, true);
                  else if (data.status === 'error') bubble.finishTool(data.name, false);
                } else if (eventType === 'error') {
                  bubble.setText('失败：' + escapeHtml(data.message));
                }
              } catch(e) {}
              eventType = '';
            }
          }
        }
        bubble.finalize();
        if (!fullText.trim()) bubble.setText('完成');
        state.textContent = 'ready';
      } catch (err) {
        if (err.name === 'AbortError') {
          bubble.setText('[已取消]');
        } else {
          // Fallback: use job queue
          try {
            bubble.finalize();
            var fallback = addStreamingBubble('assistant');
            var jobResp = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: prompt, taskPath: activeTaskPath, taskContent: taskEditor.value, model: modelSelect.value})});
            var jobData = await jobResp.json();
            if (!jobResp.ok) throw new Error(jobData.error || '请求失败');
            fallback.setText('已入队：' + jobData.job.id + '（' + jobData.job.model + '）…轮询中');
            var pollId = setInterval(async function() {
              try {
                var pollResp = await fetch('/api/jobs');
                var pollData = await pollResp.json();
                var found = pollData.jobs.find(function(j) { return j.id === jobData.job.id; });
                if (found && (found.status === 'done' || found.status === 'failed')) {
                  clearInterval(pollId);
                  fallback.finalize();
                  if (found.status === 'done') add('assistant', found.reply);
                  else add('assistant', '失败：' + found.error);
                }
              } catch(e) {}
            }, 2000);
          } catch (fallbackErr) {
            add('assistant', '失败：' + (fallbackErr.message || '未知错误'));
          }
        }
        state.textContent = 'ready';
      } finally {
        send.disabled = false;
        input.focus();
        streamingAbort = null;
      }
    }
    form.addEventListener('submit', function(e) { e.preventDefault(); submit(input.value); });
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); } });
    document.querySelectorAll('.chip:not(#clearHistory)').forEach(function(btn) { btn.addEventListener('click', function() { submit(btn.textContent); }); });
    async function loadConfig() {
      const resp = await fetch('/api/config');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '加载配置失败');
      modelSelect.innerHTML = data.models.map(function(model) { return '<option value="' + model + '">' + model + '</option>'; }).join('');
      modelSelect.value = data.defaultModel;
    }
    async function loadJobs() {
      const resp = await fetch('/api/jobs');
      const data = await resp.json();
      if (!resp.ok) return;
      jobsEl.innerHTML = data.jobs.slice(0, 8).map(function(job) {
        if (streamedJobs.has(job.id)) return '';
        return '<button class="job ' + job.status + '" type="button" data-id="' + job.id + '">' + job.status + ' · ' + job.model + '</button>';
      }).filter(Boolean).join('');
      data.jobs.forEach(function(job) {
        if (streamedJobs.has(job.id)) return;
        if ((job.status === 'done' || job.status === 'failed') && !seenDone.has(job.id)) {
          seenDone.add(job.id);
          add('assistant', job.status === 'done' ? job.reply : ('失败：' + job.error));
        }
      });
    }
    async function loadTasks() {
      state.textContent = 'loading tasks';
      const resp = await fetch('/api/tasks');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '加载任务失败');
      taskSelect.innerHTML = data.tasks.map(function(t) { return '<option value="' + t.path.replace(/"/g,'&quot;') + '">' + t.name + '</option>'; }).join('');
      if (data.tasks[0]) await loadTask(data.tasks[0].path);
      state.textContent = 'ready';
    }
    async function loadTask(path) {
      activeTaskPath = path;
      taskSummary.textContent = path ? path.split('/').pop() : '未选择';
      const resp = await fetch('/api/task?path=' + encodeURIComponent(path));
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '读取任务失败');
      taskEditor.value = data.content || '';
    }
    taskSelect.addEventListener('change', function() { loadTask(taskSelect.value).catch(function(err) { state.textContent = 'error'; add('assistant', '失败：' + err.message); }); });
    clearHistory.addEventListener('click', async function() {
      try {
        const resp = await fetch('/api/jobs/clear', {method:'POST'});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '清除失败');
        seenDone.clear();
        streamedJobs.clear();
        try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch(e) {}
        thread.innerHTML = '<div class="msg assistant welcome"><div class="meta">Claude</div><span class="stream-text">对话已清除，有什么可以帮你的？</span></div>';
        await loadJobs();
      } catch (err) {
        add('assistant', '失败：' + err.message);
      }
    });
    saveTask.addEventListener('click', async function() {
      try {
        state.textContent = 'saving';
        const resp = await fetch('/api/task', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path: activeTaskPath, content: taskEditor.value})});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '保存失败');
        state.textContent = 'ready';
        add('assistant', '已保存任务范式：' + activeTaskPath);
      } catch (err) {
        state.textContent = 'error';
        add('assistant', '失败：' + err.message);
      }
    });
    // Load saved chat history first (instant, no network)
    loadHistory();
    Promise.all([loadConfig(), loadTasks(), loadJobs()]).catch(function(err) { state.textContent = 'error'; add('assistant', '失败：' + err.message); });
    setInterval(loadJobs, 2500);
  </script>
</body>
</html>`;

// ── HTTP Server ──────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        // Also create a job record for history
        const job = enqueueJob({ message: body.message, task, model: body.model });
        sseWrite(res, 'meta', { jobId: job.id, model: normalizeModel(body.model) });
        await runClaudeStreaming(body.message, task, body.model, res);
      } catch (err) {
        sseWrite(res, 'error', { message: err.message || String(err) });
      }
      res.end();
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      const job = enqueueJob({ message: body.message, task, model: body.model });
      json(res, 202, { job: serializeJob(job) });
      return;
    }
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      json(res, 200, { activeJob: activeJob ? activeJob.id : null, jobs: jobs.map(serializeJob) });
      return;
    }
    if (url.pathname === '/api/jobs/clear' && req.method === 'POST') {
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].status === 'done' || jobs[i].status === 'failed') jobs.splice(i, 1);
      }
      trimJobs();
      json(res, 200, { ok: true, jobs: jobs.map(serializeJob) });
      return;
    }
    if (url.pathname === '/api/job' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error('job not found');
      json(res, 200, { job: serializeJob(job) });
      return;
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      json(res, 200, {
        defaultModel: DEFAULT_CLAUDE_MODEL,
        models: CLAUDE_MODELS,
        jobHistoryLimit: JOB_HISTORY_LIMIT,
      });
      return;
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const taskKeyword = TASKS_PREFIX.split('/').filter(Boolean).at(-1) || TASKS_PREFIX;
      const data = unwrap(await fnsRequest('/api/notes', { params: { vault: DEFAULT_VAULT, keyword: taskKeyword, searchContent: false, page: 1 } }));
      const list = Array.isArray(data) ? data : (data?.list || []);
      let tasks = list
        .filter((note) => String(note.path || '').startsWith(TASKS_PREFIX) && String(note.path || '').toLowerCase().endsWith('.md'))
        .map((note) => ({ path: note.path, name: String(note.path).slice(TASKS_PREFIX.length) }));
      if (tasks.length === 0) {
        const defaultPath = `${TASKS_PREFIX}默认范式.md`;
        const defaultContent = `# 默认范式\n\n- 先理解用户意图，再选择最少的笔记操作。\n- 不要全库遍历；先根据用户输入提取关键词搜索。\n- 修改前优先读取目标笔记。\n- 完成后说明修改了哪条笔记和写入内容。`;
        await fnsRequest('/api/note', { method: 'POST', body: { vault: DEFAULT_VAULT, path: defaultPath, content: defaultContent } });
        tasks = [{ path: defaultPath, name: '默认范式.md' }];
      }
      json(res, 200, { prefix: TASKS_PREFIX, tasks });
      return;
    }
    if (url.pathname === '/api/task' && req.method === 'GET') {
      const path = url.searchParams.get('path');
      if (!path || !path.startsWith(TASKS_PREFIX)) throw new Error('invalid task path');
      const data = unwrap(await fnsRequest('/api/note', { params: { vault: DEFAULT_VAULT, path } }));
      json(res, 200, { path, content: data?.content || '' });
      return;
    }
    if (url.pathname === '/api/task' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path || !body.path.startsWith(TASKS_PREFIX)) throw new Error('invalid task path');
      await fnsRequest('/api/note', { method: 'POST', body: { vault: DEFAULT_VAULT, path: body.path, content: body.content || '' } });
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/ui/health') {
      json(res, 200, { health: unwrap(await fnsRequest('/api/health')), now: appNow() });
      return;
    }
    if (url.pathname === '/api/ui/vaults') {
      const vaults = unwrap(await fnsRequest('/api/vault'));
      json(res, 200, { vaults });
      return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Notes listening on http://${HOST}:${PORT}`);
  console.log(`FNS: ${FNS_BASE_URL}`);
  console.log(`Default vault: ${DEFAULT_VAULT}`);
  console.log(`Claude model: ${DEFAULT_CLAUDE_MODEL}`);
  if (!ANTHROPIC_AUTH_TOKEN) console.log('WARNING: ANTHROPIC_AUTH_TOKEN is not set — chat will fail');
});
