# Calendar Event Skill

Use this skill when the user asks to create, format, or modify calendar event notes in the Obsidian vault.

## Trigger

User says things like:
- "创建一条日历事件" / "Create a calendar event"
- "记一下明天的会议" / "Note down tomorrow's meeting"
- "把这个加到日历" / "Add this to calendar"
- "格式化这个事件" / "Format this event"

## Workflow

### 1. Extract Information

From the user's request, extract:
- **date** — event date (resolve relative dates against the current date and `Asia/Shanghai` timezone)
- **title** — event title
- **allDay** — true if no specific time given; false only when a concrete start time is known
- **startTime** / **endTime** — 24-hour `HH:MM` format, only for timed events
- **location** — only if the user supplied a place/room
- **body details** — submission items, platform times, attachments, requirements, notes

### 2. Create the Note File

Use `note_create_or_update` MCP tool. Filename pattern:

```
YYYY-MM-DD title.md
```

- First 10 characters: ISO date
- Then a single space, then the `title` value
- Preserve Chinese/English course codes, numbers, and short punctuation

### 3. Frontmatter

All-day events:
```yaml
---
title: Event title
allDay: true
date: YYYY-MM-DD
completed: null
---
```

Timed events:
```yaml
---
title: Event title
allDay: false
startTime: HH:MM
endTime: HH:MM
date: YYYY-MM-DD
completed: null
location: Location
---
```

Required fields: `title`, `allDay`, `date`, `completed` (always `null` for new events).

### 4. Body (Optional)

Only add body text when the user provides useful details. Use this style:
```markdown
Short one-line summary

- 字段：内容
- 字段：内容
```

Guidelines:
- Keep the first body line as a plain human-readable summary
- Use short bullets for structured details
- Prefer Chinese labels when event details are Chinese: `课程`, `作业`, `截止时间`, `时间`, `地点`, `提交内容`, `附件`, `要求`, `备注`
- Keep deadlines explicit with date and time, e.g. `2026-05-31 23:59`
- Do NOT invent missing details

### 5. Quality Check

Before finishing, verify:
- Filename date equals frontmatter `date`
- Filename title equals frontmatter `title`
- YAML fence appears at the top and closes before the body
- `completed` is `null`, not empty and not quoted
- Timed events use `allDay: false` and 24-hour time
- All-day events do not include `startTime` or `endTime`
