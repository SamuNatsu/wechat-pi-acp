/**
 * WeChat reply helpers — send text and media messages to a WeChat user.
 *
 * All sends flow through a sequential chain with a minimum inter-message
 * interval to respect WeChat's rate limit (~7 msgs / 5 min per user).
 * Failed sends are retried with exponential backoff.
 */

import type { SendResult, WechatMessageItem } from "./types.js";
import { createLogger } from "./logger.js";
import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import { uploadAndBuildMediaItems } from "./media/upload.js";

const log = createLogger("reply");

/** Minimum interval between sequential sendMessage calls (ms). */
const MIN_SEND_INTERVAL_MS = 5000;
/** Maximum retry attempts per send (0-based: 0..MAX_RETRIES). */
const MAX_RETRIES = 5;
/** Base backoff delay for retries (ms). */
const RETRY_BASE_DELAY_MS = 2000;
/** Send-count threshold before rate-limit notice is triggered. */
const RATE_LIMIT_THRESHOLD = 6;

let sendChain = Promise.resolve();
let lastSendTime = 0;

/** Messages sent since the last user message. */
let sendCount = 0;
/** Whether the rate-limit notice has been sent in this window. */
let limitNoticeSent = false;
/** Resolver to awake paused sends when the counter is reset. */
let resetResolver: (() => void) | null = null;

const RATE_LIMIT_NOTICE: WechatMessageItem = {
  type: 1,
  text_item: { text: "⚠️ 已达到发送限制，请发送 `//` 刷新令牌后继续。" },
};

export function resetSendCount(): void {
  sendCount = 0;
  limitNoticeSent = false;
  if (resetResolver) {
    resetResolver();
    resetResolver = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(toUserId: string, items: WechatMessageItem[], contextToken?: string): Promise<SendResult> {
  if (sendCount >= RATE_LIMIT_THRESHOLD && limitNoticeSent) {
    log.debug("Send paused — waiting for rate-limit reset");
    await new Promise<void>((resolve) => {
      resetResolver = resolve;
    });
    log.debug("Send resumed — rate-limit reset");
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await getWechatClient().sendMessage(toUserId, items, contextToken);
      sendCount++;

      if (sendCount >= RATE_LIMIT_THRESHOLD && !limitNoticeSent) {
        try {
          await getWechatClient().sendMessage(toUserId, [RATE_LIMIT_NOTICE], contextToken);
          sendCount++;
          limitNoticeSent = true;
        } catch {
          log.warn("Rate-limit notice failed to send");
        }
      }

      return result;
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_BASE_DELAY_MS * 2 ** attempt;
        log.warn(
          "Send failed (attempt %d/%d), retrying in %dms: %s",
          attempt + 1,
          MAX_RETRIES,
          wait,
          lastError.message,
        );
        await delay(wait);
      }
    }
  }
  throw lastError!;
}

/**
 * Enqueue a send operation into the sequential chain.
 * The chain enforces MIN_SEND_INTERVAL_MS between consecutive sends
 * to avoid hitting WeChat's rate limit.
 */
function enqueue(fn: () => Promise<void>): Promise<void> {
  const done = sendChain.then(async () => {
    const remaining = MIN_SEND_INTERVAL_MS - (Date.now() - lastSendTime);
    if (remaining > 0) await delay(remaining);
    await fn();
    lastSendTime = Date.now();
  });
  sendChain = done.catch(() => {});
  return done;
}

export async function sendTextReply(toUserId: string, text: string, contextToken?: string): Promise<void> {
  if (!text) return;
  return enqueue(async () => {
    await sendWithRetry(toUserId, [{ type: 1, text_item: { text } }], contextToken);
    const trimPreview = text.replaceAll(/\s+/g, " ").trim();
    const preview = trimPreview.length > 30 ? trimPreview.slice(0, 30) + "…" : trimPreview;
    log.debug("Replied text (%d chars) to %s: %s", text.length, toUserId, preview);
  }).catch((err: unknown) => {
    log.warn("Text reply dropped: %s", (err as Error).message);
  });
}

export async function sendMediaReply(toUserId: string, filePath: string, contextToken?: string): Promise<void> {
  const config = loadConfig();
  const result = await uploadAndBuildMediaItems(filePath, toUserId, config.cdnBaseUrl);

  for (const item of result.items) {
    await enqueue(async () => {
      await sendWithRetry(toUserId, [item], contextToken);
    }).catch((err: unknown) => {
      log.warn("Media reply dropped: %s", (err as Error).message);
    });
  }
}
