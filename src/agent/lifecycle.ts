/**
 * Agent lifecycle management — the bridge between dispatch and the ACP child process.
 *
 * Responsibilities:
 *   - Statically import the ACP SDK (kept external by tsdown's neverBundle)
 *   - Spawn / reconnect the agent process via client.ts
 *   - Handle user-switching: kill the old agent when a new user sends a message
 *   - Resume existing sessions via loadSession() or create new ones via newSession()
 *
 * Only one agent runs at a time. Switching users kills the current process
 * and starts a fresh one. The text collector is reset on each prompt cycle.
 */

import { createHandlerFactory, createTextCollector } from "./handler.js";
import { getConnection, isRunning, killAgent, spawnAndConnect } from "./client.js";
import { getSession, setSession, touchSession } from "./session.js";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { VERSION } from "../version.js";
import { loadConfig } from "../config.js";
import { mkdirSync } from "node:fs";

/** The user ID currently bound to the running agent process. */
let currentUserId: string | null = null;
/** The text collector for the current prompt cycle — reset before each prompt. */
let currentCollector: ReturnType<typeof createTextCollector> | null = null;

/** Expose the current text collector so dispatch.ts can read agent replies. */
export function getCurrentCollector(): ReturnType<typeof createTextCollector> | null {
  return currentCollector;
}

/** Clear user-scoped state — called on /new and on user-switch. */
export function resetSessionState(): void {
  currentUserId = null;
  currentCollector = null;
}

/**
 * Ensure the ACP agent is running for the given user.
 *
 * The agent's working directory is fixed to the user's inbox directory
 * so that downloaded media files are directly accessible to the agent.
 *
 * Three cases:
 *   1. Same user, still running → touch the session timestamp and return.
 *   2. Different user, process alive → kill it, then spawn for the new user.
 *   3. No process or first call → spawn a new one, initialize, and load/create session.
 */
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

  // Build the handler factory with a text collector that accumulates agent output.
  // Permissions are always auto-approved.
  const collector = createTextCollector();
  const handlerFactory = createHandlerFactory(
    (update) => collector.onUpdate(update),
    () => ({ outcome: "approved" }) as unknown as RequestPermissionResponse,
    cwd,
  );

  currentCollector = collector;
  currentUserId = userId;

  // Ensure the inbox directory exists before spawning the agent
  mkdirSync(cwd, { recursive: true });

  console.log(`[agent] Connecting ACP agent for user ${userId} (cwd=${cwd})...`);
  spawnAndConnect(config.acpCommand, cwd, handlerFactory);

  if (!isRunning()) throw new Error("Agent process failed to start");

  const conn = getConnection();
  if (!conn) throw new Error("Failed to connect to ACP agent");

  // Initialize the ACP protocol handshake
  const initResp = await conn.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "wechat-pi-acp", title: "WeChat ACP Bridge", version: VERSION },
  });
  console.log(`[agent] ACP initialized: ${initResp.agentInfo?.name} v${initResp.agentInfo?.version}`);

  let sessionId: string;

  if (session?.sessionId) {
    // Resume an existing ACP session
    console.log(`[agent] Resuming session ${session.sessionId}...`);
    try {
      await conn.loadSession({ sessionId: session.sessionId, cwd, mcpServers: [] });
      sessionId = session.sessionId;
      collector.reset();
      console.log(`[agent] Session resumed.`);
    } catch (err) {
      console.log(`[agent] loadSession failed: ${(err as Error).message}, creating new session.`);
      const created = await conn.newSession({ cwd, mcpServers: [] });
      sessionId = created.sessionId;
      collector.reset();
    }
  } else {
    // No prior session — create a fresh one
    const created = await conn.newSession({ cwd, mcpServers: [] });
    sessionId = created.sessionId;
    // Discard any intro text the agent sent during session setup
    collector.reset();
  }

  setSession(userId, { sessionId });
  touchSession(userId);
  console.log(`[agent] Agent ready for ${userId}, session=${sessionId}`);
}
