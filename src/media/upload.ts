/**
 * Encrypt + upload files to WeChat CDN.
 *
 * Handles the full upload pipeline:
 *   1. Read the local file
 *   2. Determine media type from extension
 *   3. Request an upload URL from the WeChat API
 *   4. Encrypt the plaintext with AES-128-ECB
 *   5. POST the ciphertext to the CDN
 *   6. Build the WechatMessageItem for the outbound message
 */

import type { UploadResult, WechatMessageItem } from "../types.js";
import { aesEcbPaddedSize, encryptAesEcb, randHex } from "./crypto.js";
import { getUploadUrl as apiGetUploadUrl } from "../wechat/api.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import mime from "mime/lite";
import path from "node:path";

/**
 * Map a file extension to a WeChat media type.
 * 1 = image, 2 = video, 3 = generic file.
 */
export function getMediaType(filePath: string): number {
  const type = mime.getType(filePath) || "application/octet-stream";
  if (type.startsWith("image/")) return 1;
  if (type.startsWith("video/")) return 2;
  return 3;
}

/**
 * Encrypt the plaintext and upload it to the CDN.
 * Retries up to 3 times on transient server errors.
 * Returns the download_param (encrypted_query_param) from the x-encrypted-param header.
 */
async function uploadBufferToCdn(
  plaintext: Buffer,
  aeskey: Buffer,
  uploadFullUrl: string | undefined,
  uploadParam: string,
  filekey: string,
  cdnBaseUrl: string,
): Promise<string> {
  const ciphertext = encryptAesEcb(plaintext, aeskey);

  const cdnUrl =
    uploadFullUrl ||
    `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    });

    if (res.status >= 400 && res.status < 500) {
      const errMsg = res.headers.get("x-error-message") || (await res.text());
      throw new Error(`CDN client error ${res.status}: ${errMsg}`);
    }
    if (res.status !== 200) {
      if (attempt < 3) {
        console.log(`[upload] CDN attempt ${attempt} failed, retrying...`);
        continue;
      }
      throw new Error(`CDN upload failed after ${attempt} attempts`);
    }

    const downloadParam = res.headers.get("x-encrypted-param");
    if (!downloadParam) throw new Error("CDN response missing x-encrypted-param");
    return downloadParam;
  }

  throw new Error("unreachable");
}

/**
 * Upload a local file to the WeChat CDN and build the message items
 * needed to embed it in an outbound sendMessage call.
 *
 * @param baseUrl   The agent's API base URL
 * @param token     The authenticated bot token
 * @param filePath  Path to the local file to upload
 * @param toUserId  Target WeChat user ID
 */
export async function uploadAndBuildMediaItems(
  baseUrl: string,
  token: string,
  filePath: string,
  toUserId: string,
  cdnBaseUrl: string,
): Promise<UploadResult> {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randHex(16);
  const aeskey = crypto.randomBytes(16);
  const mediaType = getMediaType(filePath);

  console.log(`[upload] ${filePath}: rawsize=${rawsize}, padded=${filesize}, mediaType=${mediaType}`);

  // Request an upload URL from the WeChat API
  const uploadResp = await apiGetUploadUrl(baseUrl, token, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadResp.upload_full_url?.trim();
  const uploadParam = uploadResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error("CDN upload URL response missing both upload_full_url and upload_param");
  }

  // Encrypt and upload the file data
  const downloadParam = await uploadBufferToCdn(plaintext, aeskey, uploadFullUrl, uploadParam || "", filekey, cdnBaseUrl);
  const aesKeyB64 = Buffer.from(aeskey.toString("hex")).toString("base64");

  console.log(`[upload] Success: downloadParam=${downloadParam}...`);

  // Build the message item based on media type
  const items: WechatMessageItem[] = [];

  if (mediaType === 1) {
    items.push({
      type: 2,
      image_item: {
        media: { encrypt_query_param: downloadParam, aes_key: aesKeyB64, encrypt_type: 1 },
        mid_size: filesize,
      },
    });
  } else if (mediaType === 2) {
    items.push({
      type: 5,
      video_item: {
        media: { encrypt_query_param: downloadParam, aes_key: aesKeyB64, encrypt_type: 1 },
        video_size: filesize,
      },
    });
  } else {
    const fileName = path.basename(filePath);
    items.push({
      type: 4,
      file_item: {
        media: { encrypt_query_param: downloadParam, aes_key: aesKeyB64, encrypt_type: 1 },
        file_name: fileName,
        len: String(rawsize),
      },
    });
  }

  return { items, rawsize, filekey };
}
