#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const Anthropic = require('@anthropic-ai/sdk').default;

// ── Config from env ──────────────────────────────────────────────
const HOST = process.env.WEB_TERMINAL_HOST || '0.0.0.0';
const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '8000', 10);
const FNS_BASE_URL = (process.env.FNS_BASE_URL || 'http://127.0.0.1:9000').replace(/\/+$/, '');
const FNS_TOKEN = process.env.FNS_TOKEN || '';
const DEFAULT_VAULT = process.env.FNS_DEFAULT_VAULT || 'Life-Learing';
const TASKS_PREFIX = process.env.FNS_TASKS_PREFIX || '000 PARA/020 Areas/AI任务/';
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Shanghai';
process.env.TZ = process.env.TZ || APP_TIME_ZONE;

const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';
const CLAUDE_MODELS = (process.env.ANTHROPIC_MODELS || DEFAULT_CLAUDE_MODEL)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
const MAX_TOOL_ROUNDS = parseInt(process.env.CLAUDE_MAX_TOOL_ROUNDS || '5', 10);
const JOB_HISTORY_LIMIT = parseInt(process.env.JOB_HISTORY_LIMIT || '20', 10);

// ── Auth config ──────────────────────────────────────────────────
const PASSWORD_HASH = process.env.WEB_ACCESS_PASSWORD_HASH || '';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-me-to-a-random-string';
const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS || '604800000', 10); // 7 days

const jobs = [];
let activeJob = null;

// ── Auth helpers ─────────────────────────────────────────────────
function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader) return map;
  cookieHeader.split(';').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });
  return map;
}

function signToken(payload) {
  const data = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + sig;
}

function verifyToken(token) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const data = Buffer.from(token.slice(0, dot), 'base64').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(data);
    if (payload.expires < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function verifyPassword(password) {
  if (!PASSWORD_HASH) return true; // no password set = open access
  const colon = PASSWORD_HASH.indexOf(':');
  if (colon < 0) return password === PASSWORD_HASH; // plaintext fallback
  const salt = PASSWORD_HASH.slice(0, colon);
  const hash = PASSWORD_HASH.slice(colon + 1);
  const attempt = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(hash));
}

function setAuthCookie(res, username) {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const token = signToken({ username, expires });
  res.setHeader('Set-Cookie', `auth=${token}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; Path=/`);
}

function checkAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies.auth || '');
}

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
    description: '在笔记中搜索关键词。这是查找笔记的首选方式——提取 1-3 个关键词精准查询。',
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

// ── Run Claude with tool-use loop (non-streaming) ────────────────

function buildUserContent(userText, files) {
  if (!files || !files.length) return userText;
  const content = [{ type: 'text', text: userText }];
  for (const f of files) {
    if (f.isImage && f.data) {
      const [mime, b64] = f.data.split(',');
      content.push({ type: 'image', source: { type: 'base64', media_type: f.type || 'image/png', data: b64 || f.data } });
    } else if (f.data) {
      content.push({ type: 'text', text: '\n=== ' + f.name + ' ===\n' + f.data });
    }
  }
  return content;
}

async function runClaude(userText, task, model, jobRef, history, files) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const userContent = buildUserContent(userText, files);

  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: userContent }];
  let reply = '';
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (jobRef && jobRef._aborted) throw new Error('任务已取消');
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

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  return reply || '完成';
}

// ── SSE helpers ──────────────────────────────────────────────────

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Run Claude with streaming ────────────────────────────────────

async function runClaudeStreaming(userText, task, model, res, jobRef, history, files) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const userContent = buildUserContent(userText, files);
  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: userContent }];
  let fullReply = '';
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (jobRef && jobRef._aborted) throw new Error('任务已取消');
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
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify({ error: err.message || String(err) }),
          is_error: true,
        });
        sseWrite(res, 'tool', { name: tool.name, status: 'error', error: err.message || String(err) });
      }
    }

    messages.push({ role: 'assistant', content: contentBlocks });
    messages.push({ role: 'user', content: toolResults });
  }

  sseWrite(res, 'done', { reply: fullReply || '完成' });
  if (jobRef) jobRef.reply = fullReply || '完成';
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

function enqueueJob({ message, task, model, history, files }) {
  const now = appNow();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'queued',
    message,
    task,
    model: normalizeModel(model),
    history: history || [],
    files: files || [],
    createdAt: `${now.date} ${now.time}`,
    _aborted: false,
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
    job.reply = await runClaude(job.message, job.task, job.model, job, job.history, job.files);
    if (job._aborted) return;
    job.status = 'done';
  } catch (err) {
    if (job._aborted) return;
    job.error = err.message || String(err);
    job.status = 'failed';
  } finally {
    const finished = appNow();
    job.finishedAt = `${finished.date} ${finished.time}`;
    activeJob = null;
    processQueue();
  }
}

// ── Login page ───────────────────────────────────────────────────

const loginHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Claude Notes - 登录</title>
  <style>
    :root{--bg:#0c0f10;--panel:#151917;--line:#2a332f;--text:#f7f3ea;--muted:#a8b0a7;--accent:#d4a574;--accent-2:#daa520;--bad:#ff9187}
    *{box-sizing:border-box}
    html,body{height:100%;margin:0}
    body{display:grid;place-items:center;background:radial-gradient(circle at 18% -10%,rgba(218,165,32,.12),transparent 28%),linear-gradient(180deg,#151917 0,#0c0f10 48%,#080a0a 100%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
    .card{width:min(380px,92vw);padding:32px 28px;border:1px solid var(--line);border-radius:12px;background:rgba(21,25,23,.9);backdrop-filter:blur(16px);box-shadow:0 18px 60px rgba(0,0,0,.34)}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}
    .mark{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:grid;place-items:center;color:#0b100e;font-weight:900;font-size:16px}
    h1{font-size:20px;margin:0;font-weight:780}
    .sub{font-size:12px;color:var(--muted);margin-top:2px}
    input{width:100%;height:46px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 14px;font:inherit;outline:none;margin-bottom:12px}
    input:focus{border-color:rgba(212,165,116,.65);box-shadow:0 0 0 3px rgba(212,165,116,.12)}
    button{width:100%;height:46px;border:0;border-radius:8px;background:var(--accent);color:#0d120f;font-weight:800;font:inherit;cursor:pointer;font-size:15px}
    button:hover{filter:brightness(1.03)}
    .err{color:var(--bad);font-size:13px;margin-top:8px;display:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><div class="mark">C</div><div><h1>Claude Notes</h1><div class="sub">手机笔记助理</div></div></div>
    <form id="loginForm">
      <input id="password" type="password" placeholder="输入访问密码" autocomplete="current-password" autofocus />
      <button type="submit">登录</button>
      <div class="err" id="err"></div>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const input = document.getElementById('password');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      try {
        const resp = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({password: input.value})
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '登录失败');
        window.location.href = '/';
      } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

// ── HTML UI ──────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Claude Notes</title>
  <style>
    :root{--bg:#0c0f10;--panel:#151917;--panel-2:#101413;--line:#2a332f;--line-soft:#202824;--text:#f7f3ea;--muted:#a8b0a7;--accent:#d4a574;--accent-2:#64d2c1;--ok:#8fe5a7;--bad:#ff9187;--shadow:0 18px 60px rgba(0,0,0,.34)}
    *{box-sizing:border-box}
    html,body{height:100%;max-width:100%;overflow-x:hidden}
    body{width:100%;margin:0;color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;background:linear-gradient(180deg,#111815 0,#0c0f10 50%,#080a0a 100%)}
    .app{width:100%;max-width:100vw;min-width:0;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;overflow:hidden}
    ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(168,176,167,.2);border-radius:99px}::-webkit-scrollbar-thumb:hover{background:rgba(168,176,167,.35)}
    .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-10px);z-index:99;padding:10px 20px;border-radius:999px;background:rgba(16,20,19,.96);color:var(--ok);border:1px solid rgba(143,229,167,.25);font-size:13px;font-weight:650;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;backdrop-filter:blur(20px);box-shadow:0 4px 24px rgba(0,0,0,.4)}
    .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
    header{z-index:3;padding:8px max(14px,env(safe-area-inset-left)) 8px max(14px,env(safe-area-inset-right));border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:8px;background:rgba(12,15,16,.9);position:sticky;top:0;backdrop-filter:blur(16px);box-shadow:0 1px 8px rgba(0,0,0,.15)}
    .brand{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
    .mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 10px 30px rgba(218,165,32,.18);display:grid;place-items:center;color:#0b100e;font-weight:900;font-size:14px;flex-shrink:0}
    h1{font-size:16px;margin:0;font-weight:780;letter-spacing:0;white-space:nowrap}
    .subtitle{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}
    @media(min-width:400px){.subtitle{display:inline}}
    .model-btn{height:32px;min-width:40px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.03);color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;padding:0 10px;white-space:nowrap}
    .model-btn:hover{border-color:var(--accent-2);color:var(--text)}
    .trash-btn{height:28px;min-width:28px;border:0;background:transparent;color:var(--muted);font-size:14px;cursor:pointer;padding:0;border-radius:6px;display:flex;align-items:center;justify-content:center}
    .trash-btn:hover{color:var(--bad)}
    .trash-btn.confirm{color:var(--bad);animation:pulse .5s ease-in-out infinite}
    .state{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 10px;white-space:nowrap;background:rgba(255,255,255,.03);transition:all .3s}
    .cancel-btn{display:none;height:30px;width:30px;min-width:30px;border:1px solid var(--bad);border-radius:50%;background:transparent;color:var(--bad);font-size:14px;cursor:pointer;padding:0;line-height:1}
    .cancel-btn.visible{display:inline-flex;align-items:center;justify-content:center}
    .state[data-status="running"]{color:var(--accent);border-color:rgba(212,165,116,.45);animation:pulse 1.6s ease-in-out infinite}
    .state[data-status="queued"]{color:var(--accent-2);border-color:rgba(218,165,32,.35)}
    .state[data-status="error"]{color:var(--bad);border-color:rgba(255,145,135,.4)}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
    /* conversation layout */
    .conv-layout{display:flex;min-height:0;flex:1;overflow:hidden;height:100%}
    .conv-sidebar{width:260px;min-width:260px;border-right:1px solid rgba(255,255,255,.04);background:rgba(10,14,13,.55);display:flex;flex-direction:column;overflow:hidden;backdrop-filter:blur(12px)}
    .conv-sidebar-header{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:8px}
    .conv-sidebar-header span{font-size:13px;font-weight:700;color:var(--muted)}
    .conv-list{flex:1;overflow-y:auto;padding:6px 8px}
    .conv-item{padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:3px;transition:all .15s;border:1px solid transparent}
    .conv-item:hover{background:rgba(255,255,255,.03)}
    .conv-item.active{background:rgba(100,210,193,.06);border-color:rgba(100,210,193,.15)}
    .conv-item-title{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .conv-item-meta{font-size:11px;color:var(--muted);margin-top:2px;display:flex;gap:8px}
    .conv-item .status-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0;margin-top:5px}
    .status-dot.running{background:var(--accent-2);animation:pulse 1.2s infinite;box-shadow:0 0 6px rgba(100,210,193,.5)}
    .status-dot.done{background:var(--ok);box-shadow:0 0 4px rgba(143,229,167,.3)}
    .status-dot.failed{background:var(--bad);box-shadow:0 0 4px rgba(255,145,135,.3)}
    .status-dot.queued{background:var(--accent);box-shadow:0 0 4px rgba(212,165,116,.3)}
    #newConvBtn{width:100%;height:36px;margin:8px;border:1px dashed var(--line);border-radius:8px;background:transparent;color:var(--muted);font-size:13px;cursor:pointer;font-weight:650}
    #newConvBtn:hover{border-color:var(--accent-2);color:var(--text)}
    main{padding:14px;overflow:auto;min-width:0;flex:1}
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);gap:8px}
    .empty-state .icon{font-size:40px;opacity:.3}
    .empty-state .text{font-size:14px}
    select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 10px;font:inherit;min-width:0;max-width:100%;outline:none;text-overflow:ellipsis;transition:border-color .2s,box-shadow .2s}
    select:focus,textarea:focus{border-color:rgba(212,165,116,.5);box-shadow:0 0 0 3px rgba(212,165,116,.1),0 0 20px rgba(212,165,116,.05)}
    .thread{width:100%;max-width:880px;min-width:0;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
    .msg{border-radius:14px;padding:14px 16px;line-height:1.65;white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 16px rgba(0,0,0,.2);animation:msgIn .25s ease-out}
    .msg.user{margin-left:auto;max-width:min(760px,92%);background:linear-gradient(135deg,rgba(212,165,116,.1),rgba(212,165,116,.04));border:1px solid rgba(212,165,116,.18);border-right:3px solid rgba(212,165,116,.45);box-shadow:0 2px 16px rgba(212,165,116,.06)}
    .msg.assistant{margin-right:auto;max-width:min(820px,100%);background:linear-gradient(135deg,rgba(100,210,193,.05),rgba(100,210,193,.01));border:1px solid rgba(100,210,193,.08);border-left:3px solid rgba(100,210,193,.3);box-shadow:0 2px 16px rgba(100,210,193,.04)}
    @keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
    .meta{font-size:12px;color:var(--muted);margin-bottom:4px}
    .scroll-hint{position:sticky;bottom:6px;display:none;margin:8px auto 0;height:34px;min-width:100px;border:1px solid rgba(100,210,193,.4);border-radius:999px;background:rgba(16,20,19,.94);color:var(--accent-2);font-size:13px;font-weight:650;cursor:pointer;backdrop-filter:blur(12px);box-shadow:0 4px 20px rgba(0,0,0,.4),0 0 12px rgba(100,210,193,.1)}
    .scroll-hint.visible{display:block}
    .typing-dots{display:inline-flex;gap:3px;align-items:center}
    .typing-dots span{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:dotPulse 1.2s infinite}
    .typing-dots span:nth-child(2){animation-delay:.2s}
    .typing-dots span:nth-child(3){animation-delay:.4s}
    @keyframes dotPulse{0%,60%{opacity:.2}30%{opacity:1}}
    .tool-note{font-size:12px;color:var(--muted);margin-top:6px;font-style:italic}
    form{width:100%;min-width:0;z-index:2;padding:10px max(12px,env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-right));border-top:1px solid rgba(255,255,255,.04);background:rgba(8,10,10,.88);backdrop-filter:blur(24px) saturate(120%);box-shadow:0 -8px 32px rgba(0,0,0,.3)}
    .bar{width:100%;max-width:880px;min-width:0;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
    textarea{width:100%;min-height:54px;max-height:160px;resize:none;border:1px solid rgba(255,255,255,.06);border-radius:10px;background:rgba(17,22,21,.8);color:var(--text);padding:12px 14px;outline:none;font:inherit;line-height:1.45;transition:border-color .2s,box-shadow .2s;backdrop-filter:blur(4px)}
    .char-count{font-size:11px;color:var(--muted);text-align:right;grid-column:1 / -1;margin-top:2px}
    button{height:56px;min-width:80px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--accent-2),var(--accent));color:#0a0f0e;font-weight:800;font:inherit;font-size:15px;cursor:pointer;transition:all .2s}
    button:hover{filter:brightness(1.08);transform:translateY(-1px);box-shadow:0 6px 20px rgba(100,210,193,.3)}
    button:active{transform:translateY(0) scale(.97)}
    button:disabled{opacity:.4;transform:none;box-shadow:none;filter:none}
    button:disabled{opacity:.45}
    .paradigm-row{width:100%;max-width:880px;min-width:0;margin:0 auto 4px;display:flex;gap:6px;align-items:center}
    .paradigm-row select{width:auto;min-width:120px;max-width:45%;flex:0 1 auto;height:36px;font-size:14px;border-radius:999px;padding:0 12px}
    .chip{height:36px;min-width:0;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--muted);border-radius:999px;padding:0 12px;font-size:13px;white-space:nowrap;font-weight:650;cursor:pointer;transition:all .2s}
    .chip:hover{border-color:rgba(255,255,255,.15);color:var(--text)}
    .chip.on{color:var(--accent-2);border-color:rgba(100,210,193,.4);background:rgba(100,210,193,.12);box-shadow:0 0 12px rgba(100,210,193,.15);animation:chipOn .3s ease-out}
    @keyframes chipOn{0%{box-shadow:0 0 0 rgba(100,210,193,.4);background:rgba(100,210,193,.25)}100%{box-shadow:0 0 12px rgba(100,210,193,.15);background:rgba(100,210,193,.12)}}
    #singleTurnBtn.on{color:var(--accent);border-color:rgba(212,165,116,.5);background:rgba(212,165,116,.08)}
    .slot{height:36px;min-width:36px;border:1px dashed var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:0 12px;font-size:13px;white-space:nowrap;font-weight:650;cursor:pointer;transition:all .2s}
    .slot:hover{border-color:rgba(255,255,255,.2);color:var(--text)}
    .slot.filled{border-style:solid;border-color:var(--line);background:rgba(255,255,255,.04)}
    .slot.active{border-color:rgba(100,210,193,.55);color:var(--accent-2);background:rgba(100,210,193,.1);box-shadow:0 0 12px rgba(100,210,193,.1)}
    /* bottom tab bar */
    .bottom-bar{position:sticky;bottom:0;z-index:5;display:flex;border-top:1px solid rgba(255,255,255,.05);background:rgba(12,15,16,.96);backdrop-filter:blur(16px);padding:4px max(12px,env(safe-area-inset-left)) max(4px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-right))}
    .bb-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border:0;background:transparent;color:var(--muted);font-size:20px;cursor:pointer;transition:color .15s;-webkit-tap-highlight-color:transparent}
    .bb-tab span{font-size:10px;font-weight:650}
    .bb-tab.on{color:var(--accent-2)}
    /* page panels */
    .page-panel{display:none;flex:1;overflow:auto;padding:14px}
    .page-panel.active{display:flex;flex-direction:column}
    .page-title{font-size:16px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
    .page-content{flex:1;overflow:auto}
    /* bills table */
    .bills-table{width:100%;border-collapse:collapse;font-size:13px}
    .bills-table th,.bills-table td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
    .bills-table th{color:var(--muted);font-weight:650;font-size:11px;text-transform:uppercase}
    .bills-table tr:hover{background:rgba(255,255,255,.02)}
    .stat-card{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:8px}
    .stat-value{font-size:24px;font-weight:800;color:var(--accent-2)}
    .stat-label{font-size:12px;color:var(--muted);margin-top:2px}
    /* todo list */
    .todo-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.03)}
    .todo-check{width:20px;height:20px;border:2px solid var(--line);border-radius:6px;flex-shrink:0;cursor:pointer}
    .todo-check.done{background:var(--ok);border-color:var(--ok)}
    .todo-text{font-size:14px}
    .todo-text.done{text-decoration:line-through;color:var(--muted)}
    @media (min-width: 960px){
      html,body{overflow:hidden}
      .app{height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto}
      main{padding:18px 20px}
      form{padding:12px 20px 16px}
    }
    @media (max-width: 959px){
      .conv-layout{flex-direction:column;position:relative}
      .conv-sidebar{position:fixed;top:0;left:0;width:280px;height:100dvh;z-index:10;transform:translateX(-100%);transition:transform .25s;-webkit-overflow-scrolling:touch}
      .conv-sidebar.open{transform:translateX(0);box-shadow:4px 0 24px rgba(0,0,0,.5)}
      .conv-sidebar-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9}
      .conv-sidebar-backdrop.open{display:block}
      .conv-toggle{display:inline-flex!important;align-items:center;gap:4px;font-size:13px;color:var(--muted);cursor:pointer;border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:rgba(255,255,255,.03);white-space:nowrap}
      .conv-toggle .arrow{font-size:10px}
    }
    /* mobile touch */
    .conv-item{-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
    .conv-item:active{background:rgba(255,255,255,.05)}
    button, .chip, .slot, .model-btn, .conv-toggle{-webkit-tap-highlight-color:transparent}
    @media (min-width: 960px){
      .conv-toggle{display:none!important}
      .conv-sidebar-backdrop{display:none!important}
    }
    @media (max-width: 640px){
      header{padding:6px 10px;gap:5px}
      .subtitle{display:none}
      h1{font-size:15px}
      .state{height:26px;display:flex;align-items:center;justify-content:center;padding-inline:6px;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis}
      main{padding:12px}
      .msg{padding:11px 12px}
      form{padding-top:8px}
      .paradigm-row{gap:4px}
      .paradigm-row select{max-width:38%;font-size:13px;height:34px;padding:0 10px}
      .slot{height:34px;min-width:32px;font-size:13px;padding:0 9px}
      .chip{height:34px;font-size:13px;padding:0 10px}
      .model-btn{height:30px;font-size:12px;padding:0 8px}
      .bar{grid-template-columns:1fr}
      #send{width:100%;height:46px}
      textarea{min-height:50px}
    }
    @media (max-width: 380px){
      .brand{gap:5px}
      .mark{width:24px;height:24px;font-size:12px}
      h1{font-size:14px}
      .paradigm-row{gap:3px}
      .paradigm-row select{max-width:35%;font-size:10px;height:28px;padding:0 6px}
      .slot{height:32px;min-width:28px;font-size:12px;padding:0 7px}
      .chip{height:32px;font-size:12px;padding:0 8px}
      select{height:38px;font-size:13px}
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="toast" id="toast"></div>
    <header>
      <div class="brand">
        <button id="convToggle" class="conv-toggle" type="button"><span class="arrow">☰</span> 对话</button>
        <div class="mark">C</div><h1>Claude Notes</h1>
      </div>
      <button class="cancel-btn" id="cancelBtn" type="button" title="取消任务">✕</button>
      <button id="modelBtn" class="model-btn" type="button" title="切换模型">Pro</button>
      <button id="clearHistory" class="trash-btn" type="button" title="清除所有记录">🗑</button>
      <div class="state" id="state">ready</div>
    </header>
    <div class="conv-layout">
      <div class="conv-sidebar-backdrop" id="sidebarBackdrop"></div>
      <aside class="conv-sidebar" id="convSidebar">
        <div class="conv-sidebar-header"><span>📋 对话记录</span></div>
        <div class="conv-list" id="convList"></div>
        <button id="newConvBtn">+ 新对话</button>
      </aside>
      <main>
        <!-- Chat page -->
        <div class="page-panel active" id="page-chat">
          <div class="thread" id="thread"><div class="empty-state"><div class="icon">💬</div><div class="text">选择对话或发送消息</div></div></div>
          <button class="scroll-hint" id="scrollHint" type="button" aria-label="滚动到底部">↓ 新消息</button>
        </div>
        <!-- Bills page -->
        <div class="page-panel" id="page-bills">
          <div class="page-title" style="justify-content:space-between">
            <span>💰 账单</span>
            <span style="display:flex;align-items:center;gap:4px">
              <button id="billPrev" class="chip" style="height:28px;font-size:11px;padding:0 8px">◀</button>
              <span id="billMonth" style="font-size:14px;font-weight:700;min-width:80px;text-align:center"></span>
              <button id="billNext" class="chip" style="height:28px;font-size:11px;padding:0 8px">▶</button>
            </span>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap" id="billStats"></div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px" id="billPeriods"></div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px" id="billDayChips"></div>
          <div class="page-content" id="billTable"></div>
        </div>
        <!-- Todos page -->
        <div class="page-panel" id="page-todos">
          <div class="page-title">✅ 待办 · <span id="todoDate"></span></div>
          <div class="page-content" id="todoList"></div>
        </div>
      </main>
    </div>
    <form id="form">
      <div class="paradigm-row">
        <select id="paradigmSelect"></select>
        <button class="chip" id="singleTurnBtn" type="button">单轮</button>
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md,.csv" multiple style="display:none" />
        <button class="chip" id="uploadBtn" type="button" title="上传文件">📎</button>
        <span style="flex:1"></span>
        <button class="slot" id="slot0" type="button" title="单击切换 · 双击绑定">+</button>
        <button class="slot" id="slot1" type="button" title="单击切换 · 双击绑定">+</button>
      </div>
      <div class="bar"><textarea id="input" placeholder="输入一句话" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false"></textarea><button id="send">发送</button><span class="char-count" id="charCount"></span></div>
    </form>
    <nav class="bottom-bar" id="bottomBar">
      <button class="bb-tab on" data-page="chat">💬<span>对话</span></button>
      <button class="bb-tab" data-page="bills">💰<span>账单</span></button>
      <button class="bb-tab" data-page="todos">✅<span>待办</span></button>
    </nav>
  </div>
  <script>
    // ── DOM refs ──
    const thread = document.getElementById('thread');
    const scrollHint = document.getElementById('scrollHint');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const state = document.getElementById('state');
    const modelBtn = document.getElementById('modelBtn');
    const paradigmSelect = document.getElementById('paradigmSelect');
    const singleTurnBtn = document.getElementById('singleTurnBtn');
    const clearHistory = document.getElementById('clearHistory');
    const cancelBtn = document.getElementById('cancelBtn');
    const charCount = document.getElementById('charCount');
    const toastEl = document.getElementById('toast');
    const convList = document.getElementById('convList');
    const convSidebar = document.getElementById('convSidebar');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    const convToggle = document.getElementById('convToggle');
    const newConvBtn = document.getElementById('newConvBtn');

    // ── State ──
    let currentModel = 'deepseek-v4-pro';
    let availableModels = ['deepseek-v4-pro', 'deepseek-v4-flash'];
    const paradigmCache = {};
    let slotParadigms;
    try { slotParadigms = JSON.parse(localStorage.getItem('autoobsidian_slots') || 'null'); } catch {}
    if (!Array.isArray(slotParadigms) || slotParadigms.length !== 2) slotParadigms = [null, null];
    const slotBtns = [document.getElementById('slot0'), document.getElementById('slot1')];
    let conversations = [];
    let activeConvId = null;
    let singleTurn = false;
    let streamingAbort = null;
    let toastTimer = null;

    // ── Conversation helpers ──
    function loadConversations() {
      try { conversations = JSON.parse(localStorage.getItem('claudenotes_convs') || '[]'); } catch { conversations = []; }
    }
    function saveConversations() {
      try { localStorage.setItem('claudenotes_convs', JSON.stringify(conversations)); } catch {}
    }
    function findConv(id) { return conversations.find(c => c.id === id); }
    function newConversation(title) {
      const d = new Date();
      const dateStr = String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      const timeStr = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
        title: dateStr + ' ' + (title || '新对话').slice(0, 50),
        messages: [],
        model: currentModel,
        paradigm: paradigmSelect.value || '',
        createdAt: new Date().toISOString(),
        updatedAt: dateStr + ' ' + timeStr,
        status: 'active'
      };
    }
    function renderConvList() {
      convList.innerHTML = conversations.slice().reverse().map(c => {
        let statusClass = c.status || 'active';
        return '<div class="conv-item' + (c.id === activeConvId ? ' active' : '') + '" data-id="' + c.id + '">' +
          '<div style="display:flex;align-items:flex-start;gap:6px">' +
          '<span class="status-dot ' + statusClass + '"></span>' +
          '<div style="min-width:0">' +
          '<div class="conv-item-title">' + escapeHtml(c.title) + '</div>' +
          '<div class="conv-item-meta"><span>' + (c.updatedAt || '') + '</span><span>' + c.messages.length + ' 条</span></div>' +
          '</div></div></div>';
      }).join('');
    }
    function switchConv(id) {
      activeConvId = id;
      const conv = findConv(id);
      if (!conv) return;
      renderConvList();
      renderMessages(conv);
      closeSidebar();
    }
    function renderMessages(conv) {
      if (!conv || !conv.messages.length) {
        thread.innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">新对话</div></div>';
        return;
      }
      thread.innerHTML = conv.messages.map(m => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const label = m.role === 'user' ? '你' : 'Claude';
        return '<div class="msg ' + role + '"><div class="meta">' + label + ' · ' + (m.time || '') + '</div>' + formatMarkdown(m.content) + '</div>';
      }).join('');
      scrollToBottom();
    }
    function ensureActiveConv() {
      if (activeConvId && findConv(activeConvId)) return;
      const conv = newConversation('新对话');
      conversations.unshift(conv);
      activeConvId = conv.id;
      saveConversations();
      renderConvList();
      thread.innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">新对话</div></div>';
    }
    function closeSidebar() {
      convSidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('open');
    }
    function toggleSidebar() {
      convSidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('open');
    }
    function escapeHtml(text) {
      return text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    }

    // ── Slots ──
    function saveSlots() { try { localStorage.setItem('autoobsidian_slots', JSON.stringify(slotParadigms)); } catch {} }
    function updateSlotUI() {
      const currentPath = paradigmSelect.value;
      slotParadigms.forEach((s, i) => {
        const btn = slotBtns[i];
        btn.classList.remove('filled', 'active');
        if (s) { btn.classList.add('filled'); btn.textContent = s.name; if (currentPath === s.path) btn.classList.add('active'); }
        else { btn.textContent = '+'; }
      });
    }
    function activateSlot(i) {
      const s = slotParadigms[i]; if (!s) return;
      if (paradigmCache[s.path] === undefined) paradigmCache[s.path] = s.content;
      paradigmSelect.value = s.path; updateSlotUI();
    }
    function bindSlot(i) {
      const path = paradigmSelect.value; if (!path) return;
      slotParadigms[i] = { path, name: paradigmSelect.options[paradigmSelect.selectedIndex].text, content: paradigmCache[path] || '' };
      saveSlots(); updateSlotUI();
    }
    slotBtns.forEach((btn, i) => {
      let clickTimer = null;
      btn.addEventListener('click', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; bindSlot(i); }
        else { clickTimer = setTimeout(() => { clickTimer = null; activateSlot(i); }, 300); }
      });
    });

    // ── Markdown ──
    function formatMarkdown(text) {
      let html = escapeHtml(text);
      html = html.replace(/\x60\x60\x60(\\w*)\\n?([\\s\\S]*?)\x60\x60\x60/g, (_, lang, code) => '<pre style="background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:13px;margin:6px 0"><code>' + code.trim() + '</code></pre>');
      html = html.replace(/\x60([^\x60]+)\x60/g, '<code style="background:rgba(212,165,116,.15);color:var(--accent);padding:2px 5px;border-radius:3px;font-size:13px">$1</code>');
      html = html.replace(/((?:^\\|.+\\|\\n)+)(^\\|[-: |]+\\|\\n)((?:^\\|.+\\|\\n?)+)/gm, (_, head, sep, body) => {
        const toRow = (line, tag) => { const cells = line.split('|').filter(c => c.trim()).map(c => '<' + tag + ' style="padding:4px 10px;border:1px solid var(--line);text-align:left">' + c.trim() + '</' + tag + '>').join(''); return '<tr>' + cells + '</tr>'; };
        const headerRow = toRow(head.trim().split('\\n').pop(), 'th');
        const bodyRows = body.trim().split('\\n').filter(Boolean).map(r => toRow(r, 'td')).join('');
        return '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px"><thead>' + headerRow + '</thead><tbody>' + bodyRows + '</tbody></table>';
      });
      html = html.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:14px">$1</h4>');
      html = html.replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:16px">$1</h3>');
      html = html.replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 6px;font-size:18px">$1</h2>');
      html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" style="color:var(--accent-2);text-decoration:underline" target="_blank">$1</a>');
      html = html.replace(/^[*-] (.+)$/gm, '<span style="display:block;padding-left:8px">• $1</span>');
      html = html.replace(/^---$/gm, '<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">');
      return html;
    }

    // ── Helpers ──
    function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 2000); }
    function nowStr() { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0'); }
    function scrollToBottom() { const last = thread.lastElementChild; if (last) { last.scrollIntoView({block:'end'}); scrollHint.classList.remove('visible'); } }

    // ── Streaming bubble ──
    function addStreamingBubble() {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML = '<div class="meta">Claude · ' + nowStr() + '</div><span class="stream-text"></span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
      thread.appendChild(div); scrollToBottom();
      const textEl = div.querySelector('.stream-text');
      let dotsEl = div.querySelector('.typing-dots');
      return {
        div,
        appendText: function(d) { if (dotsEl) { dotsEl.remove(); dotsEl = null; } textEl.textContent += d; scrollToBottom(); },
        setText: function(t) { if (dotsEl) { dotsEl.remove(); dotsEl = null; } textEl.textContent = t; },
        finalize: function() { if (dotsEl) { dotsEl.remove(); dotsEl = null; } }
      };
    }

    // ── Submit ──
    async function submit(text) {
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; }
      const prompt = text.trim();
      if (!prompt) return;
      input.value = '';
      charCount.textContent = '';
      const files = pendingFiles; pendingFiles = [];
      uploadBtn.textContent = '📎'; uploadBtn.style.color = ''; uploadBtn.style.borderColor = '';

      // Create or reuse conversation
      if (singleTurn || !activeConvId || !findConv(activeConvId)) {
        const conv = newConversation(prompt);
        conversations.unshift(conv);
        activeConvId = conv.id;
      }
      const conv = findConv(activeConvId);
      conv.title = conv.messages.length === 0 ? (conv.title.split(' ').slice(0,1).join(' ') + ' ' + prompt.slice(0, 45)) : conv.title;
      conv.status = 'running';
      conv.messages.push({role: 'user', content: prompt, time: nowStr()});
      saveConversations();
      renderConvList();
      renderMessages(conv);

      state.textContent = 'thinking';
      state.dataset.status = '';
      send.disabled = true;
      const bubble = addStreamingBubble();
      let fullText = '';

      try {
        const resp = await fetch('/api/chat/stream', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: prompt, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel, files: files}),
          signal: (streamingAbort = new AbortController()).signal
        });
        if (!resp.ok) { const ed = await resp.json().catch(()=>({error:'HTTP '+resp.status})); throw new Error(ed.error||'请求失败'); }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream: true});
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) { eventType = line.slice(7).trim(); }
            else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (eventType === 'meta') { conv._jobId = data.jobId; saveConversations(); }
                else if (eventType === 'text') { fullText += data.delta; bubble.appendText(data.delta); }
                else if (eventType === 'done') { if (!fullText.trim()) bubble.setText(data.reply || '完成'); }
                else if (eventType === 'error') { bubble.setText('失败：' + escapeHtml(data.message)); }
              } catch {}
              eventType = '';
            }
          }
        }
        bubble.finalize();
        if (fullText.trim()) {
          bubble.div.querySelector('.stream-text').innerHTML = formatMarkdown(fullText.trim());
          conv.messages.push({role: 'assistant', content: fullText.trim(), time: nowStr()});
        }
        conv.status = 'done';
        conv.updatedAt = nowStr();
        state.textContent = 'ready';
      } catch (err) {
        if (err.name === 'AbortError') {
          bubble.setText('[已取消]'); conv.status = 'done'; conv.updatedAt = nowStr(); state.textContent = 'ready';
        } else {
          // Fallback: job queue
          try {
            bubble.finalize();
            const fb = addStreamingBubble();
            const jr = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: prompt, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel})});
            const jd = await jr.json();
            if (!jr.ok) throw new Error(jd.error||'请求失败');
            fb.setText('处理中...');
            const pid = setInterval(async () => {
              try {
                const pr = await fetch('/api/jobs'); const pd = await pr.json();
                const found = pd.jobs.find(j => j.id === jd.job.id);
                if (found && (found.status === 'done' || found.status === 'failed')) {
                  clearInterval(pid); fb.finalize();
                  if (found.status === 'done') {
                    conv.messages.push({role: 'assistant', content: found.reply, time: nowStr()});
                    renderMessages(conv);
                  } else {
                    conv.messages.push({role: 'assistant', content: '失败：' + found.error, time: nowStr()});
                    renderMessages(conv);
                  }
                  conv.status = found.status === 'done' ? 'done' : 'failed';
                  conv.updatedAt = nowStr();
                  saveConversations(); renderConvList();
                  state.textContent = 'ready';
                }
              } catch {}
            }, 2000);
            state.textContent = 'queued';
          } catch (fe) {
            conv.status = 'failed';
            conv.updatedAt = nowStr();
            conv.messages.push({role: 'assistant', content: '失败：' + (fe.message||'未知错误'), time: nowStr()});
            renderMessages(conv);
            state.textContent = 'error'; state.dataset.status = 'error';
          }
        }
      } finally {
        send.disabled = false; input.focus(); streamingAbort = null;
        saveConversations(); renderConvList();
        if (conv.status === 'done' && singleTurn) { activeConvId = null; }
      }
    }

    // ── Event listeners ──
    form.addEventListener('submit', e => { e.preventDefault(); submit(input.value); });
    input.addEventListener('keydown', e => { if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Enter' && e.ctrlKey)) { e.preventDefault(); submit(input.value); } });
    input.addEventListener('input', () => {
      const len = input.value.length; charCount.textContent = len > 0 ? len + ' 字符' : '';
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
    cancelBtn.addEventListener('click', async () => {
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; toast('已取消'); return; }
      try { const r = await fetch('/api/job/cancel', {method:'POST'}); const d = await r.json(); if (!r.ok) throw new Error(d.error); toast('已取消'); } catch (e) { /* ignore */ }
    });
    scrollHint.addEventListener('click', () => { scrollToBottom(); });
    convToggle.addEventListener('click', toggleSidebar);
    sidebarBackdrop.addEventListener('click', closeSidebar);
    // Swipe: right edge → open sidebar, left swipe on sidebar → close
    let touchStartX = 0, touchStartY = 0;
    document.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; }, {passive:true});
    document.addEventListener('touchend', e => {
      const dx = (e.changedTouches[0]?.clientX||0) - touchStartX;
      const dy = Math.abs((e.changedTouches[0]?.clientY||0) - touchStartY);
      if (Math.abs(dx) > 60 && Math.abs(dx) > dy) {
        if (dx > 0 && touchStartX < 30) { convSidebar.classList.add('open'); sidebarBackdrop.classList.add('open'); }
        else if (dx < 0) closeSidebar();
      }
    });
    newConvBtn.addEventListener('click', () => {
      const conv = newConversation('新对话');
      conversations.unshift(conv);
      activeConvId = conv.id;
      saveConversations(); renderConvList();
      thread.innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">新对话</div></div>';
      closeSidebar();
    });
    convList.addEventListener('click', e => {
      const item = e.target.closest('.conv-item');
      if (item) switchConv(item.dataset.id);
    });
    // Long-press (mobile) or right-click (desktop) to delete single conversation
    let longPressTimer = null;
    convList.addEventListener('touchstart', e => {
      const item = e.target.closest('.conv-item');
      if (!item) return;
      longPressTimer = setTimeout(() => { deleteConversation(item.dataset.id); }, 600);
    }, {passive:true});
    convList.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
    convList.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
    convList.addEventListener('contextmenu', e => {
      e.preventDefault();
      const item = e.target.closest('.conv-item');
      if (item) deleteConversation(item.dataset.id);
    });
    function deleteConversation(id) {
      if (!confirm('删除这条对话？')) return;
      conversations = conversations.filter(c => c.id !== id);
      if (activeConvId === id) {
        activeConvId = conversations.length > 0 ? conversations[0].id : null;
        if (activeConvId) renderMessages(findConv(activeConvId));
        else thread.innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">选择对话或发送消息</div></div>';
      }
      saveConversations(); renderConvList(); toast('已删除');
    }
    // ── Page tabs ──
    let currentPage = 'chat';
    const tabPages = { chat: showChatPage, bills: showBillsPage, todos: showTodosPage };
    document.getElementById('bottomBar').addEventListener('click', e => {
      const tab = e.target.closest('.bb-tab');
      if (!tab || tab.dataset.page === currentPage) return;
      document.querySelectorAll('.bb-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      currentPage = tab.dataset.page;
      document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + currentPage).classList.add('active');
      // Show/hide form for chat vs other pages
      const isChat = currentPage === 'chat';
      document.getElementById('form').style.display = isChat ? '' : 'none';
      document.getElementById('bottomBar').style.display = '';
      if (tabPages[currentPage]) tabPages[currentPage]();
    });

    function showChatPage() { scrollToBottom(); }
    let billYear, billMonth, billCache = {};
    async function loadBills(year, mon) {
      const key = year + '-' + mon;
      document.getElementById('billMonth').textContent = year + '年' + parseInt(mon) + '月';
      document.getElementById('billPrev').style.visibility = '';
      document.getElementById('billNext').style.visibility = '';
      if (billCache[key]) { renderBills(billCache[key]); return; }
      document.getElementById('billTable').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">加载中...</div>';
      document.getElementById('billStats').innerHTML = '';
      document.getElementById('billPeriods').innerHTML = ''; document.getElementById('billDayChips').innerHTML = '';
      try {
        const r = await fetch('/api/bills?month=' + key);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '加载失败');
        billCache[key] = data;
        renderBills(data);
      } catch(e) { document.getElementById('billTable').innerHTML = '<div style="color:var(--bad);text-align:center;padding:40px">加载失败: ' + escapeHtml(e.message) + '</div>'; }
    }
    function renderBills(data) {
      const rows = data.rows || [];
      const headers = data.headers || ['日期','星期','类型','备注','金额','垫付'];
      if (rows.length === 0) {
        document.getElementById('billTable').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">本月暂无账单</div>';
        document.getElementById('billPeriods').innerHTML = ''; document.getElementById('billDayChips').innerHTML = '';
        return;
      }
      // Two-level filter: period → day
      const periods = [
        { key: 'early', label: '上旬', range: [1,10] },
        { key: 'mid', label: '中旬', range: [11,20] },
        { key: 'late', label: '下旬', range: [21,31] }
      ];
      const today = new Date().getDate();
      const curPeriod = today <= 10 ? 'early' : today <= 20 ? 'mid' : 'late';
      // Pre-calc
      const byDay = {}, periodSums = { early:{sum:0}, mid:{sum:0}, late:{sum:0} };
      rows.forEach(r => {
        const day = parseInt((r[0]||'').slice(-2))||0;
        const amt = parseFloat(r[4]||'0')||0;
        if (!byDay[day]) byDay[day] = {sum:0,count:0};
        byDay[day].sum += amt; byDay[day].count++;
        if (day <= 10) periodSums.early.sum += amt;
        else if (day <= 20) periodSums.mid.sum += amt;
        else periodSums.late.sum += amt;
      });
      let selectedPeriod = curPeriod, selectedDay = 0; // 0 = whole period

      function updateBillView() {
        let filteredRows;
        if (selectedDay > 0) {
          filteredRows = rows.filter(r => parseInt((r[0]||'').slice(-2)) === selectedDay);
        } else if (selectedPeriod === 'all') {
          filteredRows = rows;
        } else {
          const p = periods.find(x => x.key === selectedPeriod);
          filteredRows = rows.filter(r => { const d = parseInt((r[0]||'').slice(-2))||0; return d >= p.range[0] && d <= p.range[1]; });
        }
        let ft=0, fp=0;
        filteredRows.forEach(r => { ft += parseFloat(r[4]||'0')||0; if ((r[5]||'')==='是') fp += parseFloat(r[4]||'0')||0; });
        const label = selectedDay > 0 ? selectedDay+'日' : selectedPeriod==='all' ? '月' : (periods.find(x=>x.key===selectedPeriod)?.label||'');
        document.getElementById('billStats').innerHTML =
          '<div class="stat-card"><div class="stat-value">¥'+ft.toFixed(2)+'</div><div class="stat-label">'+label+'支出</div></div>'+
          '<div class="stat-card"><div class="stat-value">¥'+fp.toFixed(2)+'</div><div class="stat-label">待报销</div></div>';
        document.getElementById('billTable').innerHTML = '<table class="bills-table"><thead><tr>'+
          headers.map(h=>'<th>'+escapeHtml(h)+'</th>').join('')+'</tr></thead><tbody>'+
          filteredRows.map(r=>'<tr>'+r.map(c=>'<td>'+escapeHtml(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
        // Render period chips
        document.getElementById('billPeriods').innerHTML = '<button class="chip period-chip'+(selectedPeriod==='all' && selectedDay===0?' on':'')+'" data-period="all" style="height:28px;font-size:11px">全部 ¥'+(periodSums.early.sum+periodSums.mid.sum+periodSums.late.sum).toFixed(0)+'</button>'+
          periods.map(p=>'<button class="chip period-chip'+(selectedPeriod===p.key && selectedDay===0?' on':'')+'" data-period="'+p.key+'" style="height:28px;font-size:11px">'+p.label+' ¥'+periodSums[p.key].sum.toFixed(0)+'</button>').join('');
        // Render day chips for selected period
        let daysDiv = '';
        if (selectedPeriod !== 'all' || selectedDay > 0) {
          const p = periods.find(x=>x.key===selectedPeriod) || {range:[1,31]};
          const days = Object.keys(byDay).map(Number).filter(d=>d>=p.range[0]&&d<=p.range[1]).sort((a,b)=>a-b);
          daysDiv = days.map(d=>'<button class="chip day-chip'+(selectedDay===d?' on':'')+'" data-day="'+d+'" style="height:26px;font-size:11px">'+d+'日 ¥'+byDay[d].sum.toFixed(0)+'</button>').join('');
        }
        document.getElementById('billDayChips').innerHTML = daysDiv;
      }

      // Event delegation
      document.getElementById('billPeriods').onclick = e => {
        const btn = e.target.closest('.period-chip'); if (!btn) return;
        selectedPeriod = btn.dataset.period; selectedDay = 0; updateBillView();
      };
      document.getElementById('billDayChips').onclick = e => {
        const btn = e.target.closest('.day-chip'); if (!btn) return;
        selectedDay = parseInt(btn.dataset.day); updateBillView();
      };
      updateBillView();
    }
    async function showBillsPage() {
      const d = new Date();
      if (!billYear) { billYear = d.getFullYear(); billMonth = String(d.getMonth()+1).padStart(2,'0'); }
      loadBills(billYear, billMonth);
    }
    document.getElementById('billPrev').addEventListener('click', () => {
      let m = parseInt(billMonth) - 1; let y = billYear;
      if (m < 1) { m = 12; y--; }
      billMonth = String(m).padStart(2,'0'); billYear = y;
      loadBills(billYear, billMonth);
    });
    document.getElementById('billNext').addEventListener('click', () => {
      let m = parseInt(billMonth) + 1; let y = billYear;
      if (m > 12) { m = 1; y++; }
      billMonth = String(m).padStart(2,'0'); billYear = y;
      loadBills(billYear, billMonth);
    });
    async function showTodosPage() {
      const d = new Date();
      const ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      document.getElementById('todoDate').textContent = ds;
      try {
        const r = await fetch('/api/note/read?path=' + encodeURIComponent('900 Journals & Reviews/910 Daily Notes/' + ds + '.md'));
        const data = await r.json();
        if (!r.ok || !data.content) { document.getElementById('todoList').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">今日暂无日记<br><small>在对话中说"帮我记录今天要做的事"</small></div>'; return; }
        const todos = data.content.split('\\n').filter(l => l.match(/^[-*] \[.\]/));
        const pending = todos.filter(l => l.match(/^[-*] \[ \]/));
        const done = todos.filter(l => l.match(/^[-*] \[x\]/i));
        document.getElementById('todoList').innerHTML =
          (pending.length ? '<div style="font-size:13px;color:var(--muted);margin-bottom:8px">⏳ 待完成 (' + pending.length + ')</div>' : '') +
          pending.map(l => '<div class="todo-item"><div class="todo-check"></div><div class="todo-text">' + escapeHtml(l.replace(/^[-*] \[.\] /,'')) + '</div></div>').join('') +
          (done.length ? '<div style="font-size:13px;color:var(--muted);margin:16px 0 8px">✅ 已完成 (' + done.length + ')</div>' : '') +
          done.map(l => '<div class="todo-item"><div class="todo-check done"></div><div class="todo-text done">' + escapeHtml(l.replace(/^[-*] \[x\] /i,'')) + '</div></div>').join('');
      } catch(e) { document.getElementById('todoList').innerHTML = '<div style="color:var(--bad);text-align:center;padding:40px">加载失败</div>'; }
    }

    // ── File upload ──
    let pendingFiles = [];
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      for (const f of fileInput.files) {
        const reader = new FileReader();
        await new Promise(resolve => {
          reader.onload = () => {
            const isImage = f.type.startsWith('image/');
            pendingFiles.push({ name: f.name, type: f.type, data: reader.result, isImage });
            resolve();
          };
          if (f.type.startsWith('image/')) reader.readAsDataURL(f);
          else reader.readAsText(f);
        });
      }
      fileInput.value = '';
      if (pendingFiles.length) {
        uploadBtn.textContent = '📎' + pendingFiles.length;
        uploadBtn.style.color = 'var(--accent-2)';
        uploadBtn.style.borderColor = 'rgba(100,210,193,.4)';
        toast('已添加 ' + pendingFiles.length + ' 个文件，发送消息时附带');
      }
    });

    // ── Single turn ──
    singleTurnBtn.addEventListener('click', () => {
      singleTurn = !singleTurn;
      singleTurnBtn.classList.toggle('on', singleTurn);
      try { localStorage.setItem('claudenotes_singleTurn', singleTurn ? '1' : '0'); } catch {}
      toast(singleTurn ? '单轮模式：每次新建对话' : '连续模式：在同一对话中继续');
    });
    modelBtn.addEventListener('click', () => {
      const idx = availableModels.indexOf(currentModel);
      currentModel = availableModels[(idx + 1) % availableModels.length] || currentModel;
      modelBtn.textContent = currentModel.includes('flash') ? 'Flash' : 'Pro';
      try { localStorage.setItem('claudenotes_model', currentModel); } catch {}
    });

    // ── Clear history ──
    let clearPending = false, clearTimer = null;
    clearHistory.addEventListener('click', async () => {
      if (!clearPending) {
        clearPending = true; clearHistory.classList.add('confirm');
        clearTimer = setTimeout(() => { clearPending = false; clearHistory.classList.remove('confirm'); }, 3000);
        return;
      }
      clearTimeout(clearTimer); clearPending = false; clearHistory.classList.remove('confirm');
      conversations = []; activeConvId = null;
      saveConversations(); renderConvList();
      thread.innerHTML = '<div class="empty-state"><div class="icon">🗑</div><div class="text">所有记录已清除</div></div>';
      try { await fetch('/api/jobs/clear', {method:'POST'}); } catch {}
    });

    // ── Config & Paradigms ──
    async function loadConfig() {
      const r = await fetch('/api/config'); const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      availableModels = d.models;
      const saved = (() => { try { return localStorage.getItem('claudenotes_model'); } catch { return null; } })();
      currentModel = (saved && d.models.includes(saved)) ? saved : d.defaultModel;
      modelBtn.textContent = currentModel.includes('flash') ? 'Flash' : 'Pro';
    }
    async function loadParadigms() {
      const r = await fetch('/api/tasks'); const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      paradigmSelect.innerHTML = d.tasks.map(t => '<option value="' + t.path.replace(/"/g,'&quot;') + '">' + t.name + '</option>').join('');
      if (d.tasks[0]) {
        const dr = await fetch('/api/task?path=' + encodeURIComponent(d.tasks[0].path));
        const dd = await dr.json();
        if (dr.ok) paradigmCache[d.tasks[0].path] = dd.content || '';
      }
      slotParadigms.forEach(s => { if (s && s.content) paradigmCache[s.path] = s.content; });
      // Restore saved paradigm selection
      try {
        const savedParadigm = localStorage.getItem('claudenotes_paradigm');
        if (savedParadigm && paradigmSelect.querySelector('option[value="' + savedParadigm.replace(/"/g,'&quot;') + '"]')) {
          paradigmSelect.value = savedParadigm;
          if (paradigmCache[savedParadigm] === undefined) {
            const dr = await fetch('/api/task?path=' + encodeURIComponent(savedParadigm));
            const dd = await dr.json();
            if (dr.ok) paradigmCache[savedParadigm] = dd.content || '';
          }
        }
      } catch {}
      updateSlotUI();
    }
    paradigmSelect.addEventListener('change', async () => {
      updateSlotUI();
      const path = paradigmSelect.value;
      try { localStorage.setItem('claudenotes_paradigm', path); } catch {}
      if (!path || paradigmCache[path]) return;
      try { const r = await fetch('/api/task?path=' + encodeURIComponent(path)); const d = await r.json(); if (r.ok) paradigmCache[path] = d.content||''; } catch {}
    });

    // ── Recovery: poll for missed job results after disconnect ──
    async function recoverMissedJobs() {
      let recovered = false;
      const running = conversations.filter(c => c.status === 'running' && c._jobId);
      if (!running.length) return recovered;
      try {
        const r = await fetch('/api/jobs'); const d = await r.json();
        if (!r.ok) return false;
        for (const conv of running) {
          const job = d.jobs.find(j => j.id === conv._jobId);
          if (job && (job.status === 'done' || job.status === 'failed')) {
            conv.status = job.status;
            conv.updatedAt = nowStr();
            if (job.status === 'done' && job.reply) {
              conv.messages.push({role: 'assistant', content: job.reply, time: job.finishedAt?.split(' ')[1] || nowStr()});
            } else if (job.status === 'failed') {
              conv.messages.push({role: 'assistant', content: '失败：' + (job.error || '未知错误'), time: nowStr()});
            }
            recovered = true;
          }
        }
      } catch {}
      return recovered;
    }

    // ── Restore button states ──
    try {
      if (localStorage.getItem('claudenotes_singleTurn') === '1') {
        singleTurn = true; singleTurnBtn.classList.add('on');
      }
    } catch {}

    // ── Init ──
    state.textContent = '加载中...';
    // Show saved model immediately (will be confirmed by loadConfig)
    try {
      const sm = localStorage.getItem('claudenotes_model');
      if (sm) { currentModel = sm; modelBtn.textContent = sm.includes('flash') ? 'Flash' : 'Pro'; }
    } catch {}
    loadConversations();
    renderConvList();
    if (conversations.length > 0) {
      activeConvId = conversations[0].id;
      renderMessages(conversations[0]);
    }
    Promise.all([loadConfig(), loadParadigms(), recoverMissedJobs()]).then(() => {
      saveConversations(); renderConvList();
      if (activeConvId && findConv(activeConvId)) renderMessages(findConv(activeConvId));
      updateSlotUI();
      state.textContent = 'ready';
    }).catch(err => { state.textContent = 'error'; state.dataset.status = 'error'; });
  </script>
</body>
</html>`;

// ── HTTP Server ──────────────────────────────────────────────────

// ── HTTP Server ──────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      if (!checkAuth(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(loginHtml);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (verifyPassword(body.password || '')) {
        setAuthCookie(res, 'admin');
        json(res, 200, { ok: true });
      } else {
        json(res, 401, { error: '密码错误' });
      }
      return;
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'auth=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
      json(res, 200, { ok: true });
      return;
    }
    // Health check — no auth required
    if (url.pathname === '/api/ui/health') {
      json(res, 200, { health: unwrap(await fnsRequest('/api/health')), now: appNow() });
      return;
    }
    // All other API routes require auth
    if (!checkAuth(req)) {
      json(res, 401, { error: '请先登录' });
      return;
    }
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      // Create persistent job so client can recover if disconnected
      const now = appNow();
      const job = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running',
        message: body.message,
        task,
        model: normalizeModel(body.model),
        reply: '',
        error: '',
        createdAt: `${now.date} ${now.time}`,
        startedAt: `${now.date} ${now.time}`,
        finishedAt: '',
        _aborted: false,
      };
      jobs.unshift(job);
      trimJobs();
      const jobRef = job;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseWrite(res, 'meta', { jobId: jobRef.id, model: normalizeModel(body.model) });

      req.on('close', () => { jobRef._aborted = true; });

      try {
        await runClaudeStreaming(body.message, task, body.model, res, jobRef, body.history, body.files);
        if (!jobRef._aborted) {
          jobRef.status = 'done';
          const finished = appNow();
          jobRef.finishedAt = `${finished.date} ${finished.time}`;
        }
      } catch (err) {
        if (!jobRef._aborted) {
          jobRef.status = 'failed';
          jobRef.error = err.message || String(err);
          const finished = appNow();
          jobRef.finishedAt = `${finished.date} ${finished.time}`;
          sseWrite(res, 'error', { message: err.message || String(err) });
        }
      }
      res.end();
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      const job = enqueueJob({ message: body.message, task, model: body.model, history: body.history, files: body.files });
      json(res, 202, { job: serializeJob(job) });
      return;
    }
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      json(res, 200, { activeJob: activeJob ? activeJob.id : null, jobs: jobs.map(serializeJob) });
      return;
    }
    if (url.pathname === '/api/job/cancel' && req.method === 'POST') {
      const target = activeJob
        || [...jobs].reverse().find((item) => item.status === 'queued')
        || [...jobs].reverse().find((item) => item.status === 'running' && !item._aborted);
      if (target && (target.status === 'running' || target.status === 'queued')) {
        target._aborted = true;
        target.status = 'cancelled';
        target.error = '用户取消';
        const finished = appNow();
        target.finishedAt = `${finished.date} ${finished.time}`;
        if (target === activeJob) activeJob = null;
        processQueue();
        json(res, 200, { ok: true, id: target.id });
      } else {
        json(res, 404, { error: '没有可取消的任务' });
      }
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
        .map((note) => {
          const raw = String(note.path).slice(TASKS_PREFIX.length);
          const display = raw.replace(/\.md$/i, '').replace(/\//g, ' › ');
          return { path: note.path, name: display };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      if (tasks.length === 0) {
        const defaultPath = `${TASKS_PREFIX}默认范式.md`;
        const defaultContent = `# 默认范式

- 先理解用户意图，再选择最少的笔记操作。
- 不要全库遍历；先根据用户输入提取关键词搜索。
- 修改前优先读取目标笔记。
- 完成后说明修改了哪条笔记和写入内容。`;
        await fnsRequest('/api/note', { method: 'POST', body: { vault: DEFAULT_VAULT, path: defaultPath, content: defaultContent } });
        tasks = [{ path: defaultPath, name: '默认范式' }];
      }
      json(res, 200, { prefix: TASKS_PREFIX, tasks });
      return;
    }
    if (url.pathname === '/api/bills' && req.method === 'GET') {
      const month = url.searchParams.get('month') || '';
      if (!month.match(/^\d{4}-\d{2}$/)) throw new Error('invalid month format (YYYY-MM)');
      const [year, mon] = month.split('-');
      const monStr = parseInt(mon, 10) + '月'; // "06" -> "6月"
      const prefix = `900 Journals & Reviews/950 Bills/${year}/${monStr}/`;
      // List all files in the month folder
      const listData = unwrap(await fnsRequest('/api/notes', { params: { vault: DEFAULT_VAULT, keyword: monStr, searchContent: false } }));
      const list = Array.isArray(listData) ? listData : (listData?.list || []);
      const files = list.filter(n => String(n.path||'').startsWith(prefix));
      // Read all daily files and extract table rows
      const allRows = [];
      let headers = ['日期','星期','类型','备注','金额','垫付'];
      for (const f of files) {
        try {
          const noteData = unwrap(await fnsRequest('/api/note', { params: { vault: DEFAULT_VAULT, path: f.path } }));
          const content = noteData?.content || '';
          const lines = content.split('\n').filter(l => l.includes('|') && !l.includes('---'));
          for (const line of lines) {
            const cols = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cols.length >= 5 && !cols[0].includes('日期')) allRows.push(cols);
          }
        } catch {}
      }
      json(res, 200, { month, headers, rows: allRows, fileCount: files.length });
      return;
    }
    if (url.pathname === '/api/note/read' && req.method === 'GET') {
      const path = url.searchParams.get('path');
      if (!path) throw new Error('path is required');
      const data = unwrap(await fnsRequest('/api/note', { params: { vault: DEFAULT_VAULT, path } }));
      json(res, 200, { path, content: data?.content || '' });
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
  if (!ANTHROPIC_AUTH_TOKEN) console.log('Warning: ANTHROPIC_AUTH_TOKEN is not set');
});
