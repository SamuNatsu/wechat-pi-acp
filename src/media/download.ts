/**
 * Download + decrypt media from WeChat CDN.
 *
 * WeChat stores media files (images, files, videos, voice) on a CDN
 * encrypted with AES-128-ECB. The encryption key and download URL are
 * embedded in the message's CdnMedia metadata.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptAesEcb } from "./crypto.js";
import type { CdnMedia, DownloadResult } from "../types.js";

function ensureDir(dir: string) {
  fs.mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * Parse the AES key from various WeChat formats:
 *   - base64 (with or without padding, 16-byte raw key)
 *   - 32-char hex string
 * Falls back to a 16-byte subarray of the raw buffer.
 */
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

/**
 * Download a single media item from CDN, decrypt it, and save to tempDir.
 * Returns the local file path and size, or null on failure.
 *
 * @param cdnBaseUrl  Base CDN URL for constructing download URLs
 * @param media       CDN metadata (aes_key, encrypt_query_param, full_url)
 * @param tempDir     Local directory to save the decrypted file
 * @param prefix      Filename prefix (e.g. "image", "file", "voice", "video")
 */
export async function downloadMedia(
  cdnBaseUrl: string,
  media: CdnMedia,
  tempDir: string,
  prefix: string,
): Promise<DownloadResult | null> {
  if (!media) return null;
  ensureDir(tempDir);

  // Extract the AES key from whichever field the server provided
  let aesKey = parseAesKey(media.aes_key);
  if (!aesKey && media.aeskey) {
    aesKey = Buffer.from(media.aeskey, "hex");
  }
  if (!aesKey) {
    console.error("[media] No AES key found in CDNMedia");
    return null;
  }

  // Build the download URL from metadata
  let downloadUrl: string;
  if (media.full_url) {
    downloadUrl = media.full_url;
  } else if (media.encrypt_query_param) {
    downloadUrl = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  } else {
    console.error("[media] No download URL in CDNMedia");
    return null;
  }

  console.log(`[media] Downloading from CDN: ${downloadUrl.slice(0, 80)}...`);
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    console.error(`[media] CDN download failed: ${res.status}`);
    return null;
  }

  const ciphertext = Buffer.from(await res.arrayBuffer());
  let plaintext: Buffer;
  try {
    plaintext = decryptAesEcb(ciphertext, aesKey);
  } catch (err) {
    console.error(`[media] AES decrypt failed: ${(err as Error).message}`);
    return null;
  }

  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const filePath = path.join(tempDir, filename);
  await fs.writeFile(filePath, plaintext);
  console.log(`[media] Downloaded ${plaintext.length} bytes to ${filePath}`);
  return { filePath, size: plaintext.length };
}

/**
 * Walk a WeChat message's item_list and extract all media attachments.
 * Each entry includes the media type, the CDN metadata, and any
 * associated file name or AES key.
 */
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
    // type 2 = image, 3 = voice, 4 = file, 5 = video
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
