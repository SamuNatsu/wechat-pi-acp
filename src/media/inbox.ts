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
import { getUploadFiles, getUploadModeUsers } from "../state.js";
import type { WechatMessage } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sendTextReply } from "../reply.js";

export function isUploadMode(userId: string): boolean {
  return getUploadModeUsers().has(userId);
}

export function uploadStart(userId: string): void {
  getUploadModeUsers().add(userId);
  getUploadFiles().set(userId, []);
}

export function uploadEnd(userId: string): { name: string; size: number }[] {
  if (!getUploadModeUsers().has(userId)) return [];
  getUploadModeUsers().delete(userId);
  const files = getUploadFiles().get(userId) || [];
  getUploadFiles().delete(userId);
  return files;
}

export async function handleUploadMode(
  message: WechatMessage,
  fromUserId: string,
  userTempDir: string,
  cdnBaseUrl: string,
  contextToken: string,
  maxFileSize?: number,
): Promise<void> {
  const mediaExtracts = extractMediaItems(message);
  const list = getUploadFiles().get(fromUserId) || [];

  if (mediaExtracts.length > 0) {
    for (const media of mediaExtracts) {
      const fileName = media.fileName || `file_${Date.now()}`;
      const destPath = path.join(userTempDir, fileName);
      try {
        await fs.access(destPath);
        await sendTextReply(fromUserId, `⚠️ 文件已存在，跳过: ${fileName}`, contextToken);
        continue;
      } catch {}
      const result = await downloadMedia(cdnBaseUrl, media.cdn, userTempDir, media.type, maxFileSize);
      if (result) {
        list.push({ name: path.basename(result.filePath), size: result.size });
      }
    }
    getUploadFiles().set(fromUserId, list);
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
