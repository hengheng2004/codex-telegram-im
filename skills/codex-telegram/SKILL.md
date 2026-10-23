---
name: codex-telegram
description: Contact the user through their personal Codex Telegram companion for proactive notifications or questions that need a reply. Use when the user requests Telegram contact, when a long-running task needs input away from the computer, or when a useful completion or failure notification was requested.
---

# Codex Telegram

Use the `codex-telegram` MCP tools:

- Use `telegram_notify` only for strictly one-way completion, failure, or attention-needed messages. Never use it when the user may reasonably want to reply.
- Use `telegram_ask` whenever the user's answer should continue the initiating Codex task. The answer returns to that exact tool call.
- Use `telegram_send_file` when the user asks to receive a generated or existing project file. Only send files inside the current project, never send secrets or runtime state, and include a short caption when useful.
- For a locally initiated call, always pass `project_path` as the current workspace's absolute project folder. The relay creates or reuses a Telegram topic for that project.
- During a Telegram-originated turn, pass the verified `topic_id` supplied in the turn instructions so concurrent tasks route to the correct topic.
- Pass `thread_id` only when the current Codex thread ID is actually available. Never guess it.
- Use `topic_id` only when the user explicitly chose a Telegram topic or the current task has a verified topic ID.
- Keep messages concise and include enough project/task context to be actionable. Never send passwords, tokens, private keys, recovery phrases, or other secrets.

Codex Remote does not expose a supported task-targeting API to this bridge. `telegram_ask` preserves the initiating task by keeping its tool call open; it does not inject arbitrary later messages into Remote. Direct replies to `telegram_notify` are deliberately rejected instead of silently creating a separate chat. A new non-reply message in a Telegram topic starts or continues that topic's separate local App Server chat.
