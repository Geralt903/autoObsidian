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
    │  /api/bills               │  /api/note/append        │  Uno/               │
    │  /api/parse-file          │                           │                     │
    ▼                           ▼                           ▼                     ▼
```

## 部署位置

| 服务 | 地址 | 进程 | 启动方式 |
|------|------|------|----------|
| **Web 终端** | `0.0.0.0:8000` | `node web-terminal.js` | `source local.config.sh && nohup node /path/to/web-terminal.js >> web.log 2>&1 &` |
| **FNS API** | `127.0.0.1:9000` | 独立 Go 服务 | 系统级管理，不在本项目 |

## 文件清单

```
cloud_make_calender/
├── CLAUDE.md              ← 你正在读的文档
├── .mcp.json              # Claude Code MCP 注册（项目根目录）
├── .gitignore             # 排除 node_modules/, local.config.sh, *.log
├── .claude/skills/
│   ├── calendar-event.md
│   └── fns-notes.md
├── src/
│   ├── web-terminal.js    ★ 主应用 — HTTP 服务器 + Anthropic SDK + HTML UI
│   ├── server.py          ★ MCP 服务器 — 供 Claude Code 调用
│   ├── fns-note-tool.js   CLI 调试工具
│   ├── package.json       Node 依赖：@anthropic-ai/sdk, xlsx
│   ├── local.config.sh    ★ 环境变量 + Token（不入 git）
│   └── web.log            运行日志（不入 git）
```

## 环境变量（local.config.sh）

```bash
# FNS 连接
FNS_BASE_URL='http://127.0.0.1:9000'
FNS_TOKEN='<JWT>'
FNS_DEFAULT_VAULT='Life-Learing'
FNS_TASKS_PREFIX='000 PARA/020 Areas/AI任务/'

# Claude API（DeepSeek 端点）
ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
ANTHROPIC_AUTH_TOKEN='<API_KEY>'
ANTHROPIC_MODEL='deepseek-v4-pro'
ANTHROPIC_MODELS='deepseek-v4-pro,deepseek-v4-flash'

# 登录
WEB_ACCESS_PASSWORD_HASH='<salt>:<hash>'  # pbkdf2(sha512, 100000轮)
COOKIE_SECRET='<random>'                  # HMAC 签名密钥
```

## API 端点

### 公开（无需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 主页面或登录页 |
| POST | `/api/login` | `{password}` → 设 cookie |
| GET | `/api/ui/health` | 健康检查 |

### 需登录
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/stream` | SSE 流式对话 `{message, taskPath?, taskContent?, model?, history?, files?}` |
| POST | `/api/chat` | 非流式对话（降级用） |
| GET | `/api/jobs` | 作业队列 |
| POST | `/api/job/cancel` | 取消当前作业 |
| POST | `/api/jobs/clear` | 清除历史作业 |
| GET | `/api/config` | 模型列表 |
| GET | `/api/tasks` | 范式列表 |
| GET | `/api/task?path=` | 范式内容（仅限 TASKS_PREFIX） |
| GET | `/api/note/read?path=` | 读取任意笔记 |
| GET | `/api/bills?month=YYYY-MM` | 月度账单聚合 |
| POST | `/api/parse-file` | 解析 Excel 文件 `{name, data}` |

## FNS API（本项目不实现，仅调用）

| 端点 | 用途 |
|------|------|
| `GET /api/vault` | 列出 vault（单数路径！） |
| `GET /api/notes?vault=&keyword=&searchContent=true` | 搜索/列表笔记 |
| `GET /api/note?vault=&path=` | 读取笔记 |
| `POST /api/note` | 创建/覆盖笔记 `{vault, path, content}` |
| `POST /api/note/append` | 追加 |
| `POST /api/note/replace` | 替换 |

## 注意事项 & 禁区

### web-terminal.js
- **文件名是 CommonJS**（`require`），不是 ESM
- **HTML 内联在模板字符串中**（单文件部署）
- **模板字符串转义陷阱**：`\n` `\w` `\s` `\*` 不是合法 JS 字符串转义，必须写成 `\\n` `\\w` `\\s` `\\*`
- **反引号**用 `\x60` 转义
- **流式响应**：`textContent` 实时显示，结束后调 `formatMarkdown()` 转 HTML
- **密码哈希**：`crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512')`
- **Cookie 签名**：`crypto.createHmac('sha256', COOKIE_SECRET)`
- **断线恢复**：`req.on('close')` 只设 `_disconnected`，不设 `_aborted`。任务继续执行，客户端重连后轮询 jobs 补回结果

### server.py
- **MCP 配置在项目根目录 `.mcp.json`**，不是 `.claude/mcp.json`
- FNS API 返回 HTTP 200 + body `status:false` 需在 `_request()` 检测
- `/api/vaults` 不存在，正确路径是 `/api/vault`（单数）

### 对话系统
- 对话存储在 `localStorage` key `claudenotes_convs`
- 每条对话自包含全部消息，上下文从 `conv.messages` 提取
- 运行中的对话每 2 秒轮询 `/api/jobs` 检查进度
- 断线不中断任务，`_aborted` 只由手动取消触发

### 范式系统
- 5 个范式在 `Life-Learing` vault 的 `000 PARA/020 Areas/AI任务/` 下
- 槽位绑定：`localStorage` key `autoobsidian_slots`
- 范式内容按需加载到 `paradigmCache`

## UI 功能速览

```
桌面端：                          手机端：
┌────────┬──────────────┐      ┌──────────────────┐
│ 对话列表 │  聊天/账单/待办 │      │ Header · Pro  🗑  │
│ · · ·  │              │      │   聊天/账单/待办   │
│ · · ·  │              │      │   输入框    [发送] │
└────────┴──────────────┘      ├──────────────────┤
                               │ 💬对话 💰账单 ✅待办│ ← 固定底部
                               └──────────────────┘
```

- **底部 Tab**：对话 / 账单 / 待办（固定不滚动）
- **账单页**：月份切换、上中下旬筛选、日期下钻
- **文件上传**：📎 按钮，图片走 Vision，Excel 服务端解析
- **单轮开关**：ON=每次新建对话，OFF=连续对话带上下文
- **槽位**：单击切换范式，双击绑定范式

## 修改密码

```bash
node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.pbkdf2Sync('新密码',s,100000,64,'sha512').toString('hex'))"
# 替换 local.config.sh 里的 WEB_ACCESS_PASSWORD_HASH
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
