/**
 * Temporary file cleanup.
 *
 * Two cleanup modes:
 *   1. Per-user cleanup (cleanupUserDir) — called by /new and /file-clear
 *   2. Periodic purge (startPeriodicCleanup) — runs every 30min, removes
 *      files older than fileTtlMs (default: 1 hour)
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Interval between periodic stale-file purges (30 minutes). */
const PURGE_INTERVAL_MS = 30 * 60_000;

let purgeTimer: ReturnType<typeof setInterval> | null = null;

/** Recursively delete a user's temp inbox directory. */
export async function cleanupUserDir(userDir: string): Promise<void> {
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    console.log(`[cleanup] Cleared user dir: ${userDir}`);
  } catch {}
}

/**
 * Start a periodic timer that purges files older than ttlMs from tempDir.
 * The timer is unref'd so it doesn't keep the process alive.
 * Only one timer runs at a time — calling this again clears the previous one.
 */
export function startPeriodicCleanup(tempDir: string, ttlMs: number): void {
  if (purgeTimer) clearInterval(purgeTimer);

  const purge = async () => {
    try {
      const entries = await fs.readdir(tempDir).catch(() => []);
      const now = Date.now();
      for (const entry of entries) {
        const p = path.join(tempDir, entry);
        try {
          const stat = await fs.stat(p);
          if (now - stat.mtimeMs > ttlMs) {
            await fs.rm(p, { recursive: true, force: true });
            console.log(`[cleanup] Purged stale: ${p}`);
          }
        } catch {}
      }
    } catch {}
  };

  purgeTimer = setInterval(() => {
    void purge();
  }, PURGE_INTERVAL_MS);

  purgeTimer.unref();
}

/** Stop the periodic cleanup timer (called on shutdown). */
export function stopPeriodicCleanup(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

/** Recursively delete the entire temp directory — called on graceful shutdown. */
export async function fullCleanup(tempDir: string): Promise<void> {
  console.log("[cleanup] Full cleanup of temp directory...");
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {}
  console.log("[cleanup] Done.");
}
