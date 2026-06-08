/**
 * Long-poll message stream — the main I/O loop.
 *
 * Continuously calls getUpdates, yielding StreamEvent values for each
 * inbound message. Handles backoff, session-expired pauses, and
 * graceful shutdown via AbortSignal.
 */

import { getUpdates as apiGetUpdates } from "./api.js";
import type { StreamEvent } from "../types.js";

/** Maximum consecutive failures before entering backoff. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Backoff delay after MAX_CONSECUTIVE_FAILURES (msec). */
const BACKOFF_DELAY_MS = 30_000;
/** Short retry delay for transient errors (msec). */
const RETRY_DELAY_MS = 2_000;
/** Error code returned by the server when the session has expired. */
const SESSION_EXPIRED_ERRCODE = -14;

export { notifyStart, notifyStop } from "./api.js";
export { SESSION_EXPIRED_ERRCODE };

/**
 * Async generator that yields StreamEvent values as messages arrive.
 * On session expiry (errcode -14) it pauses for 60 minutes, then resumes.
 * On transient errors it backs off with increasing delays.
 *
 * @param baseUrl     The agent's assigned API base URL
 * @param token       The authenticated bot token
 * @param abortSignal AbortController signal for graceful shutdown
 * @param onStatus    Callback for monitoring last-event timestamps
 */
export async function* streamMessages(
  baseUrl: string,
  token: string,
  abortSignal: AbortSignal | undefined,
  onStatus: (status: { lastEventAt?: number; lastInboundAt?: number }) => void,
): AsyncGenerator<StreamEvent> {
  let buf = "";
  let nextTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await apiGetUpdates(baseUrl, token, buf, abortSignal, nextTimeoutMs);

      // Server may adjust the poll timeout dynamically
      if (resp.longpolling_timeout_ms) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        // Session expired — pause for 60 minutes, then resume polling
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          yield { type: "session-expired" };
          consecutiveFailures = 0;
          await sleep(60 * 60 * 1000, abortSignal);
          continue;
        }
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      // Success — update the cursor buffer and yield messages
      consecutiveFailures = 0;
      if (resp.get_updates_buf) buf = resp.get_updates_buf;
      onStatus?.({ lastEventAt: Date.now() });

      const msgs = resp.msgs || [];
      if (msgs.length > 0) {
        for (const msg of msgs) yield { type: "message", msg };
        onStatus?.({ lastInboundAt: Date.now(), lastEventAt: Date.now() });
      }
    } catch {
      if (abortSignal?.aborted) return;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
}

/** Abortable sleep — rejects if the signal fires before the timeout. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true },
      );
  });
}
