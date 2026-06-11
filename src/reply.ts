/**
 * WeChat reply helpers — send text and media messages to a WeChat user.
 *
 * Extracted from dispatch.ts to break the circular dependency with media/inbox.ts.
 */

import { createLogger } from "./logger.js";
import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import { uploadAndBuildMediaItems } from "./media/upload.js";

const log = createLogger("reply");

let sendChain = Promise.resolve();

export async function sendTextReply(toUserId: string, text: string, contextToken?: string): Promise<void> {
  if (!text) return;
  const done = sendChain
    .then(async () => {
      await getWechatClient().sendMessage(toUserId, [{ type: 1, text_item: { text } }], contextToken);
      const trimPreview = text.replaceAll(/\s+/g, " ").trim();
      const preview = trimPreview.length > 30 ? trimPreview.slice(0, 30) + "…" : trimPreview;
      log.debug("Replied text (%d chars) to %s: %s", text.length, toUserId, preview);
    })
    .catch((err: unknown) => {
      log.error("Reply failed: %s", (err as Error).message);
    });
  sendChain = done;
  return done;
}

export async function sendMediaReply(toUserId: string, filePath: string, contextToken?: string): Promise<void> {
  const config = loadConfig();
  const client = getWechatClient();
  const result = await uploadAndBuildMediaItems(filePath, toUserId, config.cdnBaseUrl);

  for (const item of result.items) {
    await client.sendMessage(toUserId, [item], contextToken);
  }
}
