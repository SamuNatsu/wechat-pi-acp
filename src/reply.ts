/**
 * WeChat reply helpers — send text and media messages to a WeChat user.
 *
 * Extracted from dispatch.ts to break the circular dependency with media/inbox.ts.
 */

import type { SendResult, WechatMessageItem } from "./types.js";
import { createLogger } from "./logger.js";
import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import { uploadAndBuildMediaItems } from "./media/upload.js";

const log = createLogger("reply");

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

let sendChain = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(
  toUserId: string,
  items: WechatMessageItem[],
  contextToken?: string,
): Promise<SendResult> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await getWechatClient().sendMessage(toUserId, items, contextToken);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_BASE_DELAY_MS * 2 ** attempt;
        log.warn("Send failed (attempt %d/%d), retrying in %dms: %s", attempt + 1, MAX_RETRIES, wait, lastError.message);
        await delay(wait);
      }
    }
  }
  throw lastError!;
}

export async function sendTextReply(toUserId: string, text: string, contextToken?: string): Promise<void> {
  if (!text) return;
  const done = sendChain
    .then(async () => {
      await sendWithRetry(toUserId, [{ type: 1, text_item: { text } }], contextToken);
      const trimPreview = text.replaceAll(/\s+/g, " ").trim();
      const preview = trimPreview.length > 30 ? trimPreview.slice(0, 30) + "…" : trimPreview;
      log.debug("Replied text (%d chars) to %s: %s", text.length, toUserId, preview);
    })
    .catch((err: unknown) => {
      log.error("Reply failed after %d retries: %s", MAX_RETRIES, (err as Error).message);
    });
  sendChain = done;
  return done;
}

export async function sendMediaReply(toUserId: string, filePath: string, contextToken?: string): Promise<void> {
  const config = loadConfig();
  const result = await uploadAndBuildMediaItems(filePath, toUserId, config.cdnBaseUrl);

  for (const item of result.items) {
    await sendWithRetry(toUserId, [item], contextToken);
  }
}
