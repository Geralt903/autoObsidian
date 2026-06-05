# autoObsidian — 云笔记 Claude Code 项目

## 概述

autoObsidian 是 FNS（Fast Note Sync）笔记服务与 Claude/AI 助手之间的桥梁。它把 FNS API 包装成两种可用形式：

1. **MCP Server**（`server.py`）— 实现 JSON-RPC 协议的 MCP 服务器，供 Claude Code 等 AI 工具直接调用操作笔记
2. **Web 终端**（`web-terminal.js`）— 移动端友好的网页，内嵌 Claude API 实现自然语言笔记操作

后端笔记存储是 Obsidian vault，通过 FNS 服务暴露 REST API。

## 架构

```
┌─────────────────────────────────────────────────┐
│                   Claude Code                     │
│            (MCP JSON-RPC over stdin)              │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│              server.py (Python)                   │
│         MCP Server + FNS HTTP Client              │
└─────────────────┬───────────────────────────────┘
                  │ HTTP (Bearer Token)
                  ▼
┌─────────────────────────────────────────────────┐
│              FNS API Service                      │
│         (REST API over Obsidian vaults)           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              Web Browser (Mobile/Desktop)          │
└─────────────────┬───────────────────────────────┘
                  │ HTTP (SSE/JSON)
                  ▼
┌─────────────────────────────────────────────────┐
│          web-terminal.js (Node.js)                │
│      Anthropic API → Claude tool use → FNS        │
└────────┬──────────────────┬─────────────────────┘
         │                  │
         ▼                  ▼
   Anthropic API       FNS API
```

## 目录结构

```
cloud_make_calender/
├── CLAUDE.md              # 本文件 — Claude Code 项目文档
├── format.skill           # 旧版日历事件格式约定（将被迁移到 .claude/skills/）
├── .claude/
│   ├── mcp.json           # MCP server 注册配置
│   ├── settings.json      # 项目级 Claude Code 设置
│   └── skills/
│       ├── calendar-event.md  # 日历事件格式化 skill
│       └── fns-notes.md       # 笔记操作 skill
├── src/
│   ├── server.py          # ★ MCP 服务器（Python）
│   ├── web-terminal.js    # ★ Web 终端（Node.js + Anthropic SDK）
│   ├── fns-note-tool.js   # FNS CLI 工具（独立调试用）
│   ├── package.json       # Node 依赖
│   ├── requirements.txt   # Python 依赖
│   ├── local.config.sh    # 本地环境变量（不入 git）
│   ├── install.sh         # 安装脚本
│   ├── start-all.sh       # 快速启动脚本
│   └── node_modules/      # npm 依赖
```

## 关键文件

| 文件 | 语言 | 职责 |
|------|------|------|
| `src/server.py` | Python 3.10+ | MCP JSON-RPC server，提供 10 个 FNS 工具 |
| `src/web-terminal.js` | Node.js (CommonJS) | HTTP 服务器 + Web UI + Anthropic API tool-use loop |
| `src/fns-note-tool.js` | Node.js (CommonJS) | CLI 工具，命令行直接操作 FNS |

## 环境变量

所有配置通过环境变量传递，本地开发时在 `src/local.config.sh` 中设置。

| 变量 | 必须 | 默认值 | 说明 |
|------|------|--------|------|
| `FNS_TOKEN` | ✅ | — | FNS API Bearer Token |
| `FNS_BASE_URL` | — | `http://127.0.0.1:9000` | FNS 服务地址 |
| `FNS_DEFAULT_VAULT` | — | `Life-Learing` | 默认 vault 名 |
| `FNS_TASKS_PREFIX` | — | `000 PARA/020 Areas/AI任务/` | AI 任务范式文件夹前缀 |
| `ANTHROPIC_BASE_URL` | — | `https://api.deepseek.com/anthropic` | Anthropic 兼容 API 端点 |
| `ANTHROPIC_AUTH_TOKEN` | Web 端需要 | — | API 认证 token |
| `ANTHROPIC_MODEL` | — | `deepseek-v4-pro` | Web 端使用的模型 |
| `ANTHROPIC_MODELS` | — | `deepseek-v4-pro,deepseek-v4-flash` | Web UI 下拉框可选模型（逗号分隔） |
| `WEB_TERMINAL_HOST` | — | `0.0.0.0` | Web 服务器监听地址 |
| `WEB_TERMINAL_PORT` | — | `8000` | Web 服务器监听端口 |
| `APP_TIME_ZONE` | — | `Asia/Shanghai` | 应用时区 |

## 快速开始

### 安装

```bash
cd src/
./install.sh
# 编辑 local.config.sh 填入 FNS_TOKEN 和 ANTHROPIC_API_KEY
```

### 启动 Web 终端（移动端使用）

```bash
cd src/
source local.config.sh
npm run web
# 打开 http://127.0.0.1:8000
```

### 启动 MCP Server（供 Claude Code 使用）

MCP server 已通过 `.claude/mcp.json` 注册，在项目目录启动 Claude Code 即自动加载。

也可手动运行测试：
```bash
cd src/
source local.config.sh
python3 server.py
# 然后通过 stdin 发送 JSON-RPC 消息
```

## MCP 工具列表

`server.py` 提供以下工具（在 Claude Code 中直接可用）：

| 工具名 | 说明 |
|--------|------|
| `vault_list` | 列出所有 vault |
| `note_list` | 列出 vault 中的笔记 |
| `note_search` | 按关键词搜索笔记 |
| `note_get` | 读取笔记内容 |
| `note_append` | 追加内容到笔记末尾 |
| `note_prepend` | 插入内容到笔记开头 |
| `note_replace` | 替换笔记中的指定文本 |
| `note_patch_frontmatter` | 修改笔记 frontmatter |
| `note_create_or_update` | 创建或覆盖笔记 |

## 编码约定

### Python（server.py）
- 标准库 + `requests`，无其他依赖
- `dataclass` 用于配置对象
- 异常：抛 `RuntimeError`，由 `main()` 统一捕获并返回 JSON-RPC error
- 工具 schema 在 `tool_schemas()` 中集中定义
- 添加新 API：在 `FNSClient` 中加方法 → 在 `tool_schemas()` 中注册 → 在 `handle_call()` 中分发

### Node.js（web-terminal.js, fns-note-tool.js）
- **CommonJS**（`require`），不要用 ESM
- 依赖：`@anthropic-ai/sdk`（Web 端），无其他运行时依赖
- `web-terminal.js` 内联所有 HTML/CSS/JS（单文件部署）
- 添加新工具：在 `FNS_TOOLS` 数组中加定义 → 在 `executeToolCall()` 中加 case → 工具自动对 Claude 可见
- Web UI 样式：CSS 自定义属性在 `:root` 中集中定义，响应式断点：960px（桌面）、640px（平板）、380px（小手机）

### 笔记格式（前Matter 约定）
- Obsidian Markdown 文件，YAML frontmatter 在前
- 日历事件：文件名为 `YYYY-MM-DD title.md`，详见 `.claude/skills/calendar-event.md`
- AI 任务范式：存放在 `FNS_TASKS_PREFIX` 文件夹下

## 常见开发任务

### 添加新的 FNS API 操作

1. `server.py` — 在 `FNSClient` 中添加方法（用多候选路径试探模式）
2. `server.py` — 在 `tool_schemas()` 中添加 tool 定义
3. `server.py` — 在 `handle_call()` 中添加分发
4. `web-terminal.js` — 在 `FNS_TOOLS` 数组中添加 tool 定义
5. `web-terminal.js` — 在 `executeToolCall()` 中添加 case
6. （可选）`fns-note-tool.js` — 添加 CLI 命令

### 修改 Claude 系统提示词

编辑 `web-terminal.js` 中的 `buildSystemPrompt()` 函数。

### 支持新的 Claude 模型

修改 `local.config.sh` 中的 `CLAUDE_MODELS`（逗号分隔），Web UI 下拉框自动更新。

## 注意事项

- `local.config.sh` 包含 token，**不要提交到 git**
- FNS API 的端点路径有多个备选（如 `/api/vaults` 和 `/api/vault`），代码中用多候选试探模式处理
- Web 端的任务范式功能依赖 FNS 中存在 `FNS_TASKS_PREFIX` 路径
- MCP server 使用 stdin/stdout 通信，不要往 stdout 输出日志（会破坏 JSON-RPC 协议）
