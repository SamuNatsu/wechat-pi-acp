/**
 * Temporary file cleanup.
 *
 * Two cleanup modes:
 *   1. Per-user cleanup (cleanupUserDir) — called by /new and /file-clear
 *   2. Full cleanup (fullCleanup) — called on graceful shutdown
 */

import { createLogger } from "../logger.js";
import fs from "node:fs/promises";

const log = createLogger("cleanup");

export async function cleanupUserDir(userDir: string): Promise<void> {
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    log.info("Cleared user dir: %s", userDir);
  } catch {}
}

export async function fullCleanup(tempDir: string): Promise<void> {
  log.info("Full cleanup of temp directory...");
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {}
  log.info("Cleanup done.");
}
