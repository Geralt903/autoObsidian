# Claude Notes — 项目文档

> 给未来的你：这是一份修改这个项目的完整指南。

## 项目概要

手机笔记助理 Web 应用。用户用自然语言操作 Obsidian 笔记（记录、搜索、修改、日程、记账），后端 Claude API (DeepSeek Anthropic 端点) 通过 FNS 服务读写 Obsidian vault。

**核心价值**：移动端友好的网页界面，AI 理解意图 → 自动调用 FNS 工具操作笔记。

## 架构

```
手机浏览器                Claude Notes (Node.js)          FNS API (Go)           Obsidian
    │                           │                           │                     │
    │  HTTP/SSE                 │  HTTP Bearer Token        │  filesystem         │
    ├──────────────────────────►├──────────────────────────►├────────────────────►│
    │  /api/chat/stream         │  /api/vault               │                     │
    │  /api/tasks               │  /api/notes               │  Life-Learing/      │
    │  /api/login               │  /api/note               │  Life-Learning/     │
    │                           │                           │  Uno/               │
    ▼                           ▼                           ▼                     ▼
```

## 部署位置

| 服务 | 地址 | 进程 | 启动方式 |
|------|------|------|----------|
| **Web 终端** | `0.0.0.0:8000` | `node web-terminal.js` | `source local.config.sh && nohup node /path/to/web-terminal.js >> web.log 2>&1 &` |
| **FNS API** | `127.0.0.1:9000` | 独立 Go 服务 | 系统级管理，不在本项目 |
| **MCP Server** | stdio | `python3 server.py` | Claude Code 通过 `.mcp.json` 自动加载 |

## 文件清单

```
cloud_make_calender/
├── CLAUDE.md              ← 你正在读的文档
├── .mcp.json              # Claude Code MCP 注册（项目根目录，不是 .claude/ 下）
├── .claude/skills/        # Claude Code skill 文件
│   ├── calendar-event.md
│   └── fns-notes.md
├── src/
│   ├── web-terminal.js    ★ 主应用（1342 行）— HTTP 服务器 + Anthropic SDK + HTML UI
│   ├── server.py          ★ MCP 服务器（272 行）— 供 Claude Code 调用
│   ├── fns-note-tool.js   CLI 调试工具（85 行）
│   ├── package.json       Node 依赖：@anthropic-ai/sdk
│   ├── local.config.sh    ★ 环境变量 + Token（不入 git，.gitignore 已排除）
│   ├── start-all.sh       快速启动脚本
│   └── web.log            运行日志（不入 git）
```

## 环境变量（local.config.sh）

```bash
# FNS 连接
FNS_BASE_URL='http://127.0.0.1:9000'    # FNS 服务地址
FNS_TOKEN='<JWT>'                       # FNS API 令牌
FNS_DEFAULT_VAULT='Life-Learing'        # 默认 vault（408 条笔记）
FNS_TASKS_PREFIX='000 PARA/020 Areas/AI任务/'  # 范式文件夹前缀

# Claude API（DeepSeek 端点）
ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
ANTHROPIC_AUTH_TOKEN='<API_KEY>'
ANTHROPIC_MODEL='deepseek-v4-pro'
ANTHROPIC_MODELS='deepseek-v4-pro,deepseek-v4-flash'

# 登录
WEB_ACCESS_PASSWORD_HASH='<salt>:<hash>'  # pbkdf2(sha512, 100000轮)
COOKIE_SECRET='<random>'                  # HMAC 签名密钥

# 其他
WEB_TERMINAL_HOST='0.0.0.0'
WEB_TERMINAL_PORT='8000'
```

## API 端点

### 公开（无需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 主页面（需 cookie）或登录页 |
| POST | `/api/login` | `{password}` → 设 cookie |
| POST | `/api/logout` | 清除 cookie |
| GET | `/api/ui/health` | 健康检查 |

### 需登录
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/stream` | SSE 流式对话 `{message, taskPath?, taskContent?, model?, history?}` |
| POST | `/api/chat` | 非流式对话（降级用） |
| GET | `/api/jobs` | 作业队列 |
| POST | `/api/job/cancel` | 取消当前作业 |
| POST | `/api/jobs/clear` | 清除历史作业 |
| GET | `/api/config` | 模型列表 |
| GET | `/api/tasks` | 范式列表 |
| GET | `/api/task?path=` | 范式内容 |
| GET | `/api/ui/vaults` | Vault 列表 |

## FNS API（本项目不实现，仅调用）

| 端点 | 用途 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/vault` | 列出 vault（注意：单数路径） |
| `GET /api/notes?vault=&keyword=&searchContent=true` | 搜索/列表笔记 |
| `GET /api/note?vault=&path=` | 读取笔记 |
| `POST /api/note` | 创建/覆盖笔记 `{vault, path, content}` |
| `POST /api/note/append` | 追加 |
| `POST /api/note/prepend` | 前插 |
| `POST /api/note/replace` | 替换 |

## 注意事项 & 禁区

### web-terminal.js
- **文件名是 CommonJS**（`require`），不是 ESM
- **HTML 内联在模板字符串中**（单文件部署），CSS/JS 全部写在一个反引号里
- **模板字符串转义陷阱**：在 `\`` 模板字面量里，`\w` `\s` `\n` `\*` 等不是合法 JS 字符串转义，反斜杠会被吃掉。正则中的 `\w` 必须写成 `\\w`
- **流式响应**用 `textContent` 实时显示，结束后必须调 `formatMarkdown()` 转 HTML
- **密码哈希**用 `crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512')`
- **Cookie 签名**用 `crypto.createHmac('sha256', COOKIE_SECRET)`

### server.py
- **stdin/stdout 通信**，不要往 stdout 打日志（会破坏 JSON-RPC）
- FNS API 返回 HTTP 200 + body `status:false` 时不是 HTTP 错误，需要在 `_request()` 里检测
- `/api/vaults` 不存在，正确的路径是 `/api/vault`（单数）
- 候选路径试探模式：逐个试，FNS 层 error 抛异常后试下一个

### MCP 配置
- 文件在**项目根目录 `.mcp.json`**（不是 `.claude/mcp.json` — 那个位置会被静默忽略）
- Claude Code 需要 `~/.claude.json` 中 `enabledMcpjsonServers` 包含服务器名
- env vars 通过 `env` 字段传递，不要用 `--env` 参数

### 范式系统
- 5 个范式存在 `Life-Learing` vault 的 `000 PARA/020 Areas/AI任务/` 下
- 槽位绑定保存在 `localStorage.setItem('autoobsidian_slots', ...)`
- 范式下拉框加载 `/api/tasks`，按需加载内容到 `paradigmCache`

## UI 功能速览

```
手机端布局：
┌──────────────────────┐
│ C Claude Notes Pro 🗑 ready │  ← header 一行
├──────────────────────┤
│    聊天消息区域       │  ← main (flex-grow)
│    (消息有左右边框色) │
├──────────────────────┤
│ [▾范式] [上下文] [+] [+] │  ← paradigm-row
│ [输入框........] [发送] │  ← bar
└──────────────────────┘
```

- **槽位**：单击切换范式，双击绑定当前范式，存 localStorage
- **上下文按钮**：开启后附带最近 10 轮对话历史
- **Pro/Flash**：模型切换按钮，点一次切换
- **🗑**：清除历史，点一次变红确认，再点执行
- **✕**：取消正在运行的任务
- **状态指示器**：ready / running / queued / error

## 修改密码

```bash
node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.pbkdf2Sync('新密码',s,100000,64,'sha512').toString('hex'))"
# 把输出替换 local.config.sh 里的 WEB_ACCESS_PASSWORD_HASH
```

## 快速重启

```bash
cd ~/cloud_make_calender/src
ps aux | grep web-terminal | grep -v grep | awk '{print $2}' | xargs kill
source local.config.sh
> web.log
nohup node /home/Gragra/cloud_make_calender/src/web-terminal.js >> web.log 2>&1 &
tail -3 web.log  # 确认 FNS: http://127.0.0.1:9000
```
