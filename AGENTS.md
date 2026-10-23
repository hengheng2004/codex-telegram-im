# Project instructions

`README.md` is the source of truth for this personal bridge. Keep implementation, commands, security defaults, and rebuild instructions consistent with it. Keep the project small: one Telegram user, one local relay, and one local MCP server. Never commit `.env`, bot tokens, chat IDs, Codex auth, or `.data` state.

Before committing, run `npm run check`. When behavior or installation changes, update `README.md` in the same commit.

For a fresh deployment on another Mac, read `DEPLOY_WITH_CODEX.md` and
`INSTALL_MACOS.md`. Detect paths on that Mac; use its own bot and private group.
Never request bot tokens in chat or reuse old-machine state for an independent
bot. Use `scripts/package-release.py` for a source-only distribution; the local
`MIGRATION_CHECKLIST.md` is not a publication artifact.
