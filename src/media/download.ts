/**
 * Download + decrypt media from WeChat CDN.
 *
 * WeChat stores media files (images, files, videos, voice) on a CDN
 * encrypted with AES-128-ECB. The encryption key and download URL are
 * embedded in the message's CdnMedia metadata.
 */

import type { CdnMedia, DownloadResult } from "../types.js";
import { createLogger } from "../logger.js";
import crypto from "node:crypto";
import { decryptAesEcb } from "./crypto.js";
import fs from "node:fs/promises";
import path from "node:path";

const log = createLogger("media");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

function parseAesKey(aesKeyField: string | undefined): Buffer | null {
  if (!aesKeyField) return null;
  try {
    const raw = Buffer.from(aesKeyField, "base64");
    if (raw.length === 16) return raw;
    const hex = raw.toString("ascii").trim();
    if (/^[0-9a-fA-F]{32}$/.test(hex)) {
      return Buffer.from(hex, "hex");
    }
    return raw.subarray(0, 16);
  } catch {
    return null;
  }
}

export async function downloadMedia(
  cdnBaseUrl: string,
  media: CdnMedia,
  tempDir: string,
  prefix: string,
  maxFileSize?: number,
): Promise<DownloadResult | null> {
  if (!media) return null;
  await ensureDir(tempDir);

  let aesKey = parseAesKey(media.aes_key);
  if (!aesKey && media.aeskey) {
    aesKey = Buffer.from(media.aeskey, "hex");
  }
  if (!aesKey) {
    log.error("No AES key found in CDNMedia");
    return null;
  }

  let downloadUrl: string;
  if (media.full_url) {
    downloadUrl = media.full_url;
  } else if (media.encrypt_query_param) {
    downloadUrl = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  } else {
    log.error("No download URL in CDNMedia");
    return null;
  }

  log.debug("Downloading from CDN: %s...", downloadUrl.slice(0, 80));
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    log.error("CDN download failed: %d", res.status);
    return null;
  }

  const ciphertext = Buffer.from(await res.arrayBuffer());

  if (maxFileSize && ciphertext.length > maxFileSize) {
    log.error("File exceeds size limit (%d > %d), skipping", ciphertext.length, maxFileSize);
    return null;
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptAesEcb(ciphertext, aesKey);
  } catch (err) {
    log.error("AES decrypt failed: %s", (err as Error).message);
    return null;
  }

  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, plaintext);
  log.info("Downloaded %d bytes to %s", plaintext.length, filePath);
  return { filePath, size: plaintext.length };
}

export function extractMediaItems(message: {
  item_list?: {
    type: number;
    image_item?: { media?: CdnMedia; aeskey?: string };
    voice_item?: { media?: CdnMedia };
    file_item?: { media?: CdnMedia; file_name?: string };
    video_item?: { media?: CdnMedia };
  }[];
}): {
  type: string;
  field: string;
  item: Record<string, unknown>;
  cdn: CdnMedia;
  aesKeyHex?: string;
  fileName?: string;
}[] {
  const items: {
    type: string;
    field: string;
    item: Record<string, unknown>;
    cdn: CdnMedia;
    aesKeyHex?: string;
    fileName?: string;
  }[] = [];
  if (!message.item_list) return items;
  for (const item of message.item_list) {
    if (item.type === 2 && item.image_item?.media) {
      items.push({
        type: "image",
        field: "image_item",
        item: item.image_item,
        cdn: item.image_item.media,
        aesKeyHex: item.image_item.aeskey,
      });
    } else if (item.type === 3 && item.voice_item?.media) {
      items.push({
        type: "voice",
        field: "voice_item",
        item: item.voice_item,
        cdn: item.voice_item.media,
      });
    } else if (item.type === 4 && item.file_item?.media) {
      items.push({
        type: "file",
        field: "file_item",
        item: item.file_item,
        cdn: item.file_item.media,
        fileName: item.file_item.file_name,
      });
    } else if (item.type === 5 && item.video_item?.media) {
      items.push({
        type: "video",
        field: "video_item",
        item: item.video_item,
        cdn: item.video_item.media,
      });
    }
  }
  return items;
}
