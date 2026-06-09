/**
 * Message-compose mode — intercepts non-command messages when the user
 * is in compose mode (started via /msg-start).
 *
 * All text and media attachments are accumulated in the order they are
 * received. When the user sends /msg-end, the collected content is sent
 * as a single prompt to the agent, with file references inserted at their
 * original positions. /msg-cancel drops the accumulated content.
 */

import { getComposeAccum, getComposeModeUsers } from "../state.js";
import type { WechatMessage } from "../types.js";
import { downloadMedia } from "./download.js";

export type ComposeItem = { kind: "text"; content: string } | { kind: "file"; path: string; size: number };

export function isComposeMode(userId: string): boolean {
  return getComposeModeUsers().has(userId);
}

export function composeStart(userId: string): void {
  getComposeModeUsers().add(userId);
  getComposeAccum().set(userId, []);
}

export function composeEnd(userId: string): string | null {
  if (!getComposeModeUsers().has(userId)) return null;
  getComposeModeUsers().delete(userId);
  const items = getComposeAccum().get(userId) || [];
  getComposeAccum().delete(userId);
  return items.length > 0 ? buildPrompt(items) : null;
}

export function composeCancel(userId: string): void {
  getComposeModeUsers().delete(userId);
  getComposeAccum().delete(userId);
}

export async function handleComposeMode(
  message: WechatMessage,
  fromUserId: string,
  userTempDir: string,
  cdnBaseUrl: string,
  _contextToken: string,
  maxFileSize?: number,
): Promise<void> {
  const items = getComposeAccum().get(fromUserId) || [];

  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text) {
      items.push({ kind: "text", content: item.text_item.text });
    } else if (item.type === 2 && item.image_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.image_item.media, userTempDir, "image", maxFileSize);
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 4 && item.file_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.file_item.media, userTempDir, "file", maxFileSize);
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 5 && item.video_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.video_item.media, userTempDir, "video", maxFileSize);
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    } else if (item.type === 3 && item.voice_item?.media) {
      const result = await downloadMedia(cdnBaseUrl, item.voice_item.media, userTempDir, "voice", maxFileSize);
      if (result) items.push({ kind: "file", path: result.filePath, size: result.size });
    }
  }

  getComposeAccum().set(fromUserId, items);
}

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
