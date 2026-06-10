# AGENTS.md — wechat-pi-acp

## Build & Run

```bash
pnpm build          # bundle via tsdown → dist/
pnpm typecheck      # tsc --noEmit (separate from build)
pnpm start          # run built output: node dist/cli.mjs
pnpm dev            # tsx --watch (auto-rebuild + restart on source changes)
pnpm lint           # eslint src/
pnpm format         # prettier --write src/
pnpm format:check   # prettier --check src/
```

- `tsdown` is the bundler, **not `tsc`**. The build step is needed before `pnpm start`. Build cleans `dist/` first (`clean: true`).
- `@agentclientprotocol/sdk` and `qrcode-terminal` are **excluded from the bundle** (`neverBundle` in tsdown config). They must be available at runtime. `qrcode-terminal` is imported dynamically in `wechat/auth.ts`.
- Package manager is **pnpm** (lockfile: `pnpm-lock.yaml`).
- `cac` is used for CLI argument parsing (not manual `process.argv` parsing).

## Commands & Verification

- **Build, typecheck, and lint must all pass before release**: `pnpm lint && pnpm typecheck && pnpm build`
- There are **no tests** in this repo. TypeScript strict mode + ESLint are the safety nets.
- ESLint uses `typescript-eslint` recommended type-checked rules + `eslint-config-prettier`.
- Node.js **24+ required** (`package.json` engines, CI uses Node 24). Runtime guard in `cli.ts` checks 22+ — update it if bumping engines.
- CI (`publish.yml`) triggers on `v*` tags, runs `pnpm install --frozen-lockfile` then `pnpm build` then `npm publish`. CI does **not** run lint or typecheck — those are dev-only.
- Install dependencies with `pnpm install --frozen-lockfile` to match what CI does.

## Formatting & Lint Rules

- Prettier: **double quotes** (`singleQuote: false`), trailing commas all, `printWidth: 120`.
- ESLint: unused vars/args must be prefixed with `_` to suppress errors (`argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`). Imports are sorted (`sort-imports: error`).

## Version Bumping

- Version is sourced from `package.json` → `src/version.ts` → runtime. Use `npm version` to bump; the build inlines it automatically. No separate `src/version.ts` update needed.

## Config & State

| Path | Purpose |
|------|---------|
| `~/.wechat-pi-acp/config.json` | Auth token, API URLs, agent command, timeouts |
| `~/.wechat-pi-acp/sessions.json` | Per-user ACP session IDs and last-active timestamps |
| `~/.wechat-pi-acp/tokens.json` | (referenced in config.ts but not actively used yet) |
| `/tmp/wechat-pi-acp/` | Temporary media downloads |

- Config file is **chmod 0o600** on save.
- `loadConfig()` caches the config in memory after first disk read — subsequent calls are free. Use `reloadConfig()` to force a fresh disk read.
- `config.ts` also exports `loadSessions()` / `saveSessions()` for the sessions.json store.
- The ACP agent command defaults to `npx pi-acp` and runs in each user's inbox directory (`<mediaTempDir>/inbox/<user_id>/`).
- `maxFileSize` defaults to 104_857_600 (100 MB) — rejects oversized uploads/downloads.
- `idleTimeoutMs` (default 600s) in config is tracked via `lastActiveAt` timestamps but **not yet enforced** — no code kills the agent on idle. `lastActiveAt` is only used by `/status`.
- `src/state.ts` centralizes module-level mutable state (agent process, sessions, compose/upload mode, QR login). Modules import getters/setters instead of using file-scoped variables.

## Architecture

```
src/cli.ts              # entry point — cac CLI, main loop, signal handling
src/config.ts           # config I/O from ~/.wechat-pi-acp/ (+ singleton cache)
src/dispatch.ts         # message routing pipeline, command dispatch
src/commands.ts         # slash-command registry, tokenizer, built-in commands
src/reply.ts            # text + media reply helpers (extracted from dispatch)
src/state.ts            # centralized application state (modules import getters)
src/utils.ts            # shared utilities: humanizeSize, splitText, escape
src/version.ts          # single source of truth for package version
src/types.ts            # all TypeScript interfaces (single file)

src/agent/agent.ts      # unified agent lifecycle: process spawn, NDJSON bridge, sessions
src/agent/handler.ts    # ACP handler factory: sessionUpdate, read/writeTextFile, requestPermission
src/agent/session.ts    # session store backed by sessions.json

src/wechat/api.ts       # low-level HTTP wrappers (fetch + auth headers, no state)
src/wechat/client.ts    # WechatClient class — holds baseUrl + token, wraps api.ts
src/wechat/auth.ts      # QR code login flow
src/wechat/stream.ts    # long-poll message stream — uses client internally

src/media/crypto.ts     # AES-128-ECB encrypt/decrypt for CDN, random keys
src/media/download.ts   # download + decrypt WeChat CDN media
src/media/upload.ts     # encrypt + upload to WeChat CDN
src/media/cleanup.ts    # per-user and shutdown temp-file cleanup
src/media/inbox.ts      # file upload mode: intercept, conflict check, collect files
src/media/compose.ts    # message compose mode: accumulate text + files in order, send as one prompt
```

## Message Dispatch Pipeline

Each inbound message flows through `dispatch.ts` in this order (first match wins):

1. **Command intercept** — slash commands (`/new`, `/cancel`, etc.) handled locally by `commands.ts`
2. **Compose-mode bypass** — if user is in `/msg-start` mode, text/files are accumulated, not sent to agent
3. **File-upload-mode bypass** — if user is in `/file-upload-start` mode, media is downloaded and tracked
4. **Agent routing** — media is downloaded to `<inboxDir>/`, agent is started/resumed, prompt is sent

## Key Design Conventions

- **ESM only** (`"type": "module"`). All imports use `.js` extensions (Node ESM resolution).
- **`getWechatClient()` singleton** — most modules use this instead of threading `baseUrl`/`token` through function calls. Backed by `config.ts` cache.
- **`agent/agent.ts`** merges the former `client.ts` (process + NDJSON) and `lifecycle.ts` (session management). Only one agent runs at a time — switching users kills the current process.
- **All permissions auto-approved** — `handler.ts` hardcodes `{ outcome: "approved" }` for every `requestPermission` call.
- **Prompt abortion** — if the agent process exits mid-prompt, `agent.ts` rejects the pending promise so dispatch doesn't hang.
- User-facing messages are **Chinese**, log messages are **English**.
- Slash commands must start with `/` and match exactly (case-sensitive).
- `CommandContext` uses sub-interfaces: `CommandReplyOps`, `CommandSessionOps`, `CommandAgentOps`, `CommandMediaOps`.
- `WEIXIN-API.md` documents the reverse-engineered WeChat API — it is the reference for the API surface, not the source code.

## Agent Output Streaming

Text replies are **streamed in real-time** via the collector:
- Consecutive `agent_message_chunk` updates are accumulated and flushed when the update kind changes.
- `agent_thought_chunk` blocks are wrapped in `**🤔 思考：**\n\n<text>` (Markdown bold).
- Tool-call notifications emit a brief `🔧 正在使用工具：<title>` notice; raw `tool_call_update` output is suppressed.
- Message chunks before the first thought are suppressed.

## Non-Obvious Conventions

- Temp media files are stored under `<mediaTempDir>/inbox/<sanitized_user_id>/` (where sanitize = `replace(/[@.]/g, "_")`) and cleaned per-user on `/new` and `/file-clear`.
- The agent's working directory is **fixed to the user's inbox directory** — downloaded media is directly accessible to the agent. `handler.ts` validates that all file I/O paths stay within this workspace.
- `pnpm-workspace.yaml` exists but this is **not a monorepo** — it only contains `allowBuilds` flags for transitive native deps.
- `@tencent-weixin/openclaw-weixin` in `devDependencies` is the upstream WeChat Bot HTTP client used as reference. It is **not imported** — it only provides type stubs and serves as the source for `WEIXIN-API.md`.
- `/think` sets agent session mode via `setSessionMode()` — valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `/file-send` is restricted to files within the inbox directory — absolute paths outside it are rejected.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--login` | Force QR re-login (even if saved token exists) |
| `--verbose` | Enable verbose logging |
| `-v, --version` | Show version |
| `-h, --help` | Show help |
