# codex-telegram-im

A small personal bridge that makes one private Telegram forum group act like a mobile front end for local Codex App Server chats and a notification channel for an initiating Codex task.

The **Codex** bot uses Telegram topics. Each topic maps to exactly one saved local App Server chat and remembers that chat's local project folder. You can start a local chat in Telegram, attach a topic to an existing App Server thread, and later continue that saved thread from a compatible local Codex client.

It also exposes three local MCP tools so Codex and supported local ChatGPT Work sessions can notify you, ask a blocking question, or upload a project file through Telegram. A bundled Codex skill teaches local chats to include their project path, so locally initiated contact creates or reuses the correct project topic instead of falling into General.

This is deliberately a single-user local utility—not a hosted service, multi-user bot, or platform. `README.md` is the source of truth for rebuilding it.

This distribution includes the local compatibility changes and a portable macOS
setup flow. It is based on [patriceac/codex-telegram](https://github.com/patriceac/codex-telegram)
under the included MIT license. The target personal repository is
`hengheng2004/codex-telegram-im` (available after publication).

## Deploy on another Mac with Codex

Use [the Chinese macOS install guide](INSTALL_MACOS.md) or give the target Mac's
local Codex [these deployment instructions](DEPLOY_WITH_CODEX.md). Each Mac uses
its own bot, private topic group, `.env`, bridge secret, and state. With different
bots, the original computer can keep running. No old-machine credentials or
history are required for a fresh installation.

The macOS installer checks paths on the target machine, pairs a new bot through
hidden local token entry and a one-time code, writes private configuration,
registers the local MCP server and skill, and installs a user launchd agent.
It requires Python 3.9+, Node.js 20+, npm, and a logged-in Codex CLI; an optional
HTTP(S) proxy also requires Node environment-proxy support. `plan` is read-only,
`configure` pairs locally, `install` writes registrations, and `start` loads the
service. The default sandbox is `read-only`; `--sandbox workspace-write` explicitly
selects project write access. The generated wrapper disables hooks and subagents.
Account login, BotFather setup, local credential entry, and macOS permissions
remain interactive. No installation step silently copies the old computer's state.

To prepare a source-only GitHub distribution, follow
[the publication guide](PUBLISH_GITHUB.md). `python3 scripts/package-release.py`
exports reviewed source without Git history or private runtime files. The local
machine migration inventory is intentionally excluded from distribution.

## Mental model

```text
Private Telegram forum group named "Codex" (only you + the bot)
  General topic ───────────────► local App Server thread A (default folder)
  BitcoinBlockClock topic ─────► local App Server thread B (D:\Disk\Dev\BitcoinBlockClock)
  MAGE2 bug topic ─────────────► local App Server thread C (D:\Disk\Dev\MAGE2)

Codex Remote task ─────────────► separate Remote conversation

Local Codex or supported ChatGPT Work
  telegram_notify ─────────────► labelled one-way Telegram notification
  telegram_ask ────────────────► Telegram answer returned to the exact open tool call
  telegram_send_file ──────────► project-scoped Telegram document upload
```

The relay keys mappings by `(TELEGRAM_CHAT_ID, message_thread_id)` and stores `{threadId, cwd}` in ignored `.data/state.json`. It uses the official Codex App Server to list, start, resume, and stream stored threads. The working directory is the local project identity; an unbound topic uses `CODEX_WORKSPACE` as its default folder.

## What works

- Start a Telegram topic and send a message: it becomes a new Codex chat.
- Send a supported attachment (images, PDF, Word, Excel, Markdown, or TXT): it is saved under the current project's `.telegram-inbox/` and passed to that topic's Codex chat. A caption becomes the instruction; without one Codex is asked to inspect and handle the attachment.
- Bind that topic to any local folder with `/project` before starting work.
- List recent Codex chats in that folder with `/chats`.
- Continue an existing local Codex chat with `/attach`, or create a dedicated Telegram topic for it with `/open`.
- Continue the same saved App Server thread later in a compatible local Codex client.
- Let local Codex proactively call `telegram_notify` or wait on `telegram_ask`.
- Let Codex upload a regular project file to the correct Telegram topic with `telegram_send_file`.
- Return a `telegram_ask` answer to the exact initiating tool call, including an initiating Remote task when that task can call the local MCP tool and remains active.
- Label `telegram_notify` as one-way and reject direct replies instead of silently creating an unrelated local chat.
- Give Telegram-originated Codex turns the configured sandbox level, including `danger-full-access` when explicitly selected.
- Run turns from different Telegram topics concurrently, up to `CODEX_MAX_CONCURRENT_TURNS`; each topic remains single-turn.

The bridge synchronizes local App Server conversation history, project folder, and final answers—not the exact UI state of an already-open desktop window. Do not submit simultaneous turns to the same local thread from Telegram and another client. Concurrent topics use separate, lazily started App Server processes, while the relay prevents two topics from writing the same saved thread at once. Idle topic processes are closed after `CODEX_RUNNER_IDLE_SECONDS` when that value is greater than zero.

Codex Remote is a separate interface and does not expose a supported third-party API that lets this bridge inject an arbitrary later Telegram message into an existing Remote task. The supported continuity path is `telegram_ask`: it keeps the initiating MCP tool call open and returns the Telegram answer directly to that call. A later direct reply to `telegram_notify` is intentionally not forwarded.

ChatGPT cloud projects are separate from local Codex directory-backed threads. This bridge maps local Codex chats/projects; it cannot attach to an undocumented cloud ChatGPT Project API.

Existing chats do not all appear as Telegram topics automatically. First bind a topic to the project's local folder, run `/chats`, then use `/open <number>` to create a topic for a saved chat or `/attach <number>` to reuse the current topic. A project is represented by its local folder and may contain many chat topics.

## Requirements

- macOS for `scripts/setup-macos.py`, or Windows 10/11 for the PowerShell startup-task scripts. The Node relay itself is cross-platform.
- Node.js 20+ and npm.
- An authenticated current Codex CLI (`codex --version`, `codex login`).
- Telegram and a bot created through [@BotFather](https://t.me/BotFather).
- A local ChatGPT/Codex client new enough to expose the Codex App Server thread store.

The project uses your existing Codex login. It does not need an OpenAI API key.

## Fresh install on Windows

### 1. Clone it

```powershell
git clone https://github.com/hengheng2004/codex-telegram-im.git
cd codex-telegram-im
```

### 2. Create and configure the Telegram bot

In Telegram, open [@BotFather](https://t.me/BotFather):

1. Send `/newbot` and create the bot.
2. Set its display name to **Codex**.
3. Keep its HTTP API token private.
4. Create a new **private group** named **Codex** and add only yourself and the bot.
5. In the group's settings, enable **Topics**.
6. Promote the bot to administrator with only **Manage Topics** enabled. This lets `/open` create a topic and also lets the bot receive every message in the group.
7. Send one message in the group so the installer can discover its group ID and your user ID.

Telegram also supports topics in a direct bot chat through BotFather's **Threaded Mode**, but creating private-chat topics currently requires a Telegram Premium account. The private forum group is the free, recommended setup and gives the same one-topic-per-Codex-chat experience.

### 3. Install

For full computer access, as requested for this personal installation:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./scripts/install.ps1 -Sandbox danger-full-access -InstallStartupTask
```

The installer:

1. runs `npm ci` from the pinned lockfile;
2. prompts privately for the bot token;
3. discovers and allowlists both the private group ID and your numeric user ID;
4. asks for the default folder used by unbound topics;
5. writes an ignored `.env` with a random loopback secret;
6. installs the bundled `codex-telegram` skill into your Codex skills folder;
7. registers the local `codex-telegram` MCP server;
8. installs and starts the per-user `Codex Telegram` Scheduled Task without opening a console window.

`danger-full-access` means a Telegram message can cause Codex to read, modify, run, or delete anything available to your Windows account. Only use it with a private, strongly protected Telegram account. For a narrower reinstall, use `workspace-write` or the default `read-only` instead.

Restart ChatGPT desktop, the IDE, or a running Codex client after MCP registration.

### 4. Verify

```powershell
npm run check
npm run doctor
Get-ScheduledTask -TaskName 'Codex Telegram'
Get-Content .data/relay.log -Tail 30
```

Then verify the real experience:

1. In the private **Codex** group, create a topic named `Bridge test`.
2. In that topic, send `/project D:\Disk\Dev\codex-telegram` (use the actual clone path).
3. Send `Reply with exactly: Telegram topic works`.
4. Send `/status`; it should show a topic ID, project folder, and Codex thread ID.
5. Open the local project in a compatible local Codex client and resume that saved App Server chat; send one more turn.
6. Back in Telegram, send another message in the same topic and confirm it remembers the local turn.
7. In local Codex, ask it to use `telegram_notify`, then test `telegram_ask` and reply in Telegram.

## Daily use

Commands apply only to the Telegram topic in which they are sent:

- `/new` — detach the current Codex thread and start a new one on the next message; keep the project folder.
- `/projects` — list local Codex history projects, deduplicated by normalized `cwd`, most recently used first (all history pages).
- `/project <number>` — select from the last successful `/projects` list in this topic; numbering is kept in memory until the next list or relay restart. The directory must still exist.
- `/project <absolute folder>` — bind this topic to a local project and start fresh there.
- `/project` — show the current project folder.
- `/unproject` — reset to the default `CODEX_WORKSPACE` folder and start fresh.
- `/chats` — list ten recent Codex chats whose recorded working directory matches this topic's project.
- `/attach <number>` — after `/chats`, attach this Telegram topic to that existing Codex chat.
- `/attach <thread-id>` — attach directly by saved Codex thread ID.
- `/open <number>` — after `/chats`, create a new Telegram topic attached to that existing Codex chat.
- `/status` — show relay, topic, project, thread, sandbox, this topic's state, and total active-turn capacity.
- `/cancel` — interrupt the active Codex turn in this topic only.
- `/help` — show the command summary.

Typical flows:

**Start in Telegram:** create a topic → `/project D:\path\to\repo` → send the request → later resume the saved chat locally.

**Start locally:** work in a local Codex client that shares the App Server thread store → in Telegram bind a topic to the same project → `/chats` → `/attach 1` → continue it from your phone.

**Ask from an existing Codex task:** call `telegram_ask` → reply to the “Codex needs your input” message → the answer returns to that exact waiting tool call.

**Notify from an existing Codex task:** call `telegram_notify` → receive the labelled one-way notification. Direct replies are rejected; send a new non-reply message only when you intentionally want a separate Telegram-local project chat.

**No specific project:** use General or a new topic without `/project`; it runs from the configured default folder.

The MCP tools are:

- `telegram_notify(message, silent=false, topic_id?, project_path?, thread_id?)`
- `telegram_ask(question, timeout_seconds=600, topic_id?, project_path?, thread_id?)`
- `telegram_send_file(path, caption="", silent=false, topic_id?, project_path?, thread_id?)`

During a Telegram-originated turn, omitted routing fields return to the active topic. For locally initiated contact, the bundled skill passes the current absolute `project_path`; the relay creates or reuses a dedicated topic for that project. If a real `thread_id` is available, an existing exact thread mapping takes priority or a new thread-specific topic is created. An explicit `topic_id` always wins.

Use `telegram_ask` whenever an answer must return to the initiating Codex task. It keeps the tool call open and returns the answer to that exact call. Use `telegram_notify` only when no reply is expected: its message is labelled one-way, and a direct reply is rejected without starting a Codex turn. A new non-reply message in the topic intentionally starts or continues that topic's separate local App Server chat. Reply directly to a question when Telegram presents the reply control; otherwise the next message in that topic answers its sole waiting question.

Use `telegram_send_file` after creating a requested artifact. The relay resolves symlinks and accepts only regular files inside the routed topic's project folder. It rejects `.env`, `.data`, `.git`, `.codex`, `.agents`, SSH/cloud credential folders, and common credential filenames. Files are sent as Telegram documents so their original names are preserved. The default limit is 45 MB, below Telegram Bot API's 50 MB upload limit. Each upload attempt has a 60-second deadline and one retry by default; cancellation is propagated through MCP and the loopback relay so a stalled upload does not hold a Codex turn indefinitely.

For Telegram-originated turns that provide both an explicit `topic_id` and `project_path`, `telegram_send_file` uploads directly through the Bot API after loading the topic mapping and applying the same project, sensitive-path, size, timeout, and retry checks. This avoids a nested App Server → MCP → active relay call that can stall in some Codex hosts. Calls that need topic discovery still use the loopback relay.

## Manual/cross-platform install

```bash
git clone https://github.com/hengheng2004/codex-telegram-im.git
cd codex-telegram-im
npm ci
cp .env.example .env
```

Configure `.env`:

- `TELEGRAM_BOT_TOKEN`: BotFather token.
- `TELEGRAM_CHAT_ID`: the numeric private forum-group ID (it normally begins with `-100`), or a direct-bot chat ID.
- `TELEGRAM_USER_ID`: your numeric Telegram user ID; messages from every other sender are ignored.
- `TELEGRAM_MAX_FILE_MB`: maximum document upload size; must be greater than `0` and no more than Telegram's `50` MB Bot API limit (default `45`).
- `TELEGRAM_UPLOAD_TIMEOUT_SECONDS`: deadline for each Telegram document upload attempt, from `5` through `600` seconds (default `60`).
- `TELEGRAM_UPLOAD_RETRIES`: retries after transient upload failures, from `0` through `3` (default `1`).
- `CODEX_WORKSPACE`: default folder for topics without an explicit project.
- `CODEX_SANDBOX`: `read-only`, `workspace-write`, or `danger-full-access`.
- `CODEX_COMMAND`: usually `codex`.
- `CODEX_COMMAND_ARGS_JSON`: optional JSON-array prefix, useful when a service needs the absolute npm CLI script.
- `CODEX_SKIP_GIT_REPO_CHECK`: retained for compatibility with older `codex exec` installs; the App Server path does not normally need it.
- `CODEX_TIMEOUT_SECONDS`: bridge-level limit for one Codex turn; set to `0` for no bridge-imposed timeout.
- `CODEX_MAX_CONCURRENT_TURNS`: maximum simultaneous Codex turns across different topics, from `1` through `8` (default `2`).
- `CODEX_RUNNER_IDLE_SECONDS`: stop an idle topic's App Server after this many seconds; set to `0` to keep it alive (default `300`).
- `BRIDGE_TOKEN`: at least 24 random characters.
- `STATE_FILE` and `RELAY_LOG_FILE`: ignored local runtime files.

Register MCP and start the relay:

```bash
codex mcp add codex-telegram -- node /absolute/path/to/codex-telegram/src/mcp-server.js
npm start
```

Install the bundled skill as well. On Windows:

```powershell
./scripts/install-skill.ps1
```

On Linux/macOS, copy `skills/codex-telegram` to `${CODEX_HOME:-$HOME/.codex}/skills/codex-telegram`. Restart Codex or ChatGPT Work after installing the MCP server or skill.

On Linux use a user-level `systemd` unit; on macOS use a user `launchd` agent. Run Node with this repository as its working directory and keep secrets out of process arguments.

## Architecture

- `src/relay.js`: one Telegram long poller, topic commands, mapping logic, bounded topic concurrency, per-topic App Server lifecycle, and loopback MCP bridge.
- `src/app-server.js`: JSON-RPC client for `codex app-server --stdio`; thread list/start/resume, streamed turns, cancellation.
- `src/telegram.js`: direct Telegram Bot API calls, topics, typing, document uploads, and 4096-character splitting.
- `src/state.js`: atomic local persistence keyed by chat and topic ID.
- `src/mcp-server.js`: local stdio `telegram_notify`, `telegram_ask`, and `telegram_send_file` tools.
- `skills/codex-telegram/`: concise instructions that make Codex choose the right tool and include project-aware routing data.
- `scripts/install.ps1`: reproducible Windows installation.
- `scripts/setup-macos.py`: private pairing, portable paths, MCP/skill registration, and user launchd lifecycle for fresh macOS installations.
- `scripts/package-release.py`: allowlisted, checked source export without credentials, local state, or Git history.
- `scripts/install-skill.ps1`: installs the bundled skill into the user's Codex home.
- `scripts/install-startup-task.ps1`: per-user automatic startup.
- `scripts/run-relay-hidden.vbs`: windowless Windows launcher that preserves the relay exit code for Task Scheduler.
- `test/`: offline unit/regression tests.

`npm run check` and `npm test` select only the repository's `test/*.test.js`
files, including the Python installer checks when Python 3.9+ is available.
Exported source copies under `dist/` are not scanned. Temporary-file tests use
the OS temporary directory and do not require an existing private `.data` folder.

There is exactly one `getUpdates` poller. MCP calls go through a bearer-authenticated `127.0.0.1` HTTP endpoint so a second process cannot consume Telegram replies. A notification can fall back to a direct Bot API call when the relay is down; a question requires the relay to correlate the answer.

## Security

- A message is accepted only when both its chat ID equals `TELEGRAM_CHAT_ID` and its sender ID equals `TELEGRAM_USER_ID`.
- Keep the group private and keep its membership to yourself and the bot. The sender check is defense in depth, not a reason to invite others.
- The token, chat ID, bridge secret, logs, mappings, and thread IDs remain in ignored `.env`/`.data` files.
- The internal API binds to loopback and requires a random bearer token.
- There is no webhook, public port, cloud database, analytics layer, or hosted proxy.
- Telegram messages transit Telegram's servers. Never send passwords, recovery phrases, private keys, or similarly valuable secrets.
- File uploads are project-scoped and block common secret/state paths, but generated artifacts still transit Telegram's servers; review sensitive outputs before requesting an upload. Uploads have bounded attempts, retry only transient failures, and stop when the initiating MCP request is cancelled.
- Threaded mode separates context; it is not a security boundary. Every allowed topic has the same configured Codex permissions.
- Concurrent browser or computer-control turns can compete for the same foreground application. Keep those tasks in one topic at a time even when code-only topics run concurrently.
- Revoke the BotFather token and replace `.env` immediately if it leaks.

Before publishing changes:

```powershell
git status --short
git ls-files .env .data
git grep -n -I -E 'TELEGRAM_BOT_TOKEN=.+|BRIDGE_TOKEN=.{24,}' -- . ':!package-lock.json'
```

## Operations and troubleshooting

```powershell
Start-ScheduledTask -TaskName 'Codex Telegram'
Stop-ScheduledTask -TaskName 'Codex Telegram'

git pull --ff-only
npm ci
npm run check
Stop-ScheduledTask -TaskName 'Codex Telegram'
Start-ScheduledTask -TaskName 'Codex Telegram'
```

Remove startup/MCP registration without deleting state:

```powershell
./scripts/uninstall-startup-task.ps1
codex mcp remove codex-telegram
```

Common failures:

- **No topics in the group:** enable Topics in the private group's settings.
- **`/open` cannot create a topic:** make the bot an administrator with Manage Topics.
- **No topics in a direct bot chat:** enable Threaded Mode in BotFather; Telegram currently requires Premium for private-chat topic creation, so use the private-group setup otherwise.
- **Bot does not answer:** run `npm run doctor`, inspect `.data/relay.log`, and check the Scheduled Task.
- **Another getUpdates request is active:** stop the duplicate relay.
- **Bot ignores messages:** verify both `TELEGRAM_CHAT_ID` and `TELEGRAM_USER_ID` with `npm run discover`.
- **`/chats` is empty:** first bind the correct folder; matching uses the recorded absolute `cwd`.
- **Codex returns 429 / Too Many Requests:** the upstream Codex request was throttled after its internal retries. This alone does not prove the subscription allowance is exhausted. Check usage, wait before retrying, and inspect model/login/proxy settings if it persists. The relay reports this separately and does not replay the task automatically.
- **Already has an active writer:** stop or leave the same saved conversation in the other client before continuing in Telegram, or use `/new` for an independent conversation without the old chat history.
- **Attach/resume fails:** the saved thread may have been archived/deleted; use `/new` or choose another `/chats` entry.
- **MCP tools missing:** restart the local client and check `codex mcp list` plus the client's MCP settings.
- **A Telegram-originated file tool call stalls before upload starts:** update/restart the MCP server so explicit-topic deliveries use the direct upload path introduced in version 2.3.2.
- **Local notifications go to General:** reinstall `./scripts/install-skill.ps1`, restart Codex, and make sure the tool call includes the current absolute `project_path`.
- **Question times out:** reply directly to the ForceReply inside the same topic while the relay is running.
- **A reply says it was not forwarded:** you replied to a one-way notification. Ask the initiating Codex task to use `telegram_ask`, or send a new non-reply message to intentionally use the topic's separate local chat.
- **App Server method error:** update the Codex CLI, run `codex app-server --help`, then restart the relay.

## Rebuild contract for a future Codex

To reconstruct this system from scratch, preserve these invariants:

1. Keep it local, personal, and single-user; authorize one exact Telegram chat ID and one exact Telegram sender ID.
2. Use a private forum group with only the user and bot as the default free setup. Direct-bot Threaded Mode is an optional Telegram Premium alternative. Treat `(chat_id, message_thread_id or General)` as the conversation key.
3. Persist, atomically and locally, a mapping from that key to a Codex `threadId` and absolute project `cwd`.
4. Use one Telegram `getUpdates` long poller with a monotonically increasing offset. Pass `message_thread_id` to every topic-bound send/action.
5. Use `codex app-server --stdio`, perform `initialize`/`initialized`, then use `thread/list`, `thread/start`, `thread/resume`, `turn/start`, and `turn/interrupt`.
6. List all relevant source kinds (`cli`, `vscode`, `exec`, `appServer`) so chats created from either side can be attached.
7. Start turns with the mapped `cwd`, explicit approval policy, and configured sandbox. Stream notifications and return the final `agentMessage` after `turn/completed`.
8. Provide `/projects`, `/project`, `/unproject`, `/new`, `/chats`, `/attach`, `/open`, `/status`, `/cancel`, and `/help` with topic-local semantics.
9. Expose stdio MCP tools `telegram_notify`, `telegram_ask`, and `telegram_send_file`. Prefer the active Telegram topic, then an exact known thread mapping, then a dedicated topic keyed by the local absolute project path; use General only when no routing context exists. Restrict file uploads to regular, non-sensitive files inside the routed project, and give each upload a cancellable timeout plus bounded transient retries.
10. Keep exactly one Telegram poller. Route reply-waiting MCP calls through an authenticated loopback-only relay.
11. Split outgoing text to Telegram's 4096-character limit and correlate ForceReply answers by message ID.
12. Keep secrets and runtime state ignored, pin dependencies, provide `npm ci`, offline tests, doctor checks, and a per-user startup mechanism.
13. Keep the distinction between local App Server threads, Codex Remote tasks, and cloud ChatGPT Projects truthful. Do not claim that an arbitrary Telegram reply can be injected into Remote.
14. Run offline checks, a real App Server start/list/turn test, a real Telegram topic round trip, and MCP notify/ask/file tests before committing and pushing.
15. Bundle and install a small auto-discovered Codex skill that passes `project_path` on locally initiated calls, never guesses `thread_id`, uses `telegram_ask` whenever a reply may be needed, treats `telegram_notify` as strictly one-way, and never sends secrets.

Official references:

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Codex Remote](https://learn.chatgpt.com/docs/remote)
- [OpenAI projects and chats](https://learn.chatgpt.com/docs/projects)
- [Telegram forum topics](https://core.telegram.org/api/forum)
- [Telegram Bot API forum topics](https://core.telegram.org/bots/api#createforumtopic)

## Local macOS trial (2026-10-20)

This checkout has local compatibility changes: tests isolate CODEX_SANDBOX from
Codex-host environment variables and respect path case sensitivity on macOS.
`CODEX_MODEL` can select a CLI-compatible model; otherwise the advertised CLI
default is used for both new and resumed chats. Desktop-specific model aliases
are not assumed to be supported by CLI ChatGPT authentication.

The trial uses a dedicated launchd service, a local Clash proxy, workspace-write
sandboxing, and a wrapper that enables sandboxed shell tools, apps, plugins,
configured MCP servers, browser use, and computer control. Hooks and subagents
remain disabled. Browser, plugin, MCP, and computer-control actions have their
own account, site, application, and macOS permission boundaries; they are not
made safe solely by the filesystem sandbox.
Telegram credentials are entered locally through a hidden-input helper and a
one-time group pairing code. No token belongs in chat, logs, or Git.

The macOS trial service can be restarted after `npm run check` with
`launchctl kickstart -k gui/$(id -u)/com.codex.telegram.trial`.
Project discovery only reads local App Server history; selecting a number uses
the same directory validation and sandbox configuration as selecting a path.
It does not change sender/chat authorization, the trial wrapper, or permissions.

The old-machine migration checklist is a local-only inventory, excluded from
publication. For a new Mac with an independent bot, use
[INSTALL_MACOS.md](INSTALL_MACOS.md) and [DEPLOY_WITH_CODEX.md](DEPLOY_WITH_CODEX.md).
