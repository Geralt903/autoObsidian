#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const HOST = process.env.WEB_TERMINAL_HOST || '0.0.0.0';
const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '8000', 10);
const FNS_BASE_URL = (process.env.FNS_BASE_URL || 'http://20.205.107.61:9000').replace(/\/+$/, '');
const FNS_TOKEN = process.env.FNS_TOKEN || '';
const DEFAULT_VAULT = process.env.FNS_DEFAULT_VAULT || 'Life-Learing';
const TASKS_PREFIX = process.env.FNS_TASKS_PREFIX || '000 PARA/020 Areas/AI任务/';
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Shanghai';
process.env.TZ = process.env.TZ || APP_TIME_ZONE;
const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.5';
const CODEX_MODELS = (process.env.CODEX_MODELS || DEFAULT_CODEX_MODEL)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const DEFAULT_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || 'medium';
const REASONING_EFFORTS = (process.env.CODEX_REASONING_EFFORTS || 'low,medium,high')
  .split(',')
  .map((effort) => effort.trim())
  .filter(Boolean);
const CODEX_TIMEOUT_MS = parseInt(process.env.CODEX_TIMEOUT_MS || '180000', 10);
const JOB_HISTORY_LIMIT = parseInt(process.env.JOB_HISTORY_LIMIT || '20', 10);
const jobs = [];
let activeJob = null;

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

function buildPrompt(userText, task) {
  const now = appNow();
  const taskBlock = task?.content
    ? `\n本次必须优先遵守以下任务范式，来自笔记：${task.path}\n\n${task.content}\n`
    : '\n本次未选择任务范式，按默认笔记助理原则执行。\n';
  return `你是我的手机笔记助理。用户会用自然语言描述要记录、查询、整理或修改的内容。

你必须自己决定要搜索、读取、追加、替换还是新建笔记。你可以运行本地命令调用 FNS 笔记服务：

node fns-note-tool.js vaults
node fns-note-tool.js list Life-Learing
node fns-note-tool.js search "关键词" Life-Learing
node fns-note-tool.js folder "000 PARA/020 Areas/AI任务/" Life-Learing
node fns-note-tool.js get "完整路径.md" Life-Learing
node fns-note-tool.js save "完整路径.md" "完整内容" Life-Learing
node fns-note-tool.js append "完整路径.md" "追加内容" Life-Learing
node fns-note-tool.js prepend "完整路径.md" "插入内容" Life-Learing
node fns-note-tool.js replace "完整路径.md" "旧文本" "新文本" Life-Learing

默认 vault 是 Life-Learing。不要全库遍历。需要找笔记时，先根据任务范式和用户输入提取 1-3 个关键词，用 search 精准查询；只有用户明确要求浏览列表时才 list。涉及任务范式时只使用 folder "000 PARA/020 Areas/AI任务/" 查询任务文件夹。

当前日期是 ${now.date}，当前时间是 ${now.time}，时区是 ${now.timeZone}。用户提到“明天”等相对日期时，请按这个时区换算成明确日期写入笔记。完成后用中文简短说明你修改了哪条笔记、写入了什么。
${taskBlock}

用户输入：
${userText}`;
}

function normalizeModel(model) {
  if (!model) return DEFAULT_CODEX_MODEL;
  return CODEX_MODELS.includes(model) ? model : DEFAULT_CODEX_MODEL;
}

function normalizeReasoningEffort(effort) {
  if (!effort) return DEFAULT_REASONING_EFFORT;
  return REASONING_EFFORTS.includes(effort) ? effort : DEFAULT_REASONING_EFFORT;
}

function runCodex(userText, task, model, effort) {
  const selectedModel = normalizeModel(model);
  const selectedEffort = normalizeReasoningEffort(effort);
  return new Promise((resolve, reject) => {
    const child = spawn('codex', [
      'exec',
      '-m',
      selectedModel,
      '-c',
      `model_reasoning_effort="${selectedEffort}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      process.cwd(),
      '-',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FNS_BASE_URL,
        FNS_TOKEN,
        FNS_DEFAULT_VAULT: DEFAULT_VAULT,
        TZ: APP_TIME_ZONE,
        APP_TIME_ZONE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Codex execution timed out'));
    }, CODEX_TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    child.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || '完成');
      else reject(new Error((stderr || stdout || `Codex exited with ${code}`).trim()));
    });
    child.stdin.end(buildPrompt(userText, task));
  });
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    model: job.model,
    effort: job.effort,
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

function enqueueJob({ message, task, model, effort }) {
  const now = appNow();
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'queued',
    message,
    task,
    model: normalizeModel(model),
    effort: normalizeReasoningEffort(effort),
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
    job.reply = await runCodex(job.message, job.task, job.model, job.effort);
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

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Codex Notes</title>
  <style>
    :root{--bg:#0c0f10;--panel:#151917;--panel-2:#101413;--line:#2a332f;--line-soft:#202824;--text:#f7f3ea;--muted:#a8b0a7;--accent:#c7f36b;--accent-2:#64d2c1;--ok:#8fe5a7;--bad:#ff9187;--shadow:0 18px 60px rgba(0,0,0,.34)}
    *{box-sizing:border-box}
    html,body{height:100%;max-width:100%;overflow-x:hidden}
    body{width:100%;margin:0;background:radial-gradient(circle at 18% -10%,rgba(100,210,193,.16),transparent 28%),linear-gradient(180deg,#151917 0,#0c0f10 48%,#080a0a 100%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .app{width:100%;max-width:100vw;min-width:0;min-height:100%;min-height:100dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow-x:hidden}
    header{z-index:3;padding:12px max(14px,env(safe-area-inset-left)) 12px max(14px,env(safe-area-inset-right));border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto;gap:10px 12px;background:rgba(12,15,16,.86);position:sticky;top:0;backdrop-filter:blur(16px)}
    .brand{display:flex;align-items:center;gap:10px;min-width:0}
    .mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 10px 30px rgba(100,210,193,.18);display:grid;place-items:center;color:#0b100e;font-weight:900}
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
    .summary-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-2);box-shadow:0 0 0 4px rgba(100,210,193,.12)}
    .summary-path{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw}
    .tasks-inner{display:grid;gap:10px;padding-top:2px}
    .task-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
    select{width:100%;height:42px;border:1px solid var(--line);border-radius:8px;background:#111615;color:var(--text);padding:0 10px;font:inherit;min-width:0;max-width:100%;outline:none;text-overflow:ellipsis}
    select:focus,textarea:focus{border-color:rgba(199,243,107,.65);box-shadow:0 0 0 3px rgba(199,243,107,.12)}
    .task-editor{min-height:118px;max-height:220px}
    .thread{width:100%;max-width:880px;min-width:0;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
    .msg{border:1px solid var(--line-soft);border-radius:8px;padding:12px 13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.04);box-shadow:0 8px 24px rgba(0,0,0,.12)}
    .msg.user{margin-left:auto;max-width:min(760px,92%);background:rgba(199,243,107,.1);border-color:rgba(199,243,107,.28)}
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
    .job.running{color:var(--accent);border-color:rgba(216,255,98,.35)}
    .job.done{color:var(--ok)}
    .job.failed{color:var(--bad)}
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
      .controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"model effort" "state state";width:100%;gap:6px}
      #modelSelect{grid-area:model}
      #effortSelect{grid-area:effort}
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
      .controls{grid-template-columns:1fr;grid-template-areas:"model" "effort" "state"}
      select{height:38px;font-size:13px}
      .summary-path{max-width:45vw}
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="brand"><div class="mark">C</div><div><h1>Codex Notes</h1><div class="subtitle">手机笔记助理</div></div></div>
      <div class="controls"><select id="modelSelect"></select><select id="effortSelect"></select><div class="state" id="state">ready</div></div>
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
    <main><div class="thread" id="thread"><div class="msg assistant"><div class="meta">Codex</div>直接输入要做的事。</div></div></main>
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
    const effortSelect = document.getElementById('effortSelect');
    const taskSelect = document.getElementById('taskSelect');
    const taskEditor = document.getElementById('taskEditor');
    const taskPanel = document.getElementById('taskPanel');
    const taskSummary = document.getElementById('taskSummary');
    const saveTask = document.getElementById('saveTask');
    const jobsEl = document.getElementById('jobs');
    const clearHistory = document.getElementById('clearHistory');
    let activeTaskPath = '';
    const seenDone = new Set();
    const taskMedia = window.matchMedia('(min-width: 960px)');
    function syncMobileTaskPanel() {
      taskPanel.open = taskMedia.matches;
    }
    syncMobileTaskPanel();
    taskMedia.addEventListener('change', syncMobileTaskPanel);
    function add(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = '<div class="meta">' + (role === 'user' ? '你' : 'Codex') + '</div>' + text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
      thread.appendChild(div);
      div.scrollIntoView({block:'end'});
    }
    async function submit(text) {
      const prompt = text.trim();
      if (!prompt) return;
      input.value = '';
      add('user', prompt);
      state.textContent = 'thinking';
      send.disabled = true;
      try {
        const resp = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message: prompt, taskPath: activeTaskPath, taskContent: taskEditor.value, model: modelSelect.value, effort: effortSelect.value})});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '请求失败');
        add('assistant', '已入队：' + data.job.id + '（' + data.job.model + ' / ' + data.job.effort + '）');
        state.textContent = 'ready';
      } catch (err) {
        add('assistant', '失败：' + err.message);
        state.textContent = 'error';
      } finally {
        send.disabled = false;
        input.focus();
      }
    }
    form.addEventListener('submit', e => { e.preventDefault(); submit(input.value); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); } });
    document.querySelectorAll('.chip:not(#clearHistory)').forEach(btn => btn.addEventListener('click', () => submit(btn.textContent)));
    async function loadConfig() {
      const resp = await fetch('/api/config');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '加载配置失败');
      modelSelect.innerHTML = data.models.map(model => '<option value="' + model + '">' + model + '</option>').join('');
      modelSelect.value = data.defaultModel;
      effortSelect.innerHTML = data.reasoningEfforts.map(effort => '<option value="' + effort + '">' + effort + '</option>').join('');
      effortSelect.value = data.defaultReasoningEffort;
    }
    async function loadJobs() {
      const resp = await fetch('/api/jobs');
      const data = await resp.json();
      if (!resp.ok) return;
      jobsEl.innerHTML = data.jobs.slice(0, 8).map(job => '<button class="job ' + job.status + '" type="button" data-id="' + job.id + '">' + job.status + ' · ' + job.model + ' · ' + job.effort + '</button>').join('');
      data.jobs.forEach(job => {
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
      taskSelect.innerHTML = data.tasks.map(t => '<option value="' + t.path.replace(/"/g,'&quot;') + '">' + t.name + '</option>').join('');
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
    taskSelect.addEventListener('change', () => loadTask(taskSelect.value).catch(err => { state.textContent = 'error'; add('assistant', '失败：' + err.message); }));
    clearHistory.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/jobs/clear', {method:'POST'});
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '清除失败');
        seenDone.clear();
        thread.innerHTML = '<div class="msg assistant"><div class="meta">Codex</div>历史已清除。</div>';
        await loadJobs();
      } catch (err) {
        add('assistant', '失败：' + err.message);
      }
    });
    saveTask.addEventListener('click', async () => {
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
    Promise.all([loadConfig(), loadTasks(), loadJobs()]).catch(err => { state.textContent = 'error'; add('assistant', '失败：' + err.message); });
    setInterval(loadJobs, 2500);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.message) throw new Error('message is required');
      const task = body.taskPath ? { path: body.taskPath, content: body.taskContent || '' } : null;
      const job = enqueueJob({ message: body.message, task, model: body.model, effort: body.effort });
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
        defaultModel: DEFAULT_CODEX_MODEL,
        models: CODEX_MODELS,
        defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
        reasoningEfforts: REASONING_EFFORTS,
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
        const defaultContent = `# 默认范式

- 先理解用户意图，再选择最少的笔记操作。
- 不要全库遍历；先根据用户输入提取关键词搜索。
- 修改前优先读取目标笔记。
- 完成后说明修改了哪条笔记和写入内容。`;
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
  console.log(`Codex Notes listening on http://${HOST}:${PORT}`);
  console.log(`FNS: ${FNS_BASE_URL}`);
  console.log(`Default vault: ${DEFAULT_VAULT}`);
});
