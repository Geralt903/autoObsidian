#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const Anthropic = require('@anthropic-ai/sdk').default;
const XLSX = require('xlsx');

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
const MAX_TOOL_ROUNDS = parseInt(process.env.CLAUDE_MAX_TOOL_ROUNDS || '100', 10);
const JOB_HISTORY_LIMIT = parseInt(process.env.JOB_HISTORY_LIMIT || '20', 10);
const JOB_LOG_PATH = process.env.JOB_LOG_PATH || path.join(__dirname, 'job-events.log');
const JOB_LOG_MAX_BYTES = parseInt(process.env.JOB_LOG_MAX_BYTES || '5242880', 10);
const DATA_TOOL_MAX_CHARS = parseInt(process.env.DATA_TOOL_MAX_CHARS || '1000000', 10);
const DATA_TOOL_MAX_ROWS = parseInt(process.env.DATA_TOOL_MAX_ROWS || '20000', 10);
const TERMINAL_TOOL_ENABLED = process.env.TERMINAL_TOOL_ENABLED !== '0';
const TERMINAL_DEFAULT_CWD = process.env.TERMINAL_DEFAULT_CWD || path.resolve(__dirname, '..');
const TERMINAL_TIMEOUT_MS = parseInt(process.env.TERMINAL_TIMEOUT_MS || '120000', 10);
const TERMINAL_MAX_OUTPUT_CHARS = parseInt(process.env.TERMINAL_MAX_OUTPUT_CHARS || '60000', 10);

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
  {
    name: 'data_profile',
    description: '分析 CSV/TSV/Markdown 表格文本，返回列名、行数、样例、缺失值、唯一值数量和数值列统计。适合先了解账单、导出的 xlsx/csv、清单类附件。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '表格文本内容，支持 CSV、TSV 或 Markdown 表格' },
        delimiter: { type: 'string', description: '分隔符，可填 auto、comma、tab、semicolon、pipe，默认 auto' },
        hasHeader: { type: 'boolean', description: '第一行是否为表头，默认 true' },
        maxRows: { type: 'integer', description: `最多处理行数，默认 ${DATA_TOOL_MAX_ROWS}` },
      },
      required: ['text'],
    },
  },
  {
    name: 'data_filter_sort',
    description: '对 CSV/TSV/Markdown 表格文本做筛选、选择列、排序和限制返回行数。用于从附件中找特定日期、类别、金额范围等记录。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '表格文本内容' },
        delimiter: { type: 'string', description: '分隔符，可填 auto、comma、tab、semicolon、pipe，默认 auto' },
        hasHeader: { type: 'boolean', description: '第一行是否为表头，默认 true' },
        select: { type: 'array', items: { type: 'string' }, description: '要返回的列名列表，省略则返回全部列' },
        filters: {
          type: 'array',
          description: '筛选条件数组。op 支持 eq、neq、contains、gt、gte、lt、lte、between、in、empty、not_empty',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: { type: 'string' },
              value: {},
              value2: {},
            },
            required: ['column', 'op'],
          },
        },
        sortBy: { type: 'string', description: '排序列名' },
        sortDir: { type: 'string', description: 'asc 或 desc，默认 asc' },
        limit: { type: 'integer', description: '最多返回行数，默认 50' },
      },
      required: ['text'],
    },
  },
  {
    name: 'data_group',
    description: '对 CSV/TSV/Markdown 表格文本分组汇总。支持 count、sum、avg、min、max，用于账单按日期/类别汇总、统计金额等。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '表格文本内容' },
        delimiter: { type: 'string', description: '分隔符，可填 auto、comma、tab、semicolon、pipe，默认 auto' },
        hasHeader: { type: 'boolean', description: '第一行是否为表头，默认 true' },
        groupBy: { type: 'array', items: { type: 'string' }, description: '分组列名列表' },
        metrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'count、sum、avg、min、max' },
              column: { type: 'string', description: 'count 可省略 column' },
              as: { type: 'string', description: '输出字段名' },
            },
            required: ['op'],
          },
        },
        sortBy: { type: 'string', description: '排序列名' },
        sortDir: { type: 'string', description: 'asc 或 desc，默认 asc' },
        limit: { type: 'integer', description: '最多返回组数，默认 100' },
      },
      required: ['text', 'groupBy', 'metrics'],
    },
  },
  {
    name: 'data_dedupe',
    description: '对 CSV/TSV/Markdown 表格文本去重，返回重复统计和去重后的行。用于账单/清单附件按日期、金额、备注等字段判断重复。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '表格文本内容' },
        delimiter: { type: 'string', description: '分隔符，可填 auto、comma、tab、semicolon、pipe，默认 auto' },
        hasHeader: { type: 'boolean', description: '第一行是否为表头，默认 true' },
        keyColumns: { type: 'array', items: { type: 'string' }, description: '用于判断重复的列名；省略时用整行' },
        keep: { type: 'string', description: 'first 或 last，默认 first' },
        limit: { type: 'integer', description: '最多返回重复样例数，默认 50' },
      },
      required: ['text'],
    },
  },
  {
    name: 'terminal_exec',
    description: '执行本机真实终端命令，拥有运行当前 Node 服务用户的完整 shell 权限。用于用户明确要求执行命令、读写本地文件、运行测试、安装依赖、启动脚本或检查系统状态时。此工具会执行 bash -lc，不做命令沙箱。',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要执行的 shell 命令，会通过 bash -lc 执行' },
        cwd: { type: 'string', description: `工作目录，默认 ${TERMINAL_DEFAULT_CWD}` },
        timeoutMs: { type: 'integer', description: `超时时间毫秒，默认 ${TERMINAL_TIMEOUT_MS}，最大 600000` },
        maxOutputChars: { type: 'integer', description: `最多返回 stdout/stderr 字符数，默认 ${TERMINAL_MAX_OUTPUT_CHARS}` },
      },
      required: ['cmd'],
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
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch (e) {
    throw new Error('请求数据格式错误，附件可能太大');
  }
}

function truncateForLog(value, limit = 500) {
  if (value === undefined || value === null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + `...<${text.length - limit} more>` : text;
}

function appendJobLog(job, event, data = {}) {
  try {
    if (fs.existsSync(JOB_LOG_PATH) && fs.statSync(JOB_LOG_PATH).size > JOB_LOG_MAX_BYTES) {
      fs.renameSync(JOB_LOG_PATH, JOB_LOG_PATH + '.1');
    }
    const now = appNow();
    const line = JSON.stringify({
      ts: `${now.date} ${now.time}`,
      event,
      jobId: job?.id || data.jobId || '',
      status: job?.status || data.status || '',
      stage: job?.stage || data.stage || '',
      round: job?.round || data.round || 0,
      toolName: job?.toolName || data.toolName || '',
      progressText: truncateForLog(job?.progressText || data.progressText || '', 300),
      details: truncateForLog(job?.progressDetails || data.details || '', 500),
      error: truncateForLog(job?.error || data.error || '', 500),
      message: truncateForLog(job?.message || data.message || '', 500),
      extra: data.extra ? truncateForLog(data.extra, 1000) : undefined,
    });
    fs.appendFile(JOB_LOG_PATH, line + '\n', () => {});
  } catch {}
}

function readJobLogs({ id = '', limit = 200 } = {}) {
  try {
    const raw = fs.readFileSync(JOB_LOG_PATH, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).slice(-Math.max(limit * 4, limit));
    const logs = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!id || item.jobId === id) logs.push(item);
      } catch {}
    }
    return logs.slice(-limit);
  } catch {
    return [];
  }
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

function addDateDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthKeysBetween(startDate, endDate) {
  const out = [];
  const d = new Date(`${startDate.slice(0, 7)}-01T12:00:00Z`);
  const endKey = endDate.slice(0, 7);
  while (true) {
    const key = d.toISOString().slice(0, 7);
    out.push(key);
    if (key === endKey) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    value = value.replace(/^["']|["']$/g, '');
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    data[m[1]] = value;
  }
  return data;
}

function setJobProgress(job, stage, progressText, extra = {}) {
  if (!job) return null;
  const now = appNow();
  const progressUpdatedAt = `${now.date} ${now.time}`;
  job.stage = stage;
  job.progressText = progressText;
  job.progressUpdatedAt = progressUpdatedAt;
  if (Object.prototype.hasOwnProperty.call(extra, 'toolName')) job.toolName = extra.toolName || '';
  if (Object.prototype.hasOwnProperty.call(extra, 'round')) job.round = extra.round || 0;
  if (Object.prototype.hasOwnProperty.call(extra, 'details')) job.progressDetails = extra.details || '';
  if (!Array.isArray(job.progressLog)) job.progressLog = [];
  const entry = {
    time: progressUpdatedAt,
    stage,
    text: progressText,
    toolName: job.toolName || '',
    details: job.progressDetails || '',
    round: job.round || 0,
  };
  const last = job.progressLog[job.progressLog.length - 1];
  if (!last || last.stage !== entry.stage || last.text !== entry.text || last.toolName !== entry.toolName || last.details !== entry.details) {
    job.progressLog.push(entry);
    if (job.progressLog.length > 80) job.progressLog = job.progressLog.slice(-80);
    appendJobLog(job, 'progress', { details: entry.details, round: entry.round, toolName: entry.toolName });
  }
  return {
    stage: job.stage,
    progressText: job.progressText,
    progressUpdatedAt: job.progressUpdatedAt,
    toolName: job.toolName || '',
    details: job.progressDetails || '',
    round: job.round || 0,
    progressLog: job.progressLog || [],
  };
}

function emitJobProgress(res, job, stage, progressText, extra = {}) {
  const payload = setJobProgress(job, stage, progressText, extra);
  if (payload && res) sseWrite(res, 'progress', payload);
  return payload;
}

function dataToolText(input) {
  const text = String(input?.text || '');
  if (!text.trim()) throw new Error('data tool text is required');
  if (text.length > DATA_TOOL_MAX_CHARS) {
    throw new Error(`数据过大：${text.length} 字符，当前上限 ${DATA_TOOL_MAX_CHARS}。请先缩小范围或拆分处理。`);
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function delimiterValue(name, sample) {
  const v = String(name || 'auto').toLowerCase();
  if (v === 'comma') return ',';
  if (v === 'tab') return '\t';
  if (v === 'semicolon') return ';';
  if (v === 'pipe') return '|';
  const first = String(sample || '').split('\n').find((line) => line.trim()) || '';
  const counts = [
    [',', (first.match(/,/g) || []).length],
    ['\t', (first.match(/\t/g) || []).length],
    [';', (first.match(/;/g) || []).length],
    ['|', (first.match(/\|/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseDelimitedLine(line, delimiter) {
  const out = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quote && line[i + 1] === '"') { cur += '"'; i++; }
      else quote = !quote;
    } else if (ch === delimiter && !quote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseTable(input = {}) {
  const text = dataToolText(input);
  const maxRows = Math.min(Math.max(parseInt(input.maxRows || DATA_TOOL_MAX_ROWS, 10) || DATA_TOOL_MAX_ROWS, 1), DATA_TOOL_MAX_ROWS);
  const hasHeader = input.hasHeader !== false;
  const lines = text.split('\n').filter((line) => line.trim());
  const markdown = lines.some((line) => /^\s*\|/.test(line));
  let delimiter = delimiterValue(input.delimiter, text);
  let rawRows;
  if (markdown) {
    delimiter = '|';
    rawRows = lines
      .filter((line) => line.includes('|') && !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line))
      .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, ''))
      .map((line) => parseDelimitedLine(line, '|'));
  } else {
    rawRows = lines.map((line) => parseDelimitedLine(line, delimiter));
  }
  if (!rawRows.length) throw new Error('未解析到表格行');
  let headers;
  let rows;
  if (hasHeader) {
    headers = rawRows[0].map((h, i) => h || `col${i + 1}`);
    rows = rawRows.slice(1, maxRows + 1);
  } else {
    const width = Math.max(...rawRows.map((r) => r.length));
    headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    rows = rawRows.slice(0, maxRows);
  }
  const seen = new Map();
  headers = headers.map((h, i) => {
    const base = String(h || `col${i + 1}`).trim() || `col${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  const objects = rows.map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] === undefined ? '' : row[i]; });
    return obj;
  });
  return { headers, rows: objects, rowCount: Math.max(rawRows.length - (hasHeader ? 1 : 0), 0), parsedRows: objects.length, truncated: rawRows.length - (hasHeader ? 1 : 0) > objects.length, delimiter };
}

function numericValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[,\s¥￥$]/g, '');
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function compareValues(a, b) {
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''), 'zh-CN', { numeric: true });
}

function applyDataFilters(rows, filters = []) {
  if (!Array.isArray(filters) || !filters.length) return rows;
  return rows.filter((row) => filters.every((f) => {
    const value = row[f.column] ?? '';
    const op = String(f.op || 'eq').toLowerCase();
    const text = String(value);
    const target = f.value;
    const n = numericValue(value);
    const tn = numericValue(target);
    if (op === 'eq') return text === String(target ?? '');
    if (op === 'neq') return text !== String(target ?? '');
    if (op === 'contains') return text.includes(String(target ?? ''));
    if (op === 'empty') return !text.trim();
    if (op === 'not_empty') return Boolean(text.trim());
    if (op === 'in') return Array.isArray(target) ? target.map(String).includes(text) : String(target ?? '').split(',').map((x) => x.trim()).includes(text);
    if (op === 'gt') return n !== null && tn !== null && n > tn;
    if (op === 'gte') return n !== null && tn !== null && n >= tn;
    if (op === 'lt') return n !== null && tn !== null && n < tn;
    if (op === 'lte') return n !== null && tn !== null && n <= tn;
    if (op === 'between') {
      const t2 = numericValue(f.value2);
      return n !== null && tn !== null && t2 !== null && n >= tn && n <= t2;
    }
    return true;
  }));
}

function dataProfile(input) {
  const table = parseTable(input);
  const columns = table.headers.map((h) => {
    const values = table.rows.map((r) => r[h]);
    const filled = values.filter((v) => String(v ?? '').trim()).length;
    const unique = new Set(values.map((v) => String(v ?? ''))).size;
    const nums = values.map(numericValue).filter((n) => n !== null);
    const col = { name: h, filled, missing: table.parsedRows - filled, unique };
    if (nums.length) {
      const sum = nums.reduce((a, b) => a + b, 0);
      col.numeric = {
        count: nums.length,
        sum: Number(sum.toFixed(6)),
        avg: Number((sum / nums.length).toFixed(6)),
        min: Math.min(...nums),
        max: Math.max(...nums),
      };
    }
    return col;
  });
  return { rowCount: table.rowCount, parsedRows: table.parsedRows, truncated: table.truncated, delimiter: table.delimiter, headers: table.headers, sample: table.rows.slice(0, 5), columns };
}

function dataFilterSort(input) {
  const table = parseTable(input);
  let rows = applyDataFilters(table.rows, input.filters);
  if (input.sortBy) {
    const dir = String(input.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => compareValues(a[input.sortBy], b[input.sortBy]) * dir);
  }
  const select = Array.isArray(input.select) && input.select.length ? input.select : table.headers;
  const limit = Math.min(Math.max(parseInt(input.limit || '50', 10) || 50, 1), 500);
  const limited = rows.slice(0, limit).map((row) => {
    const obj = {};
    select.forEach((h) => { obj[h] = row[h] ?? ''; });
    return obj;
  });
  return { inputRows: table.rowCount, matchedRows: rows.length, returnedRows: limited.length, truncated: rows.length > limited.length, rows: limited };
}

function dataGroup(input) {
  const table = parseTable(input);
  const groupBy = Array.isArray(input.groupBy) ? input.groupBy : [];
  const metrics = Array.isArray(input.metrics) ? input.metrics : [];
  if (!groupBy.length) throw new Error('groupBy is required');
  if (!metrics.length) throw new Error('metrics is required');
  const groups = new Map();
  for (const row of table.rows) {
    const keyParts = groupBy.map((h) => row[h] ?? '');
    const key = JSON.stringify(keyParts);
    if (!groups.has(key)) groups.set(key, { keyParts, rows: [] });
    groups.get(key).rows.push(row);
  }
  let rows = Array.from(groups.values()).map((g) => {
    const out = {};
    groupBy.forEach((h, i) => { out[h] = g.keyParts[i]; });
    for (const metric of metrics) {
      const op = String(metric.op || 'count').toLowerCase();
      const col = metric.column || '';
      const name = metric.as || (col ? `${op}_${col}` : op);
      const nums = col ? g.rows.map((r) => numericValue(r[col])).filter((n) => n !== null) : [];
      if (op === 'count') out[name] = g.rows.length;
      else if (op === 'sum') out[name] = Number(nums.reduce((a, b) => a + b, 0).toFixed(6));
      else if (op === 'avg') out[name] = nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(6)) : null;
      else if (op === 'min') out[name] = nums.length ? Math.min(...nums) : null;
      else if (op === 'max') out[name] = nums.length ? Math.max(...nums) : null;
    }
    return out;
  });
  if (input.sortBy) {
    const dir = String(input.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    rows = rows.sort((a, b) => compareValues(a[input.sortBy], b[input.sortBy]) * dir);
  }
  const limit = Math.min(Math.max(parseInt(input.limit || '100', 10) || 100, 1), 500);
  return { inputRows: table.rowCount, groupCount: rows.length, returnedRows: Math.min(rows.length, limit), truncated: rows.length > limit, rows: rows.slice(0, limit) };
}

function dataDedupe(input) {
  const table = parseTable(input);
  const keyColumns = Array.isArray(input.keyColumns) && input.keyColumns.length ? input.keyColumns : table.headers;
  const keepLast = String(input.keep || 'first').toLowerCase() === 'last';
  const map = new Map();
  const dupes = [];
  table.rows.forEach((row, index) => {
    const key = JSON.stringify(keyColumns.map((h) => String(row[h] ?? '').trim()));
    if (map.has(key)) {
      const first = map.get(key);
      first.count++;
      if (keepLast) first.row = row;
      if (dupes.length < Math.min(parseInt(input.limit || '50', 10) || 50, 100)) dupes.push({ key: keyColumns.reduce((obj, h) => ({ ...obj, [h]: row[h] ?? '' }), {}), firstIndex: first.firstIndex, duplicateIndex: index });
    } else {
      map.set(key, { row, count: 1, firstIndex: index });
    }
  });
  const rows = Array.from(map.values()).map((item) => item.row);
  return { inputRows: table.rowCount, uniqueRows: rows.length, duplicateRows: table.rows.length - rows.length, keyColumns, duplicates: dupes, rows: rows.slice(0, Math.min(parseInt(input.limit || '50', 10) || 50, 100)) };
}

function appendLimited(target, chunk, limit) {
  const next = target + chunk;
  if (next.length <= limit) return { text: next, truncated: false };
  return { text: next.slice(0, limit), truncated: true };
}

function runTerminalCommand(input = {}) {
  if (!TERMINAL_TOOL_ENABLED) throw new Error('terminal_exec is disabled by TERMINAL_TOOL_ENABLED=0');
  const cmd = String(input.cmd || '').trim();
  if (!cmd) throw new Error('terminal_exec cmd is required');
  const cwd = input.cwd ? path.resolve(String(input.cwd)) : TERMINAL_DEFAULT_CWD;
  const timeoutMs = Math.min(Math.max(parseInt(input.timeoutMs || TERMINAL_TIMEOUT_MS, 10) || TERMINAL_TIMEOUT_MS, 1000), 600000);
  const maxOutputChars = Math.min(Math.max(parseInt(input.maxOutputChars || TERMINAL_MAX_OUTPUT_CHARS, 10) || TERMINAL_MAX_OUTPUT_CHARS, 1000), 200000);
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    }, timeoutMs);
    child.stdout.on('data', (buf) => {
      const res = appendLimited(stdout, buf.toString('utf8'), maxOutputChars);
      stdout = res.text;
      stdoutTruncated = stdoutTruncated || res.truncated;
    });
    child.stderr.on('data', (buf) => {
      const res = appendLimited(stderr, buf.toString('utf8'), maxOutputChars);
      stderr = res.text;
      stderrTruncated = stderrTruncated || res.truncated;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, cmd, cwd, startedAt, finishedAt: new Date().toISOString(), error: err.message || String(err), stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        cmd,
        cwd,
        exitCode: code,
        signal,
        timedOut,
        timeoutMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
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
- 遇到 CSV、XLSX 转出的 CSV、Markdown 表格、账单清单等结构化数据时，优先使用 data_profile / data_filter_sort / data_group / data_dedupe 做统计、筛选、汇总和去重，不要靠肉眼通读大表。
- terminal_exec 是真实本机 shell，拥有当前服务用户的完整权限。只有在用户要求执行终端命令、运行测试/脚本、安装依赖、检查本地文件或系统状态时使用。不要把终端输出日志写进笔记，除非用户明确要求。
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
    case 'data_profile':
      return dataProfile(input);
    case 'data_filter_sort':
      return dataFilterSort(input);
    case 'data_group':
      return dataGroup(input);
    case 'data_dedupe':
      return dataDedupe(input);
    case 'terminal_exec':
      return await runTerminalCommand(input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Model normalization ──────────────────────────────────────────

function normalizeModel(model) {
  if (!model) return DEFAULT_CLAUDE_MODEL;
  return CLAUDE_MODELS.includes(model) ? model : DEFAULT_CLAUDE_MODEL;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  if (input.vault) parts.push(`vault=${input.vault}`);
  if (input.keyword) parts.push(`keyword=${input.keyword}`);
  if (input.prefix) parts.push(`prefix=${input.prefix}`);
  if (input.path) parts.push(`path=${input.path}`);
  if (input.groupBy) parts.push(`groupBy=${Array.isArray(input.groupBy) ? input.groupBy.join(',') : input.groupBy}`);
  if (input.sortBy) parts.push(`sortBy=${input.sortBy}`);
  if (input.keyColumns) parts.push(`keyColumns=${Array.isArray(input.keyColumns) ? input.keyColumns.join(',') : input.keyColumns}`);
  if (input.filters) parts.push(`filters=${Array.isArray(input.filters) ? input.filters.length : 1}`);
  if (input.text) parts.push(`text=${String(input.text).length} chars`);
  if (input.cmd) parts.push(`cmd=${String(input.cmd).slice(0, 100)}${String(input.cmd).length > 100 ? '...' : ''}`);
  if (input.cwd) parts.push(`cwd=${input.cwd}`);
  if (input.old) parts.push(`old=${String(input.old).slice(0, 60)}`);
  if (input.new) parts.push(`new=${String(input.new).slice(0, 60)}`);
  if (input.content) parts.push(`content=${String(input.content).slice(0, 80)}${String(input.content).length > 80 ? '...' : ''}`);
  return parts.join(' · ');
}

// ── Run Claude with tool-use loop (non-streaming) ────────────────

function buildUserContent(userText, files) {
  if (!files || !files.length) return userText;
  // Non-image file content is already in userText (client-side concatenation)
  // Only handle images here
  const content = [{ type: 'text', text: userText }];
  for (const f of files) {
    if (f.isImage && f.data) {
      const parts = f.data.split(',');
      const b64 = parts.length > 1 ? parts[1] : parts[0];
      content.push({ type: 'image', source: { type: 'base64', media_type: f.type || 'image/png', data: b64 } });
    }
  }
  return content;
}

function hasMessageOrFiles(body) {
  return Boolean(String(body?.message || '').trim() || (Array.isArray(body?.files) && body.files.length > 0));
}

function compactHistoryText(value, maxChars = 5000) {
  let text = typeof value === 'string' ? value : '';
  if (!text) return '';
  text = text.replace(/data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,[A-Za-z0-9+/=]+/g, '[已省略 Excel 原始 base64，附件内容已单独解析]');
  text = text.replace(/UEsDB[A-Za-z0-9+/=]{1000,}/g, '[已省略疑似 XLSX/base64 大块内容]');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n[历史消息已截断]' : text;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let total = 0;
  for (const msg of history.slice(-8).reverse()) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    let content = compactHistoryText(msg.content);
    if (!content.trim()) continue;
    const remain = 18000 - total;
    if (remain <= 500) break;
    if (content.length > remain) content = content.slice(0, remain) + '\n[历史上下文预算已截断]';
    total += content.length;
    out.unshift({ role: msg.role, content });
  }
  return out;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

async function* withIterableTimeout(iterable, ms, message) {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let timer;
    const nextPromise = iterator.next();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    const next = await Promise.race([
      nextPromise,
      timeout,
    ]);
    clearTimeout(timer);
    if (next.done) return;
    yield next.value;
  }
}

function emptyModelReplyError(rounds) {
  return `模型在第 ${rounds} 轮返回空内容，任务未完成。请用单轮模式重试，或缩小读取范围后继续执行。`;
}

async function runClaude(userText, task, model, jobRef, history, files) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const userContent = buildUserContent(userText, files);

  const messages = [...sanitizeHistory(history), { role: 'user', content: userContent }];
  let reply = '';
  let rounds = 0;
  let completed = false;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (jobRef && jobRef._aborted) throw new Error('任务已取消');
    if (jobRef) jobRef._disconnected = jobRef._disconnected || false;
    rounds++;
    setJobProgress(jobRef, 'thinking', rounds === 1 ? '正在请求模型生成' : '等待模型处理工具返回', { round: rounds });
    appendJobLog(jobRef, 'model_request_start', { round: rounds, extra: { messages: messages.length } });

    const response = await withTimeout(anthropic.messages.create({
      model: selectedModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
      tools: FNS_TOOLS,
    }), CLAUDE_TIMEOUT_MS, `模型第 ${rounds} 轮请求超过 ${Math.round(CLAUDE_TIMEOUT_MS / 1000)} 秒，任务未完成`);
    appendJobLog(jobRef, 'model_response_done', { round: rounds, extra: { contentBlocks: response.content.length } });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');

    reply = textBlocks.map((b) => b.text).join('\n').trim();

    if (toolBlocks.length === 0) { completed = true; break; }

    const toolResults = [];
    for (const tool of toolBlocks) {
      const details = summarizeToolInput(tool.input);
      try {
        setJobProgress(jobRef, 'tool', `正在执行工具 ${tool.name}`, { toolName: tool.name, round: rounds, details });
        const result = await executeToolCall(tool.name, tool.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });
        setJobProgress(jobRef, 'thinking', `工具 ${tool.name} 已返回结果，等待模型处理`, { toolName: tool.name, round: rounds, details });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify({ error: err.message || String(err) }),
          is_error: true,
        });
        setJobProgress(jobRef, 'error', `工具 ${tool.name} 执行失败`, { toolName: tool.name, round: rounds, details });
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  if (!completed) {
    const message = `工具调用达到上限 ${MAX_TOOL_ROUNDS} 轮，任务未完成。请缩小附件范围或继续执行剩余部分。`;
    setJobProgress(jobRef, 'error', message, { round: rounds });
    throw new Error(message);
  }
  if (!reply.trim()) {
    const message = emptyModelReplyError(rounds);
    setJobProgress(jobRef, 'error', message, { round: rounds });
    throw new Error(message);
  }
  return reply;
}

// ── SSE helpers ──────────────────────────────────────────────────

function sseWrite(res, event, data) {
  if (!res || res.destroyed || res.writableEnded || res.writableDestroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function sseEnd(res) {
  if (!res || res.destroyed || res.writableEnded || res.writableDestroyed) return;
  try { res.end(); } catch {}
}

// ── Run Claude with streaming ────────────────────────────────────

async function runClaudeStreaming(userText, task, model, res, jobRef, history, files) {
  if (!ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_AUTH_TOKEN is not set');

  const selectedModel = normalizeModel(model);
  const systemPrompt = buildSystemPrompt(task);
  const userContent = buildUserContent(userText, files);
  const messages = [...sanitizeHistory(history), { role: 'user', content: userContent }];
  let fullReply = '';
  let rounds = 0;
  let completed = false;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (jobRef && jobRef._aborted) throw new Error('任务已取消');
    if (jobRef) jobRef._disconnected = jobRef._disconnected || false;
    rounds++;
    emitJobProgress(res, jobRef, 'thinking', rounds === 1 ? '正在请求模型生成' : '等待模型处理工具返回', { round: rounds });
    appendJobLog(jobRef, 'model_stream_start', { round: rounds, extra: { messages: messages.length } });

    const stream = await withTimeout(anthropic.messages.create({
      model: selectedModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: FNS_TOOLS,
      stream: true,
    }), CLAUDE_TIMEOUT_MS, `模型第 ${rounds} 轮请求超过 ${Math.round(CLAUDE_TIMEOUT_MS / 1000)} 秒，任务未完成`);

    let contentBlocks = [];
    let currentToolUse = null;
    let currentText = '';
    const streamStats = {};

    for await (const event of withIterableTimeout(stream, CLAUDE_TIMEOUT_MS, `模型第 ${rounds} 轮流式响应超过 ${Math.round(CLAUDE_TIMEOUT_MS / 1000)} 秒，任务未完成`)) {
      streamStats[event.type] = (streamStats[event.type] || 0) + 1;
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
            if (jobRef) jobRef.partialReply = (jobRef.partialReply || '') + event.delta.text;
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
            emitJobProgress(res, jobRef, 'tool', `准备执行工具 ${currentToolUse.name}`, { toolName: currentToolUse.name, round: rounds, details: summarizeToolInput(currentToolUse.input) });
            sseWrite(res, 'tool', { name: currentToolUse.name, status: 'running' });
            currentToolUse = null;
          }
          break;
      }
    }
    appendJobLog(jobRef, 'model_stream_done', { round: rounds, extra: { contentBlocks: contentBlocks.length, events: streamStats } });

    if (contentBlocks.length === 0) {
      appendJobLog(jobRef, 'model_stream_empty_retry', { round: rounds, extra: { messages: messages.length } });
      emitJobProgress(res, jobRef, 'thinking', `第 ${rounds} 轮流式返回为空，改用非流式重试`, { round: rounds });
      const retryResponse = await withTimeout(anthropic.messages.create({
        model: selectedModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: FNS_TOOLS,
      }), CLAUDE_TIMEOUT_MS, `模型第 ${rounds} 轮非流式重试超过 ${Math.round(CLAUDE_TIMEOUT_MS / 1000)} 秒，任务未完成`);
      contentBlocks = Array.isArray(retryResponse.content) ? retryResponse.content : [];
      appendJobLog(jobRef, 'model_retry_done', {
        round: rounds,
        extra: {
          contentBlocks: contentBlocks.length,
          stopReason: retryResponse.stop_reason || '',
          usage: retryResponse.usage || null,
        },
      });
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          if (jobRef) jobRef.partialReply = (jobRef.partialReply || '') + block.text;
          sseWrite(res, 'text', { delta: block.text });
        } else if (block.type === 'tool_use') {
          emitJobProgress(res, jobRef, 'tool', `准备执行工具 ${block.name}`, { toolName: block.name, round: rounds, details: summarizeToolInput(block.input) });
          sseWrite(res, 'tool', { name: block.name, status: 'running' });
        }
      }
    }

    const toolBlocks = contentBlocks.filter((b) => b.type === 'tool_use');
    const textBlocks = contentBlocks.filter((b) => b.type === 'text');
    fullReply = textBlocks.map((b) => b.text).join('\n').trim();

    if (toolBlocks.length === 0) { completed = true; break; }

    const toolResults = [];
    for (const tool of toolBlocks) {
      const details = summarizeToolInput(tool.input);
      try {
        emitJobProgress(res, jobRef, 'tool', `正在执行工具 ${tool.name}`, { toolName: tool.name, round: rounds, details });
        const result = await executeToolCall(tool.name, tool.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
        emitJobProgress(res, jobRef, 'thinking', `工具 ${tool.name} 已返回结果，等待模型处理`, { toolName: tool.name, round: rounds, details });
        sseWrite(res, 'tool', { name: tool.name, status: 'done' });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify({ error: err.message || String(err) }),
          is_error: true,
        });
        emitJobProgress(res, jobRef, 'error', `工具 ${tool.name} 执行失败`, { toolName: tool.name, round: rounds, details });
        sseWrite(res, 'tool', { name: tool.name, status: 'error', error: err.message || String(err) });
      }
    }

    messages.push({ role: 'assistant', content: contentBlocks });
    messages.push({ role: 'user', content: toolResults });
  }

  if (!completed) {
    const message = `工具调用达到上限 ${MAX_TOOL_ROUNDS} 轮，任务未完成。请缩小附件范围或继续执行剩余部分。`;
    emitJobProgress(res, jobRef, 'error', message, { round: rounds });
    throw new Error(message);
  }
  if (!fullReply.trim()) {
    const message = emptyModelReplyError(rounds);
    emitJobProgress(res, jobRef, 'error', message, { round: rounds });
    throw new Error(message);
  }
  emitJobProgress(res, jobRef, 'done', '任务完成');
  sseWrite(res, 'done', { reply: fullReply });
  if (jobRef) jobRef.reply = fullReply;
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
    partialReply: job.partialReply || '',
    error: job.error || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    stage: job.stage || job.status || '',
    progressText: job.progressText || '',
    progressUpdatedAt: job.progressUpdatedAt || '',
    toolName: job.toolName || '',
    round: job.round || 0,
    progressLog: Array.isArray(job.progressLog) ? job.progressLog : [],
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
    stage: 'queued',
    progressText: '排队中',
    progressUpdatedAt: `${now.date} ${now.time}`,
    toolName: '',
    round: 0,
    progressLog: [{ time: `${now.date} ${now.time}`, stage: 'queued', text: '排队中', toolName: '', round: 0 }],
    _aborted: false,
  };
  jobs.unshift(job);
  trimJobs();
  appendJobLog(job, 'queued');
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
  setJobProgress(job, 'thinking', '开始处理任务');
  appendJobLog(job, 'started');
  try {
    job.reply = await runClaude(job.message, job.task, job.model, job, job.history, job.files);
    if (job._aborted) return;
    job.status = 'done';
    setJobProgress(job, 'done', '任务完成');
    appendJobLog(job, 'done');
  } catch (err) {
    if (job._aborted) return;
    job.error = err.message || String(err);
    job.status = 'failed';
    setJobProgress(job, 'error', job.error || '任务失败');
    appendJobLog(job, 'failed');
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
    .state{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 10px;white-space:nowrap;background:rgba(255,255,255,.03);transition:all .3s;max-width:min(220px,34vw);overflow:hidden;text-overflow:ellipsis;flex-shrink:1}
    .cancel-btn{display:none;height:30px;width:30px;min-width:30px;border:1px solid var(--bad);border-radius:50%;background:transparent;color:var(--bad);font-size:14px;cursor:pointer;padding:0;line-height:1}
    .cancel-btn.visible{display:inline-flex;align-items:center;justify-content:center}
    .state[data-status="running"]{color:var(--accent);border-color:rgba(212,165,116,.45);animation:pulse 1.6s ease-in-out infinite}
    .state[data-status="queued"]{color:var(--accent-2);border-color:rgba(218,165,32,.35)}
    .state[data-status="error"]{color:var(--bad);border-color:rgba(255,145,135,.4)}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
    /* conversation layout */
    .conv-layout{display:flex;width:100%;max-width:100vw;min-width:0;min-height:0;flex:1;overflow:hidden;height:100%}
    .conv-sidebar{width:260px;min-width:260px;border-right:1px solid rgba(255,255,255,.04);background:rgba(10,14,13,.55);display:flex;flex-direction:column;overflow:hidden;backdrop-filter:blur(12px)}
    .conv-sidebar-header{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:8px}
    .conv-sidebar-header span{font-size:13px;font-weight:700;color:var(--muted)}
    .conv-list{flex:1;overflow-y:auto;padding:6px 8px}
    .conv-item{padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:3px;transition:all .15s;border:1px solid transparent}
    .conv-item:hover{background:rgba(255,255,255,.03)}
    .conv-item.active{background:rgba(100,210,193,.06);border-color:rgba(100,210,193,.15)}
    .conv-item-title{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .conv-item-meta{font-size:11px;color:var(--muted);margin-top:2px;display:flex;gap:8px;align-items:center}
    .conv-item.running .conv-item-title{color:var(--accent-2)}
    .thinking-dots{display:inline-flex;gap:2px;align-items:center}
    .thinking-dots span{width:4px;height:4px;border-radius:50%;background:var(--accent-2);animation:thinkBounce 1.2s infinite}
    .thinking-dots span:nth-child(2){animation-delay:.2s}
    .thinking-dots span:nth-child(3){animation-delay:.4s}
    @keyframes thinkBounce{0%,60%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
    .msg.thinking{border-left-color:var(--accent-2);animation:pulse 1.5s ease-in-out infinite}
    .progress-line{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--muted);font-size:13px;min-width:0}
    .progress-line .progress-track{position:relative;flex:1;min-width:72px;height:3px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.08)}
    .progress-line .progress-track::after{content:"";position:absolute;inset:0;width:42%;border-radius:999px;background:linear-gradient(90deg,transparent,var(--accent-2),transparent);animation:progressSweep 1.25s ease-in-out infinite}
    @keyframes progressSweep{0%{transform:translateX(-110%)}100%{transform:translateX(250%)}}
    .progress-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .conv-item .status-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0;margin-top:5px}
    .status-dot.running{background:var(--accent-2);animation:pulse 1.2s infinite;box-shadow:0 0 6px rgba(100,210,193,.5)}
    .status-dot.done{background:var(--ok);box-shadow:0 0 4px rgba(143,229,167,.3)}
    .status-dot.failed{background:var(--bad);box-shadow:0 0 4px rgba(255,145,135,.3)}
    .status-dot.cancelled{background:var(--bad);box-shadow:0 0 4px rgba(255,145,135,.3)}
    .status-dot.queued{background:var(--accent);box-shadow:0 0 4px rgba(212,165,116,.3)}
    #newConvBtn{width:100%;height:36px;margin:8px;border:1px dashed var(--line);border-radius:8px;background:transparent;color:var(--muted);font-size:13px;cursor:pointer;font-weight:650}
    #newConvBtn:hover{border-color:var(--accent-2);color:var(--text)}
    main{padding:14px;overflow:auto;overflow-x:hidden;min-width:0;max-width:100%;flex:1 1 0;width:0}
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);gap:8px}
    .empty-state .icon{font-size:40px;opacity:.3}
    .empty-state .text{font-size:14px}
    select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 10px;font:inherit;min-width:0;max-width:100%;outline:none;text-overflow:ellipsis;transition:border-color .2s,box-shadow .2s}
    select:focus,textarea:focus{border-color:rgba(212,165,116,.5);box-shadow:0 0 0 3px rgba(212,165,116,.1),0 0 20px rgba(212,165,116,.05)}
    #page-chat{width:100%;min-width:0;max-width:100%;overflow-x:hidden}
    .thread{width:100%;max-width:880px;min-width:0;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:4px;overflow-x:hidden}
    .msg{border-radius:14px;padding:14px 16px;line-height:1.65;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;box-shadow:0 2px 16px rgba(0,0,0,.2);animation:msgIn .12s ease-out;min-width:0;max-width:100%;overflow-x:auto}
    .msg *{max-width:100%;min-width:0;overflow-wrap:anywhere}
    .msg pre{max-width:100%;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
    .msg code{white-space:pre-wrap;word-break:break-word}
    .msg table{max-width:100%;overflow-x:auto}
    .msg th,.msg td{overflow-wrap:anywhere;word-break:break-word}
    .ops-log{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06);color:var(--muted);font-size:12px;line-height:1.55}
    .ops-log summary{cursor:pointer;color:var(--accent-2);font-weight:650;outline:none}
    .ops-log div{margin-top:4px;overflow-wrap:anywhere}
    .msg.user{margin-left:auto;max-width:min(760px,92%);background:linear-gradient(135deg,rgba(212,165,116,.1),rgba(212,165,116,.04));border:1px solid rgba(212,165,116,.18);border-right:3px solid rgba(212,165,116,.45);box-shadow:0 2px 16px rgba(212,165,116,.06)}
    .msg.assistant{margin-right:auto;max-width:min(820px,100%);background:linear-gradient(135deg,rgba(100,210,193,.05),rgba(100,210,193,.01));border:1px solid rgba(100,210,193,.08);border-left:3px solid rgba(100,210,193,.3);box-shadow:0 2px 16px rgba(100,210,193,.04)}
    @keyframes msgIn{from{opacity:0}to{opacity:1}}
    .meta{font-size:12px;color:var(--muted);margin-bottom:4px}
    .scroll-hint{position:sticky;bottom:6px;display:none;margin:8px auto 0;height:34px;min-width:100px;border:1px solid rgba(100,210,193,.4);border-radius:999px;background:rgba(16,20,19,.94);color:var(--accent-2);font-size:13px;font-weight:650;cursor:pointer;backdrop-filter:blur(12px);box-shadow:0 4px 20px rgba(0,0,0,.4),0 0 12px rgba(100,210,193,.1)}
    .scroll-hint.visible{display:block}
    .typing-dots{display:inline-flex;gap:3px;align-items:center}
    .typing-dots span{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:dotPulse 1.2s infinite}
    .typing-dots span:nth-child(2){animation-delay:.2s}
    .typing-dots span:nth-child(3){animation-delay:.4s}
    @keyframes dotPulse{0%,60%{opacity:.2}30%{opacity:1}}
    .tool-note{font-size:12px;color:var(--muted);margin-top:6px;font-style:italic}
    form{width:100%;max-width:100vw;min-width:0;z-index:2;padding:10px max(12px,env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-right));border-top:1px solid rgba(255,255,255,.04);background:rgba(8,10,10,.88);backdrop-filter:blur(24px) saturate(120%);box-shadow:0 -8px 32px rgba(0,0,0,.3);overflow-x:hidden}
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
    .page-panel{display:none;flex:1;width:100%;min-width:0;max-width:100%;overflow:auto;overflow-x:hidden;padding:14px}
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
    .todo-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}
    .todo-toolbar .chip{height:30px;font-size:12px;padding:0 10px}
    .todo-day-chips{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}
    .schedule-item{border:1px solid var(--line);background:rgba(255,255,255,.03);border-radius:8px;padding:10px 12px;margin-bottom:8px}
    .schedule-time{font-size:12px;color:var(--accent-2);font-weight:750;margin-bottom:4px}
    .schedule-title{font-size:14px;font-weight:750}
    .schedule-meta{font-size:12px;color:var(--muted);margin-top:4px}
    @media (min-width: 960px){
      html,body{overflow:hidden}
      .app{height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto}
      main{padding:18px 20px}
      form{padding:12px 20px 16px}
    }
    @media (max-width: 959px){
      .conv-layout{flex-direction:column;position:relative}
      main{width:100%;flex:1 1 auto}
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
          <div class="page-title" style="justify-content:space-between">
            <span id="todoTitle">✅ 待办</span>
            <span id="todoDate" style="font-size:14px;color:var(--muted)"></span>
          </div>
          <div class="todo-toolbar">
            <button id="todoPrev" class="chip" type="button">◀</button>
            <button id="todoToday" class="chip" type="button">今天</button>
            <button id="todoNext" class="chip" type="button">▶</button>
          </div>
          <div class="todo-day-chips" id="todoDayChips"></div>
          <div class="page-content" id="todoList"></div>
        </div>
      </main>
    </div>
    <form id="form">
      <div class="paradigm-row">
        <select id="paradigmSelect"></select>
        <button class="chip" id="singleTurnBtn" type="button">单轮</button>
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md,.csv,.xls,.xlsx,.doc,.docx" multiple style="display:none" />
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
    const chatPage = document.getElementById('page-chat');
    const mainPanel = thread.closest('main');
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
    const TODO_TASK_PATH = '000 PARA/020 Areas/AI任务/要做的事情记录.md';
    const SCHEDULE_TASK_PATH = '000 PARA/020 Areas/AI任务/按照格式建立日程.md';
    let todoMode = 'todos';
    let todoSelectedDate = '';
    const todoCache = {};
    const calendarCache = {};
    window.addEventListener('error', e => {
      const msg = e?.message || '前端脚本错误';
      toast(msg);
      setUiState('error', 'error');
    });
    window.addEventListener('unhandledrejection', e => {
      const msg = e?.reason?.message || String(e?.reason || '前端异步错误');
      toast(msg);
      setUiState('error', 'error');
    });

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
    const stageLabels = {
      queued: '排队中',
      starting: '启动任务',
      thinking: '生成回复',
      tool: '执行工具',
      done: '任务完成',
      failed: '任务失败',
      error: '任务失败',
      cancelled: '已取消'
    };
    function statusForStage(stage, fallback) {
      if (stage === 'queued') return 'queued';
      if (stage === 'error' || stage === 'failed') return 'error';
      if (stage === 'cancelled') return 'error';
      return fallback || (stage === 'done' ? '' : 'running');
    }
    function progressTextFor(item) {
      if (!item) return '处理中';
      return item.progressText || stageLabels[item.stage] || stageLabels[item.status] || '处理中';
    }
    function applyJobProgress(conv, job) {
      if (!conv || !job) return;
      if (job.id) conv._jobId = job.id;
      if (job.stage) conv.stage = job.stage;
      if (job.status) conv.status = job.status;
      if (job.progressText) conv.progressText = job.progressText;
      if (job.progressUpdatedAt) conv.progressUpdatedAt = job.progressUpdatedAt;
      if (Object.prototype.hasOwnProperty.call(job, 'partialReply')) conv.partialReply = job.partialReply || '';
      if (Object.prototype.hasOwnProperty.call(job, 'toolName')) conv.toolName = job.toolName || '';
      if (Object.prototype.hasOwnProperty.call(job, 'round')) conv.round = job.round || 0;
      if (Array.isArray(job.progressLog)) conv.progressLog = job.progressLog;
    }
    const HISTORY_MAX_MESSAGES = 8;
    const HISTORY_MESSAGE_MAX_CHARS = 5000;
    const HISTORY_TOTAL_MAX_CHARS = 18000;
    function compactHistoryContent(content) {
      let text = typeof content === 'string' ? content : '';
      if (!text) return '';
      text = text.replace(/data:application\\/vnd\\.openxmlformats-officedocument\\.spreadsheetml\\.sheet;base64,[A-Za-z0-9+/=]+/g, '[已省略 Excel 原始 base64，附件内容已单独解析]');
      text = text.replace(/UEsDB[A-Za-z0-9+/=]{1000,}/g, '[已省略疑似 XLSX/base64 大块内容]');
      if (text.length > HISTORY_MESSAGE_MAX_CHARS) text = text.slice(0, HISTORY_MESSAGE_MAX_CHARS) + '\\n[历史消息已截断]';
      return text;
    }
    function buildHistoryForRequest(conv) {
      if (singleTurn || !conv || !Array.isArray(conv.messages)) return [];
      const recent = conv.messages.slice(0, -1).slice(-HISTORY_MAX_MESSAGES).reverse();
      const out = [];
      let total = 0;
      for (const msg of recent) {
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
        let content = compactHistoryContent(msg.content);
        if (!content.trim()) continue;
        const remain = HISTORY_TOTAL_MAX_CHARS - total;
        if (remain <= 500) break;
        if (content.length > remain) content = content.slice(0, remain) + '\\n[历史上下文预算已截断]';
        total += content.length;
        out.unshift({ role: msg.role, content });
      }
      return out;
    }
    function progressLogLines(log) {
      if (!Array.isArray(log) || !log.length) return [];
      const seen = new Set();
      return log
        .filter(item => item && item.text)
        .map(item => {
          const time = item.time ? String(item.time).split(' ').pop() : '';
          const detail = item.details ? ' · ' + item.details : '';
          const label = time ? time + ' ' + item.text + detail : item.text + detail;
          return { key: item.stage + '|' + item.text + '|' + (item.toolName || '') + '|' + (item.details || ''), label };
        })
        .filter(item => {
          if (seen.has(item.key)) return false;
          seen.add(item.key);
          return true;
        })
        .slice(-12)
        .map(item => item.label);
    }
    function formatRecoveredReply(job, fallbackText) {
      return fallbackText || job.reply || job.partialReply || '[无有效回复]';
    }
    function appendAssistantOnce(conv, content, opts) {
      if (!conv || !content) return false;
      opts = opts || {};
      const jobId = opts.jobId || conv._jobId || '';
      if (jobId && conv._completedJobId === jobId) return false;
      const last = conv.messages && conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === content) {
        if (jobId) { conv._completedJobId = jobId; conv._jobId = ''; }
        return false;
      }
      conv.messages.push({role: 'assistant', content, time: opts.time || nowStr(), ops: opts.ops || []});
      if (jobId) { conv._completedJobId = jobId; conv._jobId = ''; }
      return true;
    }
    function operationMarkup(lines) {
      if (!Array.isArray(lines) || !lines.length) return '';
      return '<details class="ops-log"><summary>执行记录 (' + lines.length + ')</summary>' + lines.map(line => '<div>• ' + escapeHtml(line) + '</div>').join('') + '</details>';
    }
    function progressMarkup(text) {
      return '<div class="progress-line"><span class="thinking-dots"><span></span><span></span><span></span></span><span class="progress-text">' + escapeHtml(text || '处理中') + '</span><span class="progress-track"></span></div>';
    }
    function progressLogMarkup(log) {
      const lines = progressLogLines(log);
      if (!lines.length) return '';
      return '<div style="margin-top:8px;color:var(--muted);font-size:12px;line-height:1.55">' + lines.map(line => '<div>• ' + escapeHtml(line) + '</div>').join('') + '</div>';
    }
    function setUiState(text, status) {
      state.textContent = text || 'ready';
      state.dataset.status = status || '';
    }
    function renderConvList() {
      convList.innerHTML = conversations.slice().reverse().map(c => {
        let statusClass = c.status || 'active';
        const activeJob = c.status === 'running' || c.status === 'queued';
        const meta = activeJob
          ? '<span class="thinking-dots"><span></span><span></span><span></span></span><span class="progress-text">' + escapeHtml(progressTextFor(c)) + '</span>'
          : '<span>' + (c.updatedAt || '') + '</span><span>' + c.messages.length + ' 条</span>';
        return '<div class="conv-item ' + statusClass + (c.id === activeConvId ? ' active' : '') + '" data-id="' + c.id + '">' +
          '<div style="display:flex;align-items:flex-start;gap:6px">' +
          '<span class="status-dot ' + statusClass + '"></span>' +
          '<div style="min-width:0">' +
          '<div class="conv-item-title">' + escapeHtml(c.title) + '</div>' +
          '<div class="conv-item-meta">' + meta + '</div>' +
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
      const msgs = conv.messages.map(m => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const label = m.role === 'user' ? '你' : 'Claude';
        return '<div class="msg ' + role + '"><div class="meta">' + label + ' · ' + (m.time || '') + '</div>' + formatMarkdown(m.content) + operationMarkup(m.ops) + '</div>';
      }).join('');
      const liveText = '<div class="live-text" style="margin-bottom:8px">' + (conv.partialReply ? formatMarkdown(conv.partialReply) : '') + '</div>';
      const thinking = (conv.status === 'running' || conv.status === 'queued') ? '<div class="msg assistant thinking"><div class="meta">Claude · <span class="progress-time">' + (conv.progressUpdatedAt ? conv.progressUpdatedAt.split(' ').pop() : '') + '</span></div>' + liveText + progressMarkup(progressTextFor(conv)) + '<div class="progress-log">' + progressLogMarkup(conv.progressLog) + '</div></div>' : '';
      thread.innerHTML = msgs + thinking;
      scrollToBottom();
    }
    function updateRunningMessage(conv) {
      if (!conv || conv.id !== activeConvId) return;
      const bubble = thread.querySelector('.msg.thinking');
      if (!bubble) { renderMessages(conv); return; }
      const timeEl = bubble.querySelector('.progress-time');
      const liveEl = bubble.querySelector('.live-text');
      const progressEl = bubble.querySelector('.progress-text');
      const logEl = bubble.querySelector('.progress-log');
      if (timeEl) timeEl.textContent = conv.progressUpdatedAt ? conv.progressUpdatedAt.split(' ').pop() : '';
      if (liveEl) liveEl.innerHTML = conv.partialReply ? formatMarkdown(conv.partialReply) : '';
      if (progressEl) progressEl.textContent = progressTextFor(conv);
      if (logEl) logEl.innerHTML = progressLogMarkup(conv.progressLog);
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
      return String(text || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
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
    function resetHorizontalScroll() {
      [document.scrollingElement, document.documentElement, document.body, mainPanel, chatPage, thread.parentElement].forEach(el => {
        if (el) el.scrollLeft = 0;
      });
    }
    function scrollToBottom() {
      [mainPanel, chatPage].forEach(el => {
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        el.scrollLeft = 0;
      });
      resetHorizontalScroll();
      requestAnimationFrame(resetHorizontalScroll);
      scrollHint.classList.remove('visible');
    }

    // ── Streaming bubble ──
    function addStreamingBubble() {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML = '<div class="meta">Claude · ' + nowStr() + '</div>' + progressMarkup('准备中') + '<span class="stream-text"></span><span class="typing-dots stream-dots"><span>.</span><span>.</span><span>.</span></span>';
      thread.appendChild(div); scrollToBottom();
      const textEl = div.querySelector('.stream-text');
      let dotsEl = div.querySelector('.stream-dots');
      let progressEl = div.querySelector('.progress-text');
      let progressLine = div.querySelector('.progress-line');
      return {
        div,
        appendText: function(d) { if (dotsEl) { dotsEl.remove(); dotsEl = null; } textEl.textContent += d; scrollToBottom(); },
        setText: function(t) { if (dotsEl) { dotsEl.remove(); dotsEl = null; } if (progressLine) { progressLine.remove(); progressLine = null; } textEl.textContent = t; },
        setProgress: function(t) { if (progressEl) progressEl.textContent = t || '处理中'; scrollToBottom(); },
        finalize: function() { if (dotsEl) { dotsEl.remove(); dotsEl = null; } if (progressLine) { progressLine.remove(); progressLine = null; } }
      };
    }

    // ── Submit ──
    async function submit(text) {
      if (streamingAbort) { toast('任务运行中'); return; }
      const prompt = text.trim();
      if (filesLoading) { toast('附件仍在读取/解析中'); return; }
      const hasFiles = pendingFiles.length > 0;
      if (!prompt && !hasFiles) return;
      input.value = '';
      charCount.textContent = '';
      const files = pendingFiles; pendingFiles = [];
      uploadBtn.textContent = '📎'; uploadBtn.style.color = ''; uploadBtn.style.borderColor = '';
      const userPrompt = prompt || '请处理附件内容。';

      // Create or reuse conversation
      if (singleTurn || !activeConvId || !findConv(activeConvId)) {
        const conv = newConversation(userPrompt);
        conversations.unshift(conv);
        activeConvId = conv.id;
      }
      const conv = findConv(activeConvId);
      conv.title = conv.messages.length === 0 ? (conv.title.split(' ').slice(0,1).join(' ') + ' ' + (userPrompt + (files.length > 0 ? ' 📎' + files.length : '')).slice(0, 45)) : conv.title;
      conv.status = 'running';
      conv.stage = 'starting';
      conv.progressText = '准备发送任务';
      conv.progressUpdatedAt = nowStr();
      // Build final message: prompt + file contents inline
      let finalMsg = userPrompt;
      let displayMsg = userPrompt;
      if (files.length > 0) {
        const fileNames = files.map(f => '📎 ' + f.name).join(', ');
        const fileTexts = files.filter(f => !f.isImage && f.data).map(f => '\\n--- ' + f.name + ' ---\\n' + f.data).join('\\n');
        finalMsg = userPrompt + '\\n\\n' + fileNames + fileTexts;
        const fileSummaries = files.map(f => {
          const size = f.data ? String(f.data).length : 0;
          const preview = (!f.isImage && f.data) ? String(f.data).slice(0, 300) : '';
          return '📎 ' + f.name + (size ? '（' + size + ' 字符）' : '') + (preview ? '\\n' + preview + (size > 300 ? '\\n[附件内容已省略，发送给模型时使用完整内容]' : '') : '');
        }).join('\\n\\n');
        displayMsg = userPrompt + '\\n\\n' + fileSummaries;
      }
      conv.messages.push({role: 'user', content: displayMsg, time: nowStr()});
      let historyForRequest = [];
      try { historyForRequest = buildHistoryForRequest(conv); } catch (e) { historyForRequest = []; }
      try { saveConversations(); } catch {}
      renderConvList();
      renderMessages({...conv, status: 'active', stage: 'active', progressText: ''});

      setUiState('连接中', 'running');
      send.disabled = true;
      const bubble = addStreamingBubble();
      bubble.setProgress('连接服务中');
      let fullText = '';

      try {
        const resp = await fetch('/api/chat/stream', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({message: finalMsg, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel, history: historyForRequest, files: files.filter(f => f.isImage)}),
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
                if (eventType === 'meta') {
                  applyJobProgress(conv, { id: data.jobId, stage: data.stage || 'starting', progressText: data.progressText || '任务已创建', progressUpdatedAt: data.progressUpdatedAt });
                  bubble.setProgress(progressTextFor(conv));
                  setUiState(progressTextFor(conv), statusForStage(conv.stage));
                  saveConversations(); renderConvList();
                }
                else if (eventType === 'progress') {
                  applyJobProgress(conv, data);
                  bubble.setProgress(progressTextFor(conv));
                  setUiState(progressTextFor(conv), statusForStage(conv.stage));
                  saveConversations(); renderConvList();
                }
                else if (eventType === 'text') { fullText += data.delta; conv.partialReply = fullText; bubble.appendText(data.delta); }
                else if (eventType === 'tool') {
                  const toolText = data.status === 'done' ? '工具 ' + data.name + ' 已完成' : (data.status === 'error' ? '工具 ' + data.name + ' 失败' : '正在执行工具 ' + data.name);
                  applyJobProgress(conv, { stage: data.status === 'error' ? 'error' : 'tool', progressText: toolText, toolName: data.name });
                  bubble.setProgress(toolText);
                  setUiState(toolText, statusForStage(conv.stage));
                  saveConversations(); renderConvList();
                }
                else if (eventType === 'done') {
                  applyJobProgress(conv, { stage: 'done', progressText: '任务完成' });
                  if (!fullText.trim()) bubble.setText(data.reply || '完成');
                }
                else if (eventType === 'error') {
                  applyJobProgress(conv, { stage: 'error', status: 'failed', progressText: data.message || '任务失败' });
                  bubble.setText('失败：' + data.message);
                }
              } catch {}
              eventType = '';
            }
          }
        }
        bubble.finalize();
        if (fullText.trim()) {
          bubble.div.querySelector('.stream-text').innerHTML = formatMarkdown(fullText.trim());
          appendAssistantOnce(conv, fullText.trim(), {jobId: conv._jobId, ops: progressLogLines(conv.progressLog)});
        }
        conv.status = 'done';
        conv.stage = 'done';
        conv.progressText = '任务完成';
        conv.partialReply = '';
        conv.updatedAt = nowStr();
        setUiState('ready', '');
      } catch (err) {
        if (err.name === 'AbortError') {
          bubble.setText('[已取消]'); conv.status = 'done'; conv.stage = 'cancelled'; conv.progressText = '已取消'; conv.updatedAt = nowStr(); setUiState('ready', '');
        } else {
          // Fallback: job queue
          try {
            bubble.finalize();
            const fb = addStreamingBubble();
            fb.setProgress('流式连接失败，已转入队列');
            const jr = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: finalMsg, taskPath: paradigmSelect.value, taskContent: paradigmCache[paradigmSelect.value] || '', model: currentModel, history: historyForRequest, files: files.filter(f => f.isImage)})});
            const jd = await jr.json();
            if (!jr.ok) throw new Error(jd.error||'请求失败');
            applyJobProgress(conv, jd.job);
            fb.setProgress(progressTextFor(conv));
            const pid = setInterval(async () => {
              try {
                const pr = await fetch('/api/jobs'); const pd = await pr.json();
                const found = pd.jobs.find(j => j.id === jd.job.id);
                if (found) {
                  applyJobProgress(conv, found);
                  fb.setProgress(progressTextFor(conv));
                  setUiState(progressTextFor(conv), statusForStage(conv.stage, found.status));
                  saveConversations(); renderConvList();
                }
                if (found && (found.status === 'done' || found.status === 'failed' || found.status === 'cancelled')) {
                  clearInterval(pid); fb.finalize();
                  if (found.status === 'done') {
                    appendAssistantOnce(conv, formatRecoveredReply(found, found.reply), {jobId: found.id, ops: progressLogLines(found.progressLog)});
                    renderMessages(conv);
                  } else if (found.status === 'cancelled') {
                    appendAssistantOnce(conv, formatRecoveredReply(found, '[已取消]'), {jobId: found.id, ops: progressLogLines(found.progressLog)});
                    renderMessages(conv);
                  } else {
                    appendAssistantOnce(conv, formatRecoveredReply(found, '失败：' + found.error), {jobId: found.id, ops: progressLogLines(found.progressLog)});
                    renderMessages(conv);
                  }
                  conv.status = found.status;
                  conv.stage = found.status === 'done' ? 'done' : (found.status === 'cancelled' ? 'cancelled' : 'error');
                  conv.updatedAt = nowStr();
                  saveConversations(); renderConvList();
                  setUiState('ready', '');
                }
              } catch {}
            }, 2000);
            setUiState(progressTextFor(conv), 'queued');
          } catch (fe) {
            conv.status = 'failed';
            conv.stage = 'error';
            conv.progressText = fe.message || '任务失败';
            conv.updatedAt = nowStr();
            appendAssistantOnce(conv, '失败：' + (fe.message||'未知错误'));
            renderMessages(conv);
            setUiState('error', 'error');
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
      if (streamingAbort) { streamingAbort.abort(); streamingAbort = null; }
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
    let todoClickTimer = null;
    function activatePage(page) {
      document.querySelectorAll('.bb-tab').forEach(t => t.classList.toggle('on', t.dataset.page === page));
      currentPage = page;
      document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('page-' + currentPage).classList.add('active');
      const isChat = currentPage === 'chat';
      document.getElementById('form').style.display = isChat ? '' : 'none';
      document.getElementById('bottomBar').style.display = '';
    }
    document.getElementById('bottomBar').addEventListener('click', e => {
      const tab = e.target.closest('.bb-tab');
      if (!tab) return;
      const page = tab.dataset.page;
      if (page === 'todos') {
        clearTimeout(todoClickTimer);
        if (e.detail >= 2) {
          activatePage('todos');
          showTodosPage('schedule');
        } else {
          todoClickTimer = setTimeout(() => {
            activatePage('todos');
            showTodosPage('todos');
          }, 220);
        }
        return;
      }
      if (page === currentPage) return;
      activatePage(page);
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
    function dateKey(d) {
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    function addDate(ds, n) {
      const d = new Date(ds + 'T12:00:00');
      d.setDate(d.getDate() + n);
      return dateKey(d);
    }
    function weekday(ds) {
      return ['周日','周一','周二','周三','周四','周五','周六'][new Date(ds + 'T12:00:00').getDay()];
    }
    async function selectParadigmByPath(path) {
      if (!path || !paradigmSelect.querySelector('option[value="' + path.replace(/"/g,'&quot;') + '"]')) return;
      paradigmSelect.value = path;
      try { localStorage.setItem('claudenotes_paradigm', path); } catch {}
      if (paradigmCache[path] === undefined) {
        try {
          const r = await fetch('/api/task?path=' + encodeURIComponent(path));
          const d = await r.json();
          if (r.ok) paradigmCache[path] = d.content || '';
        } catch {}
      }
      updateSlotUI();
    }
    function renderTodoChips() {
      const days = [-3,-2,-1,0,1,2,3].map(n => addDate(todoSelectedDate, n));
      document.getElementById('todoDayChips').innerHTML = days.map(ds => {
        const label = ds.slice(5) + ' ' + weekday(ds);
        return '<button class="chip todo-day-chip' + (ds === todoSelectedDate ? ' on' : '') + '" data-date="' + ds + '" type="button">' + label + '</button>';
      }).join('');
    }
    async function loadTodoDate(ds) {
      if (todoCache[ds] !== undefined) return todoCache[ds];
      try {
        const r = await fetch('/api/note/read?path=' + encodeURIComponent('900 Journals & Reviews/910 Daily Notes/' + ds + '.md'));
        const data = await r.json();
        todoCache[ds] = r.ok ? (data.content || '') : '';
      } catch { todoCache[ds] = ''; }
      return todoCache[ds];
    }
    async function renderTodos() {
      await selectParadigmByPath(TODO_TASK_PATH);
      document.getElementById('todoTitle').textContent = '✅ 待办';
      document.getElementById('todoDate').textContent = todoSelectedDate + ' ' + weekday(todoSelectedDate);
      renderTodoChips();
      document.getElementById('todoList').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">加载中...</div>';
      const content = await loadTodoDate(todoSelectedDate);
      const todos = content.split('\\n').filter(l => l.match(/^[-*] \[.\]/));
      const pending = todos.filter(l => l.match(/^[-*] \[ \]/));
      const done = todos.filter(l => l.match(/^[-*] \[x\]/i));
      if (!todos.length) {
        document.getElementById('todoList').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">这天暂无待办<br><small>' + todoSelectedDate + '</small></div>';
        return;
      }
      document.getElementById('todoList').innerHTML =
        (pending.length ? '<div style="font-size:13px;color:var(--muted);margin-bottom:8px">待完成 (' + pending.length + ')</div>' : '') +
        pending.map(l => '<div class="todo-item"><div class="todo-check"></div><div class="todo-text">' + escapeHtml(l.replace(/^[-*] \[.\] /,'')) + '</div></div>').join('') +
        (done.length ? '<div style="font-size:13px;color:var(--muted);margin:16px 0 8px">已完成 (' + done.length + ')</div>' : '') +
        done.map(l => '<div class="todo-item"><div class="todo-check done"></div><div class="todo-text done">' + escapeHtml(l.replace(/^[-*] \[x\] /i,'')) + '</div></div>').join('');
    }
    async function renderSchedule() {
      await selectParadigmByPath(SCHEDULE_TASK_PATH);
      document.getElementById('todoTitle').textContent = '🗓️ 时刻表预览';
      document.getElementById('todoDate').textContent = todoSelectedDate + ' 起 7 天';
      renderTodoChips();
      document.getElementById('todoList').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">加载中...</div>';
      const key = todoSelectedDate + ':7';
      if (!calendarCache[key]) {
        const r = await fetch('/api/calendar?start=' + encodeURIComponent(todoSelectedDate) + '&days=7');
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '加载失败');
        calendarCache[key] = d.events || [];
      }
      const events = calendarCache[key];
      if (!events.length) {
        document.getElementById('todoList').innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">这 7 天暂无日程</div>';
        return;
      }
      let lastDate = '';
      document.getElementById('todoList').innerHTML = events.map(ev => {
        const head = ev.date !== lastDate ? '<div style="font-size:13px;color:var(--muted);margin:14px 0 8px">' + ev.date + ' ' + weekday(ev.date) + '</div>' : '';
        lastDate = ev.date;
        const time = ev.allDay ? '全天' : ((ev.startTime || '--:--') + (ev.endTime ? ' - ' + ev.endTime : ''));
        const meta = [ev.location, ev.path].filter(Boolean).map(escapeHtml).join(' · ');
        return head + '<div class="schedule-item"><div class="schedule-time">' + escapeHtml(time) + '</div><div class="schedule-title">' + escapeHtml(ev.title) + '</div>' + (meta ? '<div class="schedule-meta">' + meta + '</div>' : '') + '</div>';
      }).join('');
    }
    async function showTodosPage(mode) {
      if (!todoSelectedDate) todoSelectedDate = dateKey(new Date());
      if (mode) todoMode = mode;
      try {
        if (todoMode === 'schedule') await renderSchedule();
        else await renderTodos();
      } catch(e) {
        document.getElementById('todoList').innerHTML = '<div style="color:var(--bad);text-align:center;padding:40px">加载失败: ' + escapeHtml(e.message) + '</div>';
      }
    }
    document.getElementById('todoPrev').addEventListener('click', () => { if (!todoSelectedDate) todoSelectedDate = dateKey(new Date()); todoSelectedDate = addDate(todoSelectedDate, -1); showTodosPage(); });
    document.getElementById('todoToday').addEventListener('click', () => { todoSelectedDate = dateKey(new Date()); showTodosPage(); });
    document.getElementById('todoNext').addEventListener('click', () => { if (!todoSelectedDate) todoSelectedDate = dateKey(new Date()); todoSelectedDate = addDate(todoSelectedDate, 1); showTodosPage(); });
    document.getElementById('todoDayChips').addEventListener('click', e => {
      const btn = e.target.closest('.todo-day-chip'); if (!btn) return;
      todoSelectedDate = btn.dataset.date;
      showTodosPage();
    });

    // ── File upload ──
    let pendingFiles = [];
    let filesLoading = false;
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      filesLoading = true; uploadBtn.textContent = '⏳';
      const newFiles = [];
      for (const f of fileInput.files) {
        const reader = new FileReader();
        await new Promise(resolve => {
          reader.onload = () => {
            const isImage = f.type.startsWith('image/');
            const item = { name: f.name, type: f.type, data: reader.result, isImage };
            pendingFiles.push(item);
            newFiles.push(item);
            resolve();
          };
          reader.onerror = () => resolve(); // skip on error
          if (f.type.startsWith('image/')) reader.readAsDataURL(f);
          else if (/\.xlsx?$/i.test(f.name)) reader.readAsDataURL(f); // Excel → base64 for server parsing
          else reader.readAsText(f);
        });
      }
      // Convert Excel files to CSV text server-side, then process as plain CSV.
      for (const pf of newFiles) {
        if (/\.xlsx?$/i.test(pf.name) && pf.data && !pf._parsed) {
          try {
            uploadBtn.textContent = '⏳'; toast('正在转换 CSV：' + pf.name);
            const r = await fetch('/api/parse-file', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name: pf.name, data: pf.data})});
            const d = await r.json();
            if (r.ok && d.text) {
              pf.name = d.csvName || pf.name.replace(/\.xlsx?$/i, '.csv');
              pf.type = 'text/csv';
              pf.data = d.text;
              pf.isImage = false;
              pf._parsed = true;
              pf._sourceName = d.sourceName || pf.name;
            }
            else { pf.data = '[CSV转换失败] ' + (d.error || ''); pf.type = 'text/plain'; pf.isImage = false; pf._parsed = true; }
          } catch(e) { pf.data = '[CSV转换失败] ' + e.message; pf.type = 'text/plain'; pf.isImage = false; }
        }
      }
      filesLoading = false; fileInput.value = '';
      if (pendingFiles.length) {
        uploadBtn.textContent = '📎' + pendingFiles.length;
        uploadBtn.style.color = 'var(--accent-2)';
        uploadBtn.style.borderColor = 'rgba(100,210,193,.4)';
        toast('已添加 ' + pendingFiles.length + ' 个文件');
      } else {
        uploadBtn.textContent = '📎'; toast('未能读取文件');
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
    clearHistory.addEventListener('click', () => {
      if (!confirm('确定清除所有对话记录？此操作不可撤销。')) return;
      conversations.length = 0; activeConvId = null;
      localStorage.removeItem('claudenotes_convs');
      localStorage.removeItem('claudenotes_model');
      localStorage.removeItem('claudenotes_singleTurn');
      localStorage.removeItem('claudenotes_paradigm');
      saveConversations(); renderConvList();
      thread.innerHTML = '<div class="empty-state"><div class="icon">🗑</div><div class="text">所有记录已清除</div></div>';
      fetch('/api/jobs/clear', {method:'POST'}).catch(()=>{});
      toast('已清除所有记录');
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
      const running = conversations.filter(c => c.status === 'running' && c._jobId);
      if (!running.length) return;
      try {
        const r = await fetch('/api/jobs'); const d = await r.json();
        if (!r.ok) throw new Error('jobs fetch failed');
        for (const conv of running) {
          const job = d.jobs.find(j => j.id === conv._jobId);
          if (!job) { appendAssistantOnce(conv, '[响应丢失 - 请重新发送]', {jobId: conv._jobId}); conv.status = 'done'; continue; }
          applyJobProgress(conv, job);
          if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
            conv.status = job.status;
            conv.updatedAt = nowStr();
            if (job.status === 'done' && job.reply) appendAssistantOnce(conv, formatRecoveredReply(job, job.reply), {jobId: job.id, time: job.finishedAt?.split(' ')[1]||nowStr(), ops: progressLogLines(job.progressLog)});
            else if (job.status === 'failed') appendAssistantOnce(conv, formatRecoveredReply(job, '失败：'+(job.error||'未知错误')), {jobId: job.id, ops: progressLogLines(job.progressLog)});
            else if (job.status === 'cancelled') appendAssistantOnce(conv, formatRecoveredReply(job, '[已取消]'), {jobId: job.id, ops: progressLogLines(job.progressLog)});
          }
        }
      } catch {
        // If jobs API fails, mark all running as lost
        for (const conv of running) { appendAssistantOnce(conv, '[响应丢失 - 请重新发送]', {jobId: conv._jobId}); conv.status = 'done'; }
      }
    }

    // ── Restore button states ──
    try {
      if (localStorage.getItem('claudenotes_singleTurn') === '1') {
        singleTurn = true; singleTurnBtn.classList.add('on');
      }
    } catch {}

    // ── Poll running conversations for progress ──
    setInterval(async () => {
      const running = conversations.filter(c => c.status === 'running' && c._jobId);
      if (!running.length) return;
      try {
        const r = await fetch('/api/jobs'); const d = await r.json();
        for (const conv of running) {
          const job = d.jobs.find(j => j.id === conv._jobId);
          if (!job) continue;
          applyJobProgress(conv, job);
          if (job.status === 'done' && job.reply) {
            appendAssistantOnce(conv, formatRecoveredReply(job, job.reply), {jobId: job.id, ops: progressLogLines(job.progressLog)});
            conv.status = 'done'; conv.updatedAt = nowStr();
            saveConversations(); renderConvList();
            if (conv.id === activeConvId) renderMessages(conv);
          } else if (job.status === 'failed') {
            appendAssistantOnce(conv, formatRecoveredReply(job, '失败：'+(job.error||'未知错误')), {jobId: job.id, ops: progressLogLines(job.progressLog)});
            conv.status = 'failed'; conv.updatedAt = nowStr();
            saveConversations(); renderConvList();
            if (conv.id === activeConvId) renderMessages(conv);
          } else if (job.status === 'cancelled') {
            appendAssistantOnce(conv, formatRecoveredReply(job, '[已取消]'), {jobId: job.id, ops: progressLogLines(job.progressLog)});
            conv.status = 'cancelled'; conv.updatedAt = nowStr();
            saveConversations(); renderConvList();
            if (conv.id === activeConvId) renderMessages(conv);
          } else {
            saveConversations(); renderConvList();
            if (conv.id === activeConvId) updateRunningMessage(conv);
          }
        }
      } catch {}
    }, 2000);

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
      if (!hasMessageOrFiles(body)) throw new Error('message or files is required');
      const message = String(body.message || '').trim() ? body.message : '请处理附件内容。';
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      // Create persistent job so client can recover if disconnected
      const now = appNow();
      const job = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running',
        message,
        task,
        model: normalizeModel(body.model),
    reply: '',
    partialReply: '',
    error: '',
        createdAt: `${now.date} ${now.time}`,
        startedAt: `${now.date} ${now.time}`,
        finishedAt: '',
        stage: 'starting',
        progressText: '已接收任务',
        progressUpdatedAt: `${now.date} ${now.time}`,
        toolName: '',
        round: 0,
        progressLog: [{ time: `${now.date} ${now.time}`, stage: 'starting', text: '已接收任务', toolName: '', round: 0 }],
        _aborted: false,
      };
      jobs.unshift(job);
      trimJobs();
      appendJobLog(job, 'started');
      const jobRef = job;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseWrite(res, 'meta', { jobId: jobRef.id, model: normalizeModel(body.model), stage: jobRef.stage, progressText: jobRef.progressText, progressUpdatedAt: jobRef.progressUpdatedAt, progressLog: jobRef.progressLog });

      const heartbeat = setInterval(() => {
        if (!sseWrite(res, 'ping', { now: Date.now() })) {
          jobRef._disconnected = true;
          clearInterval(heartbeat);
        }
      }, 15000);
      req.on('close', () => { jobRef._disconnected = true; });
      res.on('close', () => { jobRef._disconnected = true; clearInterval(heartbeat); });

      try {
        await runClaudeStreaming(message, task, body.model, res, jobRef, body.history, body.files);
        jobRef.status = 'done';
        setJobProgress(jobRef, 'done', '任务完成');
        appendJobLog(jobRef, 'done');
        const finished = appNow();
        jobRef.finishedAt = `${finished.date} ${finished.time}`;
      } catch (err) {
        if (!jobRef._aborted) {
          jobRef.status = 'failed';
          jobRef.error = err.message || String(err);
          setJobProgress(jobRef, 'error', jobRef.error || '任务失败');
          appendJobLog(jobRef, 'failed');
          const finished = appNow();
          jobRef.finishedAt = `${finished.date} ${finished.time}`;
          sseWrite(res, 'error', { message: err.message || String(err) });
        }
      } finally {
        clearInterval(heartbeat);
      }
      sseEnd(res);
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!hasMessageOrFiles(body)) throw new Error('message or files is required');
      const message = String(body.message || '').trim() ? body.message : '请处理附件内容。';
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      const job = enqueueJob({ message, task, model: body.model, history: body.history, files: body.files });
      json(res, 202, { job: serializeJob(job) });
      return;
    }
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      json(res, 200, { activeJob: activeJob ? activeJob.id : null, jobs: jobs.map(serializeJob) });
      return;
    }
    if (url.pathname === '/api/job/logs' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
      json(res, 200, { path: JOB_LOG_PATH, logs: readJobLogs({ id, limit }) });
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
        setJobProgress(target, 'cancelled', '已取消');
        appendJobLog(target, 'cancelled');
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
    if (url.pathname === '/api/calendar' && req.method === 'GET') {
      const start = url.searchParams.get('start') || appNow().date;
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 31);
      if (!start.match(/^\d{4}-\d{2}-\d{2}$/)) throw new Error('invalid start format (YYYY-MM-DD)');
      const end = addDateDays(start, days - 1);
      const prefix = '900 Journals & Reviews/Calender/';
      const byPath = new Map();
      for (const monthKey of monthKeysBetween(start, end)) {
        let page = 1;
        while (page <= 10) {
          const listData = unwrap(await fnsRequest('/api/notes', { params: { vault: DEFAULT_VAULT, keyword: monthKey, searchContent: false, page } }));
          const list = Array.isArray(listData) ? listData : (listData?.list || []);
          for (const note of list) {
            const p = String(note.path || '');
            const dateFromPath = (p.match(/\/(\d{4}-\d{2}-\d{2})[^/]*\.md$/) || [])[1] || '';
            if (p.startsWith(prefix) && dateFromPath >= start && dateFromPath <= end) byPath.set(p, note);
          }
          const pager = listData?.pager || {};
          const totalRows = Number(pager.totalRows || list.length || 0);
          const pageSize = Number(pager.pageSize || list.length || 10);
          if (!list.length || page * pageSize >= totalRows) break;
          page++;
        }
      }
      const events = [];
      for (const [eventPath] of byPath) {
        const dateFromPath = (eventPath.match(/\/(\d{4}-\d{2}-\d{2})\s+([^/]+)\.md$/) || [])[1] || '';
        const titleFromPath = (eventPath.match(/\/\d{4}-\d{2}-\d{2}\s+([^/]+)\.md$/) || [])[1] || eventPath.split('/').pop().replace(/\.md$/i, '');
        try {
          const noteData = unwrap(await fnsRequest('/api/note', { params: { vault: DEFAULT_VAULT, path: eventPath } }));
          const content = noteData?.content || '';
          const fm = parseFrontmatter(content);
          const date = String(fm.date || dateFromPath || '').slice(0, 10);
          if (!date || date < start || date > end) continue;
          events.push({
            path: eventPath,
            title: String(fm.title || titleFromPath),
            date,
            allDay: fm.allDay === true || fm.allDay === 'true',
            startTime: fm.startTime || '',
            endTime: fm.endTime || '',
            location: fm.location || '',
            completed: fm.completed || null,
          });
        } catch {
          if (dateFromPath) events.push({ path: eventPath, title: titleFromPath, date: dateFromPath, allDay: true, startTime: '', endTime: '', location: '', completed: null });
        }
      }
      events.sort((a, b) => (a.date + ' ' + (a.startTime || '99:99') + ' ' + a.title).localeCompare(b.date + ' ' + (b.startTime || '99:99') + ' ' + b.title, 'zh-CN'));
      json(res, 200, { start, end, days, events });
      return;
    }
    if (url.pathname === '/api/parse-file' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.data || !body.name) throw new Error('data and name are required');
      const isExcel = /\.xlsx?$/i.test(body.name);
      if (!isExcel) throw new Error('unsupported file type');
      try {
        const b64 = body.data.includes('base64,') ? body.data.split('base64,')[1] : body.data;
        const buf = Buffer.from(b64, 'base64');
        const wb = XLSX.read(buf, { type: 'buffer' });
        const csvName = String(body.name).replace(/\.xlsx?$/i, '.csv');
        const sheets = wb.SheetNames.map(name => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
          return wb.SheetNames.length > 1 ? '# Sheet: ' + name + '\n' + csv : csv;
        }).join('\n\n');
        json(res, 200, { ok: true, text: sheets, csvName, sourceName: body.name, type: 'text/csv', sheets: wb.SheetNames.length, rows: sheets.split('\n').filter(l=>l.trim() && !l.startsWith('# Sheet:')).length });
      } catch (e) {
        json(res, 500, { error: 'Excel 转 CSV 失败: ' + e.message });
      }
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
