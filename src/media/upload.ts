/**
 * Encrypt + upload files to WeChat CDN.
 */

import type { UploadResult, WechatMessageItem } from "../types.js";
import { aesEcbPaddedSize, encryptAesEcb, randHex } from "./crypto.js";
import { createLogger } from "../logger.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getWechatClient } from "../wechat/client.js";
import mime from "mime/lite";
import path from "node:path";

const log = createLogger("upload");

function getMediaType(filePath: string): number {
  const type = mime.getType(filePath) || "application/octet-stream";
  if (type.startsWith("image/")) return 1;
  if (type.startsWith("video/")) return 2;
  return 3;
}

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
        log.warn("CDN upload attempt %d failed, retrying...", attempt);
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

export async function uploadAndBuildMediaItems(
  filePath: string,
  toUserId: string,
  cdnBaseUrl: string,
): Promise<UploadResult> {
  const client = getWechatClient();
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randHex(16);
  const aeskey = crypto.randomBytes(16);
  const mediaType = getMediaType(filePath);

  log.debug("%s: rawsize=%d, padded=%d, mediaType=%d", filePath, rawsize, filesize, mediaType);

  const uploadResp = await client.getUploadUrl({
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

  const downloadParam = await uploadBufferToCdn(
    plaintext,
    aeskey,
    uploadFullUrl,
    uploadParam || "",
    filekey,
    cdnBaseUrl,
  );
  const aesKeyB64 = Buffer.from(aeskey.toString("hex")).toString("base64");

  log.info("Upload success: %s", downloadParam.slice(0, 40));

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
