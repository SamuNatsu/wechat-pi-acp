/**
 * Temporary file cleanup.
 *
 * Two cleanup modes:
 *   1. Per-user cleanup (cleanupUserDir) — called by /new and /file-clear
 *   2. Full cleanup (fullCleanup) — called on graceful shutdown
 */

import fs from "node:fs/promises";

/** Recursively delete a user's temp inbox directory. */
export async function cleanupUserDir(userDir: string): Promise<void> {
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    console.log(`[cleanup] Cleared user dir: ${userDir}`);
  } catch {}
}

/** Recursively delete the entire temp directory — called on graceful shutdown. */
export async function fullCleanup(tempDir: string): Promise<void> {
  console.log("[cleanup] Full cleanup of temp directory...");
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {}
  console.log("[cleanup] Done.");
}
