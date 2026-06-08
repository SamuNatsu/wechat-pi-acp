/**
 * In-memory session store backed by ~/.wechat-pi-acp/sessions.json.
 *
 * Sessions are loaded once on startup and persisted on every mutation.
 * A setImmediate-based debounce batches rapid writes into a single disk flush.
 */

import { loadSessions, saveSessions } from "../config.js";
import type { SessionData } from "../types.js";

/** The live in-memory session map, seeded from disk on import. */
const SESSION_STORE: Record<string, Record<string, unknown>> = loadSessions();
let savePending = false;

/** Debounce disk writes — coalesces rapid setSession calls. */
function scheduleSave(): void {
  if (savePending) return;
  savePending = true;
  setImmediate(() => {
    saveSessions(SESSION_STORE);
    savePending = false;
  });
}

/** Fetch the session data for a given user. Returns null if not found. */
export function getSession(userId: string): SessionData | null {
  const entry = SESSION_STORE[userId];
  if (!entry) return null;
  return entry;
}

/** Merge partial session data into the store and persist. */
export function setSession(userId: string, data: Partial<SessionData>): void {
  SESSION_STORE[userId] = {
    ...(SESSION_STORE[userId] || {}),
    ...data,
    lastActiveAt: Date.now(),
  };
  scheduleSave();
}

/** Remove a user's session entry and persist. */
export function deleteSession(userId: string): void {
  delete SESSION_STORE[userId];
  scheduleSave();
}

/** Update the lastActiveAt timestamp without mutating other fields. */
export function touchSession(userId: string): void {
  if (SESSION_STORE[userId]) {
    SESSION_STORE[userId].lastActiveAt = Date.now();
    scheduleSave();
  }
}

/** Return a shallow copy of all sessions (used for introspection). */
export function allSessions(): Record<string, Record<string, unknown>> {
  return { ...SESSION_STORE };
}
