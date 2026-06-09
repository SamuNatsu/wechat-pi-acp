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
- `@agentclientprotocol/sdk` and `qrcode-terminal` are **excluded from the bundle** (`neverBundle` in tsdown config). They must be available at runtime. Static top-level imports of the ACP SDK are fine — tsdown preserves them as externals. `qrcode-terminal` is still imported dynamically in `wechat/auth.ts`.
- Package manager is **pnpm** (lockfile: `pnpm-lock.yaml`).
- `cac` is used for CLI argument parsing (not manual `process.argv` parsing).

## Commands & Verification

- **Build, typecheck, and lint must all pass before release**: `pnpm lint && pnpm typecheck && pnpm build`
- There are **no tests** in this repo. TypeScript strict mode + ESLint are the safety nets.
- ESLint uses `typescript-eslint` recommended type-checked rules + `eslint-config-prettier`.
- Node.js **22+ required** — enforced at runtime in `cli.ts`.
- CI (`publish.yml`) triggers on `v*` tags, runs `pnpm build` then `npm publish` with Node 24.

## Formatting & Lint Rules

- Prettier: **double quotes** (`singleQuote: false`), trailing commas all, `printWidth: 120`.
- ESLint: unused vars/args must be prefixed with `_` to suppress errors (`argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`).

## Version Bumping

- Version is sourced from `package.json` → `src/version.ts` → runtime. Use `npm version` to bump; the build inlines it automatically. No separate `src/version.ts` update needed.

## Config & State

| Path | Purpose |
|------|---------|
| `~/.wechat-pi-acp/config.json` | Auth token, API URLs, agent command, timeouts |
| `~/.wechat-pi-acp/sessions.json` | Per-user ACP session IDs and last-active timestamps |
| `~/.wechat-pi-acp/tokens.json` | (referenced in config.ts but not actively used yet) |
| `/tmp/wechat-pi-acp/` | Temporary media downloads (TTL: 1h, purged every 30min) |

- Config file is **chmod 0o600** on save.
- The ACP agent command defaults to `npx pi-acp` and runs in each user's inbox directory (`<mediaTempDir>/inbox/<user_id>/`).

## Architecture

```
src/cli.ts              # entry point — cac CLI, main loop, signal handling
src/config.ts           # config I/O from ~/.wechat-pi-acp/
src/dispatch.ts         # message routing, command dispatch, reply helpers
src/commands.ts         # slash-command registry, tokenizer, built-in commands
src/utils.ts            # shared utilities: humanizeSize, splitText, escape
src/version.ts          # single source of truth for package version
src/types.ts            # all TypeScript interfaces (single file, no barrel)

src/agent/lifecycle.ts  # ACP agent lifecycle: spawn, session resume/new, user switching
src/agent/client.ts     # spawn ACP agent child process, NDJSON stdio bridge
src/agent/handler.ts    # ACP handler factory: sessionUpdate, read/writeTextFile, requestPermission
src/agent/session.ts    # session store backed by sessions.json

src/wechat/api.ts       # WeChat HTTP API client (login, messaging, CDN uploads)
src/wechat/auth.ts      # QR code login flow
src/wechat/stream.ts    # long-poll message stream via getUpdates

src/media/crypto.ts     # AES-128-ECB encrypt/decrypt for CDN, random keys
src/media/download.ts   # download + decrypt WeChat CDN media
src/media/upload.ts     # encrypt + upload to WeChat CDN
src/media/cleanup.ts    # periodic temp-file cleanup
src/media/inbox.ts      # file upload mode: intercept, conflict check, collect files
src/media/compose.ts    # message compose mode: accumulate text + files in order, send as one prompt
```

## Non-Obvious Conventions

- **ESM only** (`"type": "module"`). All imports use `.js` extensions (Node ESM resolution).
- The ACP SDK is **statically imported** (`import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"`) in `src/agent/lifecycle.ts` and `src/agent/client.ts`. SDK types (Agent, Client, SessionUpdate, etc.) are imported from the same package in `handler.ts`, `commands.ts`, and `dispatch.ts`.
- User-facing messages are **Chinese**, log messages are **English**.
- Slash commands must start with `/` and match exactly (case-sensitive).
- The agent runs as a **single child process**, shared across users with session isolation via `loadSession`/`newSession`. Only one agent runs at a time — switching users kills the current agent.
- `WEIXIN-API.md` documents the reverse-engineered WeChat API — it is the reference for the API surface, not the source code.
- Text replies are **streamed in real-time** via the collector: consecutive `agent_message_chunk` updates are accumulated and flushed when the update kind changes (e.g. agent starts thinking). `agent_thought_chunk` blocks are wrapped in fenced code blocks (`🤔 思考`). Tool-call notifications emit a brief `🔧 <title>` notice; raw `tool_call_update` output is suppressed.
- Temp media files are stored under `<mediaTempDir>/inbox/<sanitized_user_id>/` and cleaned per-user on `/new` and `/file-clear`.
- The agent's working directory is **fixed to the user's inbox directory** — downloaded media is directly accessible to the agent.
- `pnpm-workspace.yaml` exists but this is **not a monorepo** — it only contains `allowBuilds` flags for transitive native deps.
- `@tencent-weixin/openclaw-weixin` in `devDependencies` is the upstream WeChat Bot HTTP client used as reference. It is **not imported** — it only provides type stubs and serves as the source for `WEIXIN-API.md`.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--login` | Force QR re-login (even if saved token exists) |
| `--verbose` | Enable verbose logging |
| `-v, --version` | Show version |
| `-h, --help` | Show help |
