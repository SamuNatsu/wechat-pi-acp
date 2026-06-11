/**
 * ACP agent — lifecycle management and child-process bridge.
 *
 * Merges client.ts (process + NDJSON bridge) and lifecycle.ts (session management).
 * Only one agent process runs at a time. User-switching kills the current process.
 */

import type { Agent, Client } from "@agentclientprotocol/sdk";
import { type ChildProcess, spawn } from "node:child_process";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createHandlerFactory, createTextCollector } from "./handler.js";
import { getSession, setSession, touchSession } from "./session.js";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { VERSION } from "../version.js";
import { loadConfig } from "../config.js";
import { mkdirSync } from "node:fs";

// ---- process state ----

let proc: ChildProcess | null = null;
let conn: ClientSideConnection | null = null;
let promptRejector: ((err: Error) => void) | null = null;

// ---- lifecycle state ----

let currentUserId: string | null = null;
let currentCollector: ReturnType<typeof createTextCollector> | null = null;

/** Users whose ACP session was freshly created (not resumed) — triggers system prompt injection. */
const freshSessionUsers = new Set<string>();

export function isSessionFresh(userId: string): boolean {
  return freshSessionUsers.has(userId);
}

export function markSessionUsed(userId: string): void {
  freshSessionUsers.delete(userId);
}

// ---- process API ----

export function getConnection(): ClientSideConnection | null {
  return conn;
}

export function getProcess(): ChildProcess | null {
  return proc;
}

export function isRunning(): boolean {
  return proc !== null && !proc.killed;
}

export function setPromptRejector(r: (err: Error) => void): void {
  promptRejector = r;
}

export function clearPromptRejector(): void {
  promptRejector = null;
}

export function killAgent(): void {
  if (proc && !proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {}
    const p = proc;
    setTimeout(() => {
      try {
        if (p && !p.killed) p.kill("SIGKILL");
      } catch {}
    }, 5000);
  }
  if (promptRejector) {
    promptRejector(new Error("Agent was killed"));
    promptRejector = null;
  }
  proc = null;
  conn = null;
}

export function spawnAndConnect(acpCommand: string, cwd: string, handlerFactory: (agent: Agent) => Client): void {
  killAgent();

  console.log(`[acp] Spawning: ${acpCommand}`);
  const parts = acpCommand.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  proc = spawn(cmd, args, {
    cwd: cwd || ".",
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  proc.on("exit", (code: number | null) => {
    console.log(`[acp] Agent process exited with code ${code}`);
    if (promptRejector) {
      promptRejector(new Error(`Agent process exited with code ${code}`));
      promptRejector = null;
    }
    proc = null;
    conn = null;
  });

  proc.on("error", (err: Error) => {
    console.error(`[acp] Agent spawn error: ${err.message}`);
    if (promptRejector) {
      promptRejector(new Error(`Agent process error: ${err.message}`));
      promptRejector = null;
    }
    proc = null;
    conn = null;
  });

  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        if (proc && !proc.killed && proc.stdin) {
          proc.stdin.write(chunk);
        }
      },
      close() {
        if (proc && !proc.killed && proc.stdin) {
          proc.stdin.end();
        }
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (!proc || !proc.stdout) return;
        proc.stdout.on("data", (data: Buffer) => {
          try {
            controller.enqueue(new Uint8Array(data));
          } catch {}
        });
        proc.stdout.on("close", () => {
          try {
            controller.close();
          } catch {}
        });
        proc.stdout.on("error", () => {
          try {
            controller.close();
          } catch {}
        });
      },
    }),
  );

  conn = new ClientSideConnection(handlerFactory, stream);
}

// ---- lifecycle API ----

export function getCurrentCollector(): ReturnType<typeof createTextCollector> | null {
  return currentCollector;
}

export function resetSessionState(): void {
  currentUserId = null;
  currentCollector = null;
}

export async function ensureAgentRunning(userId: string, cwd: string): Promise<void> {
  const config = loadConfig();

  if (currentUserId === userId && isRunning()) {
    touchSession(userId);
    return;
  }

  if (currentUserId && currentUserId !== userId && isRunning()) {
    console.log(`[agent] Closing agent for ${currentUserId}, switching to ${userId}`);
    killAgent();
    currentUserId = null;
    currentCollector = null;
  }

  const session = getSession(userId);

  const collector = createTextCollector();
  const handlerFactory = createHandlerFactory(
    (update) => collector.onUpdate(update),
    () => ({ outcome: "approved" }) as unknown as RequestPermissionResponse,
    cwd,
  );

  currentCollector = collector;
  currentUserId = userId;

  mkdirSync(cwd, { recursive: true });

  console.log(`[agent] Connecting ACP agent for user ${userId} (cwd=${cwd})...`);
  spawnAndConnect(config.acpCommand, cwd, handlerFactory);

  if (!isRunning()) throw new Error("Agent process failed to start");

  const connection = getConnection();
  if (!connection) throw new Error("Failed to connect to ACP agent");

  const initResp = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "wechat-pi-acp", title: "WeChat ACP Bridge", version: VERSION },
  });
  console.log(`[agent] ACP initialized: ${initResp.agentInfo?.name} v${initResp.agentInfo?.version}`);

  let sessionId: string;
  let createdNew = false;

  if (session?.sessionId) {
    console.log(`[agent] Resuming session ${session.sessionId}...`);
    try {
      await connection.loadSession({ sessionId: session.sessionId, cwd, mcpServers: [] });
      sessionId = session.sessionId;
      collector.reset();
      console.log(`[agent] Session resumed.`);
    } catch (err) {
      console.log(`[agent] loadSession failed: ${(err as Error).message}, creating new session.`);
      const created = await connection.newSession({ cwd, mcpServers: [] });
      sessionId = created.sessionId;
      collector.reset();
      createdNew = true;
    }
  } else {
    const created = await connection.newSession({ cwd, mcpServers: [] });
    sessionId = created.sessionId;
    collector.reset();
    createdNew = true;
  }

  if (createdNew) {
    freshSessionUsers.add(userId);
  } else {
    freshSessionUsers.delete(userId);
  }

  setSession(userId, { sessionId });
  touchSession(userId);
  console.log(`[agent] Agent ready for ${userId}, session=${sessionId}`);
}
