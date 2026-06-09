/**
 * File-upload mode inbox — intercepts non-command messages when the user
 * is in upload mode (started via /file-upload-start).
 *
 * While upload mode is active, all media attachments are downloaded to the
 * user's temp directory. Name conflicts are detected and skipped. Files are
 * tracked in-memory and displayed when the user sends /file-upload-end.
 */

import { downloadMedia, extractMediaItems } from "./download.js";
import { escape, humanizeSize } from "../utils.js";
import type { WechatMessage } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sendTextReply } from "../dispatch.js";

/** Set of user IDs currently in upload mode. */
const uploadModeUsers = new Set<string>();
/** Per-user list of files received during the current upload session. */
const uploadFiles = new Map<string, { name: string; size: number }[]>();

/** Check whether a user is currently in file-upload mode. */
export function isUploadMode(userId: string): boolean {
  return uploadModeUsers.has(userId);
}

/** Enter upload mode for the given user — clears any previous file list. */
export function uploadStart(userId: string): void {
  uploadModeUsers.add(userId);
  uploadFiles.set(userId, []);
}

/**
 * Exit upload mode for the given user.
 * Returns the accumulated file list and clears state.
 */
export function uploadEnd(userId: string): { name: string; size: number }[] {
  if (!uploadModeUsers.has(userId)) return [];
  uploadModeUsers.delete(userId);
  const files = uploadFiles.get(userId) || [];
  uploadFiles.delete(userId);
  return files;
}

/**
 * Handle an inbound message while the user is in upload mode.
 * Downloads any media attachments, checks for name conflicts,
 * tracks new files, and sends a summary reply.
 */
export async function handleUploadMode(
  message: WechatMessage,
  fromUserId: string,
  userTempDir: string,
  cdnBaseUrl: string,
  contextToken: string,
  maxFileSize?: number,
): Promise<void> {
  const mediaExtracts = extractMediaItems(message);
  const list = uploadFiles.get(fromUserId) || [];

  if (mediaExtracts.length > 0) {
    for (const media of mediaExtracts) {
      const fileName = media.fileName || `file_${Date.now()}`;
      const destPath = path.join(userTempDir, fileName);
      try {
        await fs.access(destPath);
        await sendTextReply(fromUserId, `⚠️ 文件已存在，跳过: ${fileName}`, contextToken);
        continue;
      } catch {
        // file does not exist, proceed
      }

      const result = await downloadMedia(cdnBaseUrl, media.cdn, userTempDir, media.type, maxFileSize);
      if (result) {
        list.push({ name: path.basename(result.filePath), size: result.size });
      }
    }
    uploadFiles.set(fromUserId, list);
  }

  if (list.length === 0) {
    await sendTextReply(fromUserId, "📤 上传模式中，暂无文件。请直接发送文件", contextToken);
  } else {
    let text = "**📤 已接收文件：**\n\n| 文件名 | 大小 |\n| --- | --- |\n";
    for (const f of list) {
      text += `| ${escape(f.name)} | ${humanizeSize(f.size)} |\n`;
    }
    await sendTextReply(fromUserId, text, contextToken);
  }
}
