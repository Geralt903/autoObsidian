#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const HOST = process.env.WEB_TERMINAL_HOST || '0.0.0.0';
const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '8080', 10);
const SHELL = process.env.WEB_TERMINAL_SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
const CWD = process.env.WEB_TERMINAL_CWD || process.cwd();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Server Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.min.css">
  <style>
    html, body { height: 100%; margin: 0; background: #08111f; }
    body { display: grid; grid-template-rows: auto 1fr; color: #d7e1ff; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { padding: 10px 14px; background: linear-gradient(90deg, #0f172a, #111827); border-bottom: 1px solid rgba(255,255,255,.08); display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 14px; }
    .pill { padding: 4px 10px; border: 1px solid rgba(255,255,255,.15); border-radius: 999px; color: #9cc2ff; }
    #terminal { height: 100%; width: 100%; }
  </style>
</head>
<body>
  <header>
    <div>Web Terminal</div>
    <div class="pill" id="status">connecting...</div>
  </header>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    const statusEl = document.getElementById('status');
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: '#08111f', foreground: '#d7e1ff', cursor: '#7dd3fc' }
    });
    term.open(document.getElementById('terminal'));
    term.focus();

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + location.host + '/ws');
    ws.onopen = () => { statusEl.textContent = 'connected'; };
    ws.onclose = () => { statusEl.textContent = 'disconnected'; term.write('\\r\\n[connection closed]\\r\\n'); };
    ws.onerror = () => { statusEl.textContent = 'error'; };
    ws.onmessage = (ev) => term.write(ev.data);
    term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    window.addEventListener('resize', () => term.fit?.());
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const shell = spawn(SHELL, [], {
    cwd: CWD,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  ws.send(`Connected to ${os.hostname()}\\r\\n$ `);
  shell.stdout.on('data', (d) => ws.send(d.toString('utf8')));
  shell.stderr.on('data', (d) => ws.send(d.toString('utf8')));
  shell.on('close', (code) => {
    if (ws.readyState === ws.OPEN) ws.send(`\\r\\n[process exited ${code}]\\r\\n`);
    ws.close();
  });
  ws.on('message', (msg) => shell.stdin.write(msg));
  ws.on('close', () => shell.kill('SIGKILL'));
});

server.listen(PORT, HOST, () => {
  console.log(`Web terminal listening on http://${HOST}:${PORT}`);
  console.log(`Shell: ${SHELL}`);
  console.log(`CWD: ${CWD}`);
});
