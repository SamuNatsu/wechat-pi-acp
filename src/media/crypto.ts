/**
 * AES-128-ECB crypto utilities for WeChat CDN media encryption.
 *
 * WeChat CDN uses AES-128 in ECB mode with PKCS#7-like padding
 * (a 1-byte header + standard block padding).
 */

import crypto from "node:crypto";

/**
 * Encrypt plaintext with AES-128-ECB.
 * key must be exactly 16 bytes.
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Decrypt ciphertext with AES-128-ECB.
 * key must be exactly 16 bytes.
 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Calculate the padded ciphertext size for AES-128-ECB.
 * Adds 1 byte overhead for the CDN padding scheme.
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Generate a random hex string of the given byte length. */
export function randHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Generate a random WeChat UIN placeholder for the X-WECHAT-UIN header.
 * Encodes a random 32-bit integer as base64.
 */
export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
