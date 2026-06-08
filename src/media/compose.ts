/**
 * Message-compose mode — intercepts non-command messages when the user
 * is in compose mode (started via /msg-start).
 *
 * All text and media attachments are accumulated in the order they are
 * received. When the user sends /msg-end, the collected content is sent
 * as a single prompt to the agent, with file references inserted at their
 * original positions. /msg-cancel drops the accumulated content.
 */

import { downloadMedia } from "./download.js";
import type { WechatMessage } from "../types.js";

type ComposeItem = { kind: "text"; content: string } | { kind: "file"; path: string; size: number };

/** Set of user IDs currently in compose mode. */
const composeModeUsers = new Set<string>();
/** Per-user ordered list of items during the compose span. */
const composeAccum = new Map<string, ComposeItem[]>();

export function isComposeMode(userId: string): boolean {
  return composeModeUsers.has(userId);
}

export function composeStart(userId: string): void {
  composeModeUsers.add(userId);
  composeAccum.set(userId, []);
}

/**
 * Exit compose mode and return the accumulated items as a single prompt
 * string, with file references inline at their original positions.
 */
export function composeEnd(userId: string): string | null {
  if (!composeModeUsers.has(userId)) return null;
  composeModeUsers.delete(userId);
  const items = composeAccum.get(userId) || [];
  composeAccum.delete(userId);
  return items.length > 0 ? buildPrompt(items) : null;
}

export function composeCancel(userId: string): void {
  composeModeUsers.delete(userId);
  composeAccum.delete(userId);
}

/**
 * Handle an inbound message while the user is in compose mode.
 * Accumulates text and downloads media attachments in order.
 */
export async function handleComposeMode(
  message: WechatMessage,
  fromUserId: string,
  userTempDir: string,
  cdnBaseUrl: string,
  _contextToken: string,
): Promise<void> {
  const items = composeAccum.get(fromUserId) || [];

  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text) {
      items.push({ kind: "text", content: item.text_item.text });
    } else if (item.type === 2 && item.image_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.image_item.media, userTempDir, "image");
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 4 && item.file_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.file_item.media, userTempDir, "file");
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 5 && item.video_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.video_item.media, userTempDir, "video");
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 3 && item.voice_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.voice_item.media, userTempDir, "voice");
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    }
  }

  composeAccum.set(fromUserId, items);
}

/** Build a single prompt string from the ordered compose items. */
function buildPrompt(items: ComposeItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      parts.push(item.content);
    } else {
      parts.push(`[path=${item.path},size=${item.size}]`);
    }
  }
  return parts.join("\n");
}
