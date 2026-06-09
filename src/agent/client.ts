/**
 * ACP agent child-process management.
 *
 * Spawns the agent command (default: `npx pi-acp`) as a child process,
 * wires stdio to an NDJSON stream via the ACP SDK, and exposes
 * connection state to the rest of the app.
 */

import type { Agent, Client } from "@agentclientprotocol/sdk";
import { type ChildProcess, spawn } from "node:child_process";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

/** Currently running agent child process (null when idle). */
let proc: ChildProcess | null = null;
/** ACP SDK ClientSideConnection instance (null when idle). */
let conn: ClientSideConnection | null = null;
/** Rejector for the currently pending prompt (null when no prompt in-flight). */
let promptRejector: ((err: Error) => void) | null = null;

/** Get the current ACP SDK connection (used by dispatch and lifecycle). */
export function getConnection(): ClientSideConnection | null {
  return conn;
}

/** Get the raw child process handle (for lifecycle checks). */
export function getProcess(): ChildProcess | null {
  return proc;
}

/** Whether the agent process is currently alive. */
export function isRunning(): boolean {
  return proc !== null && !proc.killed;
}

/** Register a rejector for the current prompt — called by dispatch before conn.prompt(). */
export function setPromptRejector(r: (err: Error) => void): void {
  promptRejector = r;
}

/** Clear the prompt rejector — called by dispatch after conn.prompt() completes. */
export function clearPromptRejector(): void {
  promptRejector = null;
}

/**
 * Kill the agent process — SIGTERM first, then SIGKILL after 5s grace period.
 * Clears both the process handle and the connection reference.
 */
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

/**
 * Spawn the ACP agent command and wire it up via NDJSON stdio bridge.
 * Kills any existing agent first, then creates the SDK stream and connection.
 * Sets the module-level conn and proc variables.
 */
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

  // Bridge child-process stdio to an NDJSON stream
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
