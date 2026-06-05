#!/usr/bin/env node
const { URL } = require('url');

const FNS_BASE_URL = (process.env.FNS_BASE_URL || 'http://20.205.107.61:9000').replace(/\/+$/, '');
const FNS_TOKEN = process.env.FNS_TOKEN || '';
const DEFAULT_VAULT = process.env.FNS_DEFAULT_VAULT || 'Life-Learing';

function usage() {
  console.log(`Usage:
  node fns-note-tool.js health
  node fns-note-tool.js vaults
  node fns-note-tool.js list [vault] [page]
  node fns-note-tool.js search <keyword> [vault]
  node fns-note-tool.js folder <prefix> [vault]
  node fns-note-tool.js get <path> [vault]
  node fns-note-tool.js save <path> <content> [vault]
  node fns-note-tool.js append <path> <content> [vault]
  node fns-note-tool.js prepend <path> <content> [vault]
  node fns-note-tool.js replace <path> <old> <new> [vault]`);
}

async function request(path, { method = 'GET', params, body } = {}) {
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
  if (!resp.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const vault = args.at(-1) && args.at(-1).startsWith('vault=') ? args.pop().slice(6) : undefined;
  let result;
  if (!cmd || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'health') result = await request('/api/health');
  else if (cmd === 'vaults') result = await request('/api/vault');
  else if (cmd === 'list') {
    result = await request('/api/notes', { params: { vault: args[0] || vault || DEFAULT_VAULT, page: args[1] || 1 } });
  } else if (cmd === 'search') {
    result = await request('/api/notes', { params: { vault: vault || args[1] || DEFAULT_VAULT, keyword: args[0], searchContent: true, page: 1 } });
  } else if (cmd === 'folder') {
    const prefix = args[0] || '';
    const keyword = prefix.split('/').filter(Boolean).at(-1) || prefix;
    result = await request('/api/notes', { params: { vault: vault || args[1] || DEFAULT_VAULT, keyword, searchContent: false, page: 1 } });
    const list = result?.data?.list || [];
    result.data.list = list.filter((note) => String(note.path || '').startsWith(prefix));
  } else if (cmd === 'get') {
    result = await request('/api/note', { params: { vault: vault || args[1] || DEFAULT_VAULT, path: args[0] } });
  } else if (cmd === 'save') {
    result = await request('/api/note', { method: 'POST', body: { vault: vault || args[2] || DEFAULT_VAULT, path: args[0], content: args[1] || '' } });
  } else if (cmd === 'append') {
    result = await request('/api/note/append', { method: 'POST', body: { vault: vault || args[2] || DEFAULT_VAULT, path: args[0], content: args[1] || '' } });
  } else if (cmd === 'prepend') {
    result = await request('/api/note/prepend', { method: 'POST', body: { vault: vault || args[2] || DEFAULT_VAULT, path: args[0], content: args[1] || '' } });
  } else if (cmd === 'replace') {
    result = await request('/api/note/replace', { method: 'POST', body: { vault: vault || args[3] || DEFAULT_VAULT, path: args[0], old: args[1] || '', new: args[2] || '' } });
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
