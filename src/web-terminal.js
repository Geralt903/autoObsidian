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

async function runClaude(userText, task, model, jobRef, history) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);

  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: userText }];
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

async function runClaudeStreaming(userText, task, model, res, jobRef, history) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: userText }];
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

function enqueueJob({ message, task, model, history }) {
  const now = appNow();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'queued',
    message,
    task,
    model: normalizeModel(model),
    history: history || [],
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
    job.reply = await runClaude(job.message, job.task, job.model, job, job.history);
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
    :root{--bg:#0c0f10;--panel:#151917;--panel-2:#101413;--line:#2a332f;--line-soft:#202824;--text:#f7f3ea;--muted:#a8b0a7;--accent:#d4a574;--accent-2:#daa520;--ok:#8fe5a7;--bad:#ff9187;--shadow:0 18px 60px rgba(0,0,0,.34)}
    *{box-sizing:border-box}
    html,body{height:100%;max-width:100%;overflow-x:hidden}
    body{width:100%;margin:0;background:radial-gradient(ellipse at 50% -20%,rgba(218,165,32,.08),transparent 40%),radial-gradient(ellipse at 80% 80%,rgba(100,210,193,.04),transparent 35%),linear-gradient(180deg,#111815 0,#0c0f10 50%,#080a0a 100%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(168,176,167,.2);border-radius:99px}::-webkit-scrollbar-thumb:hover{background:rgba(168,176,167,.35)}
    .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-10px);z-index:99;padding:10px 20px;border-radius:999px;background:rgba(16,20,19,.96);color:var(--ok);border:1px solid rgba(143,229,167,.25);font-size:13px;font-weight:650;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;backdrop-filter:blur(20px);box-shadow:0 4px 24px rgba(0,0,0,.4)}
    .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
    .app{width:100%;max-width:100vw;min-width:0;min-height:100%;min-height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow-x:hidden;position:relative}
    header{z-index:3;padding:8px max(14px,env(safe-area-inset-left)) 8px max(14px,env(safe-area-inset-right));border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:8px;background:rgba(12,15,16,.9);position:sticky;top:0;backdrop-filter:blur(20px);box-shadow:0 1px 8px rgba(0,0,0,.15)}
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
    main{padding:14px;overflow:auto;min-width:0}
    select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 10px;font:inherit;min-width:0;max-width:100%;outline:none;text-overflow:ellipsis;transition:border-color .2s,box-shadow .2s}
    select:focus,textarea:focus{border-color:rgba(212,165,116,.5);box-shadow:0 0 0 3px rgba(212,165,116,.1),0 0 20px rgba(212,165,116,.05)}
    .thread{width:100%;max-width:880px;min-width:0;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
    .msg{border-radius:12px;padding:14px 15px;line-height:1.65;white-space:pre-wrap;word-break:break-word;box-shadow:0 2px 12px rgba(0,0,0,.15);animation:msgIn .2s ease-out}
    .msg.user{margin-left:auto;max-width:min(760px,92%);background:linear-gradient(135deg,rgba(212,165,116,.12),rgba(212,165,116,.06));border:1px solid rgba(212,165,116,.2);border-right:3px solid rgba(212,165,116,.5)}
    .msg.assistant{margin-right:auto;max-width:min(820px,100%);background:linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.06);border-left:3px solid rgba(100,210,193,.35)}
    @keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    .meta{font-size:12px;color:var(--muted);margin-bottom:4px}
    .scroll-hint{position:sticky;bottom:6px;display:none;margin:8px auto 0;height:34px;min-width:100px;border:1px solid var(--accent-2);border-radius:999px;background:rgba(16,20,19,.92);color:var(--accent-2);font-size:13px;font-weight:650;cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,.3)}
    .scroll-hint.visible{display:block}
    .typing-dots{display:inline-flex;gap:3px;align-items:center}
    .typing-dots span{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:dotPulse 1.2s infinite}
    .typing-dots span:nth-child(2){animation-delay:.2s}
    .typing-dots span:nth-child(3){animation-delay:.4s}
    @keyframes dotPulse{0%,60%{opacity:.2}30%{opacity:1}}
    .tool-note{font-size:12px;color:var(--muted);margin-top:6px;font-style:italic}
    form{width:100%;min-width:0;z-index:2;padding:10px max(12px,env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-right));border-top:1px solid rgba(255,255,255,.06);background:rgba(12,15,16,.92);backdrop-filter:blur(20px);box-shadow:0 -4px 24px rgba(0,0,0,.2)}
    .bar{width:100%;max-width:880px;min-width:0;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
    textarea{width:100%;min-height:54px;max-height:160px;resize:none;border:1px solid rgba(255,255,255,.06);border-radius:10px;background:rgba(17,22,21,.8);color:var(--text);padding:12px 14px;outline:none;font:inherit;line-height:1.45;transition:border-color .2s,box-shadow .2s;backdrop-filter:blur(4px)}
    .char-count{font-size:11px;color:var(--muted);text-align:right;grid-column:1 / -1;margin-top:2px}
    button{height:56px;min-width:80px;border:0;border-radius:10px;background:var(--accent);color:#0d120f;font-weight:800;font:inherit;font-size:15px;cursor:pointer;transition:all .15s}
    button:hover{filter:brightness(1.06);transform:translateY(-1px);box-shadow:0 4px 12px rgba(212,165,116,.25)}
    button:active{transform:translateY(0) scale(.98)}
    button:disabled{opacity:.4;transform:none;box-shadow:none;filter:none}
    .paradigm-row{width:100%;max-width:880px;min-width:0;margin:0 auto 4px;display:flex;gap:6px;align-items:center}
    .paradigm-row select{width:auto;min-width:120px;max-width:45%;flex:0 1 auto;height:36px;font-size:14px;border-radius:999px;padding:0 12px}
    .chips,.jobs{width:100%;max-width:880px;min-width:0;margin:0 auto 8px;display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
    .chips::-webkit-scrollbar,.jobs::-webkit-scrollbar{display:none}
    .chip{height:36px;min-width:0;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--muted);border-radius:999px;padding:0 12px;font-size:13px;white-space:nowrap;font-weight:650;cursor:pointer;transition:all .2s}
    .chip:hover{border-color:rgba(255,255,255,.15);color:var(--text)}
    #multiTurnBtn.on{color:var(--accent);border-color:rgba(212,165,116,.5);background:rgba(212,165,116,.08)}
    .slot{height:36px;min-width:36px;border:1px dashed var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:0 12px;font-size:13px;white-space:nowrap;font-weight:650;cursor:pointer;transition:all .2s}
    .slot:hover{border-color:rgba(255,255,255,.2);color:var(--text)}
    .slot.filled{border-style:solid;border-color:var(--line);background:rgba(255,255,255,.04)}
    .slot.active{border-color:rgba(100,210,193,.55);color:var(--accent-2);background:rgba(100,210,193,.1);box-shadow:0 0 12px rgba(100,210,193,.1)}
    .job{height:32px;min-width:0;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(255,255,255,.03);padding:0 10px;font-size:12px;white-space:nowrap;font-weight:650}
    .job.running{color:var(--accent);border-color:rgba(218,165,32,.35)}
    .job.done{color:var(--ok)}
    .job.failed{color:var(--bad)}
    .retry-btn{height:28px;min-width:48px;margin-left:8px;font-size:12px;border:1px solid var(--accent-2);border-radius:6px;background:transparent;color:var(--accent-2);cursor:pointer;font-weight:650}
    @media (min-width: 960px){
      html,body{overflow:hidden}
      .app{height:100dvh;grid-template-rows:auto minmax(0,1fr) auto}
      main{padding:18px 20px}
      form{padding:12px 20px 16px}
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
      <div class="brand"><div class="mark">C</div><h1>Claude Notes</h1><span class="subtitle">手机笔记助理</span></div>
      <button class="cancel-btn" id="cancelBtn" type="button" title="取消任务">✕</button>
      <button id="modelBtn" class="model-btn" type="button" title="切换模型">Pro</button>
      <button id="clearHistory" class="trash-btn" type="button" title="清除历史">🗑</button>
      <div class="state" id="state">ready</div>
    </header>
    <main><div class="thread" id="thread"><div class="msg assistant"><div class="meta">Claude</div>直接输入要做的事。</div></div><button class="scroll-hint" id="scrollHint" type="button" aria-label="滚动到底部">↓ 新消息</button></main>
    <form id="form">
      <div class="jobs" id="jobs"></div>
      <div class="paradigm-row">
        <select id="paradigmSelect"></select>
        <button class="chip" id="multiTurnBtn" type="button">上下文</button>
        <span style="flex:1"></span>
        <button class="slot" id="slot0" type="button" title="单击切换 · 双击绑定">+</button>
        <button class="slot" id="slot1" type="button" title="单击切换 · 双击绑定">+</button>
      </div>
      <div class="bar"><textarea id="input" placeholder="输入一句话" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false"></textarea><button id="send">发送</button><span class="char-count" id="charCount"></span></div>
    </form>
  </div>
  <script>
    const thread = document.getElementById('thread');
    const scrollHint = document.getElementById('scrollHint');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const state = document.getElementById('state');
    const modelBtn = document.getElementById('modelBtn');
    let currentModel = 'deepseek-v4-pro';
    let availableModels = ['deepseek-v4-pro', 'deepseek-v4-flash'];
    const paradigmSelect = document.getElementById('paradigmSelect');
    const jobsEl = document.getElementById('jobs');
    const clearHistory = document.getElementById('clearHistory');
    const multiTurnBtn = document.getElementById('multiTurnBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const charCount = document.getElementById('charCount');
    const toastEl = document.getElementById('toast');
    let toastTimer = null;
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 2000);
    }
    let streamingAbort = null;
    const seenDone = new Set();
    const streamedJobs = new Set();
    const jobCache = new Map();
    const paradigmCache = {}; // { path: content }
    // Quick slots — persist to localStorage
    let slotParadigms;
    try { slotParadigms = JSON.parse(localStorage.getItem('autoobsidian_slots') || 'null'); } catch {}
    if (!Array.isArray(slotParadigms) || slotParadigms.length !== 2) slotParadigms = [null, null];
    const slotBtns = [document.getElementById('slot0'), document.getElementById('slot1')];

    function saveSlots() {
      try { localStorage.setItem('autoobsidian_slots', JSON.stringify(slotParadigms)); } catch {}
    }
    function updateSlotUI() {
      const currentPath = paradigmSelect.value;
      slotParadigms.forEach((s, i) => {
        const btn = slotBtns[i];
        btn.classList.remove('filled', 'active');
        if (s) {
          btn.classList.add('filled');
          btn.textContent = s.name;
          if (currentPath === s.path) btn.classList.add('active');
        } else {
          btn.textContent = '+';
        }
      });
    }
    function activateSlot(i) {
      const s = slotParadigms[i];
      if (!s) return;
      if (paradigmCache[s.path] === undefined) paradigmCache[s.path] = s.content;
      paradigmSelect.value = s.path;
      updateSlotUI();
    }
    function bindSlot(i) {
      const path = paradigmSelect.value;
      if (!path) return;
      const name = paradigmSelect.options[paradigmSelect.selectedIndex].text;
      const content = paradigmCache[path] || '';
      slotParadigms[i] = { path, name, content };
      saveSlots();
      updateSlotUI();
    }
    slotBtns.forEach((btn, i) => {
      let clickTimer = null;
      btn.addEventListener('click', () => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; bindSlot(i); }
        else { clickTimer = setTimeout(() => { clickTimer = null; activateSlot(i); }, 300); }
      });
    });

    const MAX_HISTORY = 10; // max rounds to keep
    const conversationHistory = []; // [{role, content}, ...]
    let multiTurn = false;
    function nowStr() {
      const d = new Date();
      return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
    }
    function escapeHtml(text) {
      return text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    }
    function formatMarkdown(text) {
      let html = escapeHtml(text);
      // Code blocks (must be before inline code)
      html = html.replace(/\x60\x60\x60(\\w*)\\n?([\\s\\S]*?)\x60\x60\x60/g, (_, lang, code) => '<pre style="background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:13px;margin:6px 0"><code>' + code.trim() + '</code></pre>');
      // Inline code
      html = html.replace(/\x60([^\x60]+)\x60/g, '<code style="background:rgba(212,165,116,.15);color:var(--accent);padding:2px 5px;border-radius:3px;font-size:13px">$1</code>');
      // Tables: match markdown table blocks
      html = html.replace(/((?:^\\|.+\\|\\n)+)(^\\|[-: |]+\\|\\n)((?:^\\|.+\\|\\n?)+)/gm, (_, head, sep, body) => {
        const toRow = (line, tag) => {
          const cells = line.split('|').filter(c => c.trim()).map(c => '<' + tag + ' style="padding:4px 10px;border:1px solid var(--line);text-align:left">' + c.trim() + '</' + tag + '>').join('');
          return '<tr>' + cells + '</tr>';
        };
        const headerRow = toRow(head.trim().split('\\n').pop(), 'th');
        const bodyRows = body.trim().split('\\n').filter(Boolean).map(r => toRow(r, 'td')).join('');
        return '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px"><thead>' + headerRow + '</thead><tbody>' + bodyRows + '</tbody></table>';
      });
      // Headings
      html = html.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:14px">$1</h4>');
      html = html.replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:16px">$1</h3>');
      html = html.replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 6px;font-size:18px">$1</h2>');
      // Bold + Italic
      html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
      // Links
      html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" style="color:var(--accent-2);text-decoration:underline" target="_blank">$1</a>');
      // List items
      html = html.replace(/^[*-] (.+)$/gm, '<span style="display:block;padding-left:8px">• $1</span>');
      // Horizontal rules
      html = html.replace(/^---$/gm, '<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">');
      return html;
    }
    function add(role, text) {
      const main = document.querySelector('main');
      const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = '<div class="meta">' + (role === 'user' ? '你' : 'Claude') + ' · ' + nowStr() + '</div>' + formatMarkdown(text);
      thread.appendChild(div);
      if (atBottom) { div.scrollIntoView({block:'end', behavior:'smooth'}); scrollHint.classList.remove('visible'); }
      else { scrollHint.classList.add('visible'); }
      return div;
    }
    function addStreamingBubble(role) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = '<div class="meta">' + (role === 'user' ? '你' : 'Claude') + ' · ' + nowStr() + '</div><span class="stream-text"></span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>';
      thread.appendChild(div);
      div.scrollIntoView({block:'end'});
      const textEl = div.querySelector('.stream-text');
      let dotsEl = div.querySelector('.typing-dots');
      return {
        div,
        appendText: function(delta) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          textEl.textContent += delta;
          div.scrollIntoView({block:'end'});
        },
        setText: function(text) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          textEl.textContent = text;
        },
        showTool: function(name) {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
          let toolNote = div.querySelector('.tool-note');
          if (!toolNote) {
            toolNote = document.createElement('div');
            toolNote.className = 'tool-note';
            div.appendChild(toolNote);
          }
          toolNote.textContent = '🔧 ' + name + ' ...';
        },
        finishTool: function(name, ok) {
          const toolNote = div.querySelector('.tool-note');
          if (toolNote) toolNote.textContent = (ok ? '✓ ' : '✗ ') + name;
        },
        finalize: function() {
          if (dotsEl) { dotsEl.remove(); dotsEl = null; }
        }
      };
    }
    let lastSubmittedText = '';
    async function submit(text) {
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; }
      const prompt = text.trim();
      if (!prompt) return;
      input.value = '';
      charCount.textContent = '';
      lastSubmittedText = prompt;
      add('user', prompt);
      state.textContent = 'thinking';
      state.dataset.status = '';
      send.disabled = true;
      const bubble = addStreamingBubble('assistant');
      let fullText = '';

      try {
        // Try SSE streaming first
        const resp = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: prompt, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel, history: multiTurn ? conversationHistory.slice(-MAX_HISTORY * 2) : []}),
          signal: (streamingAbort = new AbortController()).signal
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({error: 'HTTP ' + resp.status}));
          throw new Error(errData.error || '请求失败');
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, {stream: true});
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
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
                } else if (eventType === 'done') {
                  if (!fullText.trim()) bubble.setText(data.reply || '完成');
                }
              } catch(e) {}
              eventType = '';
            }
          }
        }
        bubble.finalize();
        if (fullText.trim()) {
          bubble.div.querySelector('.stream-text').innerHTML = formatMarkdown(fullText.trim());
          if (multiTurn) {
            conversationHistory.push({role: 'user', content: prompt});
            conversationHistory.push({role: 'assistant', content: fullText.trim()});
            if (conversationHistory.length > MAX_HISTORY * 2) conversationHistory.splice(0, 2);
          }
        } else {
          bubble.setText('完成');
        }
        state.textContent = 'ready';
      } catch (err) {
        if (err.name === 'AbortError') {
          bubble.setText('[已取消]');
          state.textContent = 'ready';
        } else {
          // Fallback: use job queue
          try {
            bubble.finalize();
            const fallback = addStreamingBubble('assistant');
            const jobResp = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: prompt, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel, history: multiTurn ? conversationHistory.slice(-MAX_HISTORY * 2) : []})});
            const jobData = await jobResp.json();
            if (!jobResp.ok) throw new Error(jobData.error || '请求失败');
            fallback.setText('已入队：' + jobData.job.id + '（' + jobData.job.model + '）…轮询中');
            const pollId = setInterval(async () => {
              try {
                const pollResp = await fetch('/api/jobs');
                const pollData = await pollResp.json();
                const found = pollData.jobs.find(j => j.id === jobData.job.id);
                if (found && (found.status === 'done' || found.status === 'failed')) {
                  clearInterval(pollId);
                  fallback.finalize();
                  if (found.status === 'done') add('assistant', found.reply);
                  else add('assistant', '失败：' + found.error);
                  state.textContent = 'ready';
                }
              } catch(e) {}
            }, 2000);
            state.textContent = 'queued';
          } catch (fallbackErr) {
            add('assistant', '失败：' + (fallbackErr.message || '未知错误'));
            state.textContent = 'error';
            state.dataset.status = 'error';
          }
        }
      } finally {
        send.disabled = false;
        input.focus();
        streamingAbort = null;
      }
    }
    form.addEventListener('submit', e => { e.preventDefault(); submit(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); } });
    input.addEventListener('input', () => { const len = input.value.length; charCount.textContent = len > 0 ? len + ' 字符' : ''; });
    cancelBtn.addEventListener('click', async () => {
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; toast('已取消'); return; }
      try {
        const resp = await fetch('/api/job/cancel', {method:'POST'});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '取消失败');
        toast('已取消任务');
      } catch (err) {
        add('assistant', '取消失败：' + err.message);
      }
    });
    scrollHint.addEventListener('click', () => { const last = thread.lastElementChild; if (last) { last.scrollIntoView({block:'end', behavior:'smooth'}); scrollHint.classList.remove('visible'); } });
    multiTurnBtn.addEventListener('click', () => {
      multiTurn = !multiTurn;
      multiTurnBtn.textContent = '上下文: ' + (multiTurn ? '开' : '关');
      multiTurnBtn.classList.toggle('on', multiTurn);
      if (!multiTurn) conversationHistory.length = 0;
    });
    async function loadConfig() {
      const resp = await fetch('/api/config');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '加载配置失败');
      availableModels = data.models;
      currentModel = data.defaultModel;
      modelBtn.textContent = currentModel.includes('flash') ? 'Flash' : 'Pro';
    }
    modelBtn.addEventListener('click', () => {
      const idx = availableModels.indexOf(currentModel);
      currentModel = availableModels[(idx + 1) % availableModels.length] || currentModel;
      modelBtn.textContent = currentModel.includes('flash') ? 'Flash' : 'Pro';
    });
    async function loadJobs() {
      const resp = await fetch('/api/jobs');
      const data = await resp.json();
      if (!resp.ok) return;
      data.jobs.forEach(job => jobCache.set(job.id, job));
      const running = data.jobs.find(j => j.status === 'running');
      const queued = data.jobs.filter(j => j.status === 'queued').length;
      if (running) { state.textContent = 'running ' + running.model; state.dataset.status = 'running'; cancelBtn.classList.add('visible'); }
      else if (queued) { state.textContent = queued + ' 个排队中'; state.dataset.status = 'queued'; cancelBtn.classList.add('visible'); }
      else if (!streamingAbort) { state.textContent = 'ready'; state.dataset.status = ''; cancelBtn.classList.remove('visible'); }
      jobsEl.innerHTML = data.jobs.slice(0, 8).map(job => {
        if (streamedJobs.has(job.id)) return '';
        return '<button class="job ' + job.status + '" type="button" data-id="' + job.id + '" title="点击查看详情">' + job.status + ' · ' + job.model + '</button>';
      }).filter(Boolean).join('');
      data.jobs.forEach(job => {
        if (streamedJobs.has(job.id)) return;
        if ((job.status === 'done' || job.status === 'failed') && !seenDone.has(job.id)) {
          seenDone.add(job.id);
          add('assistant', job.status === 'done' ? job.reply : ('失败：' + job.error));
        }
      });
    }
    jobsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.job');
      if (!btn) return;
      const job = jobCache.get(btn.dataset.id);
      if (!job) return;
      const detail = job.status === 'done' ? job.reply : (job.status === 'failed' ? '失败：' + job.error : '排队中...');
      if (detail) add('assistant', '📋 任务 ' + job.id + '（' + job.model + '）\\n' + detail);
    });
    async function loadParadigms() {
      state.textContent = 'loading';
      try {
        const resp = await fetch('/api/tasks');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '加载范式失败');
        paradigmSelect.innerHTML = data.tasks.map(t => '<option value="' + t.path.replace(/"/g,'&quot;') + '">' + t.name + '</option>').join('');
        if (data.tasks[0]) {
          const detailResp = await fetch('/api/task?path=' + encodeURIComponent(data.tasks[0].path));
          const detailData = await detailResp.json();
          if (detailResp.ok) paradigmCache[data.tasks[0].path] = detailData.content || '';
        }
        // Restore saved slot content into cache
        slotParadigms.forEach(s => { if (s && s.content) paradigmCache[s.path] = s.content; });
        updateSlotUI();
        state.textContent = 'ready';
      } catch (err) {
        state.textContent = 'error';
        state.dataset.status = 'error';
        add('assistant', '范式加载失败：' + err.message);
      }
    }
    paradigmSelect.addEventListener('change', async () => {
      const path = paradigmSelect.value;
      updateSlotUI();
      if (!path || paradigmCache[path]) return;
      try {
        const resp = await fetch('/api/task?path=' + encodeURIComponent(path));
        const data = await resp.json();
        if (resp.ok) paradigmCache[path] = data.content || '';
      } catch {}
    });
    let clearPending = false;
    let clearTimer = null;
    clearHistory.addEventListener('click', async () => {
      if (!clearPending) {
        clearPending = true;
        clearHistory.classList.add('confirm');
        clearTimer = setTimeout(() => { clearPending = false; clearHistory.classList.remove('confirm'); }, 3000);
        return;
      }
      clearTimeout(clearTimer);
      clearPending = false;
      clearHistory.classList.remove('confirm');
      try {
        const resp = await fetch('/api/jobs/clear', {method:'POST'});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '清除失败');
        seenDone.clear();
        streamedJobs.clear();
        conversationHistory.length = 0;
        thread.innerHTML = '<div class="msg assistant"><div class="meta">Claude</div>历史已清除。</div>';
        await loadJobs();
      } catch (err) {
        add('assistant', '失败：' + err.message);
      }
    });
    state.textContent = '加载中...';
    Promise.all([loadConfig(), loadParadigms(), loadJobs()]).then(() => { state.textContent = 'ready'; }).catch(err => { state.textContent = 'error'; state.dataset.status = 'error'; add('assistant', '加载失败：' + err.message + '（请检查网络或刷新重试）'); });
    setInterval(loadJobs, 2500);
  </script>
</body>
</html>`;

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
      const jobRef = { _aborted: false, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseWrite(res, 'meta', { jobId: jobRef.id, model: normalizeModel(body.model) });

      req.on('close', () => { jobRef._aborted = true; });

      try {
        await runClaudeStreaming(body.message, task, body.model, res, jobRef, body.history);
      } catch (err) {
        if (!jobRef._aborted) sseWrite(res, 'error', { message: err.message || String(err) });
      }
      res.end();
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      const job = enqueueJob({ message: body.message, task, model: body.model, history: body.history });
      json(res, 202, { job: serializeJob(job) });
      return;
    }
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      json(res, 200, { activeJob: activeJob ? activeJob.id : null, jobs: jobs.map(serializeJob) });
      return;
    }
    if (url.pathname === '/api/job/cancel' && req.method === 'POST') {
      const target = activeJob || [...jobs].reverse().find((item) => item.status === 'queued');
      if (target && (target.status === 'running' || target.status === 'queued')) {
        target._aborted = true;
        target.status = 'cancelled';
        target.error = '用户取消';
        target.finishedAt = appNow().date + ' ' + appNow().time;
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
