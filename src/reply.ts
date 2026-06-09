/**
 * WeChat reply helpers — send text and media messages to a WeChat user.
 *
 * Extracted from dispatch.ts to break the circular dependency with media/inbox.ts.
 */

import { getWechatClient } from "./wechat/client.js";
import { loadConfig } from "./config.js";
import { uploadAndBuildMediaItems } from "./media/upload.js";

/**
 * Send a plain-text WeChat message.
 */
export async function sendTextReply(toUserId: string, text: string, contextToken?: string): Promise<void> {
  if (!text) return;
  try {
    await getWechatClient().sendMessage(toUserId, [{ type: 1, text_item: { text } }], contextToken);
    const preview = text.length > 30 ? text.slice(0, 30) + "…" : text;
    console.log(`[reply] Replied text (${text.length} chars) to ${toUserId}:${preview}`);
  } catch (err) {
    console.error(`[reply] Reply failed: ${(err as Error).message}`);
  }
}

/**
 * Upload a local file to WeChat CDN and send it as a media message.
 * An optional caption is sent as a separate text message before the file.
 */
export async function sendMediaReply(
  toUserId: string,
  filePath: string,
  contextToken?: string,
  caption?: string,
): Promise<void> {
  const config = loadConfig();
  const client = getWechatClient();
  const result = await uploadAndBuildMediaItems(filePath, toUserId, config.cdnBaseUrl);

  if (caption) {
    await client.sendMessage(toUserId, [{ type: 1, text_item: { text: caption } }], contextToken);
  }

  for (const item of result.items) {
    await client.sendMessage(toUserId, [item], contextToken);
  }
}
