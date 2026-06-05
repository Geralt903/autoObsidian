# FNS Notes Skill

Use this skill for all note-taking, note-searching, and note-editing operations through the FNS MCP server.

## Trigger

User says things like:
- "帮我记一条笔记" / "Take a note for me"
- "搜索关于 X 的笔记" / "Search notes about X"
- "看一下那篇笔记" / "Read that note"
- "在这篇笔记里追加..." / "Append to this note..."
- "修改笔记的 frontmatter" / "Update note frontmatter"

## Available MCP Tools

| Tool | Use When |
|------|----------|
| `vault_list` | User asks what vaults are available |
| `note_search` | **Default first step** — user mentions a topic/keyword; extract 1-3 keywords and search |
| `note_get` | User wants to read a specific note; ALWAYS call before modifying |
| `note_list` | User explicitly asks to browse the full note list (rare) |
| `note_create_or_update` | Create a new note or overwrite an existing one |
| `note_append` | Add content to the end of an existing note |
| `note_prepend` | Add content to the beginning of an existing note |
| `note_replace` | Replace specific text within a note |
| `note_patch_frontmatter` | Modify YAML frontmatter fields |

## Core Principles

### 1. Search First, Don't Traverse

When the user mentions a topic, extract 1-3 keywords and use `note_search`. Never use `note_list` to browse the entire vault — only use it when the user explicitly wants to see a directory listing.

### 2. Read Before Write

Always call `note_get` to read the current content before making modifications. This prevents accidental overwrites and helps you understand the existing structure.

### 3. Minimal Operations

Use the most targeted operation:
- Add to end → `note_append`
- Add to beginning → `note_prepend`
- Change specific text → `note_replace`
- Change frontmatter → `note_patch_frontmatter`
- Full overwrite/new file → `note_create_or_update`

### 4. Chinese-First Communication

The user primarily communicates in Chinese. Respond in Chinese, explaining what you changed and which note was modified.

### 5. Confirm Before Destructive Actions

Before overwriting an existing note (`note_create_or_update` on an existing path), briefly confirm the action to the user.

## Standard Workflow

```
1. User makes a request
2. Extract keywords → note_search
3. Review search results, identify target note
4. note_get to read current content (if modifying)
5. Choose the right tool and apply the change
6. Summarize what was done in Chinese
```

## Default Vault

Unless the user specifies otherwise, use vault `Life-Learing`.

## Time Zone

All dates/times are in `Asia/Shanghai`. When the user says "tomorrow", "next week", etc., resolve against the current Shanghai time.
