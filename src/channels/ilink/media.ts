// Inbound photo download. WeChat stores media on its CDN encrypted with
// AES-128-ECB; the key arrives in the message.

import { createDecipheriv } from "node:crypto";
import { MAX_SOURCE_BYTES } from "../../media/images.ts";
import { CDN_BASE_URL, IlinkError, type Fetch } from "./client.ts";
import type { MessageItem } from "./types.ts";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Resolves the 16-byte key. `image_item.aeskey` (hex) is preferred;
 * `media.aes_key` is base64 of either the raw key or its 32-char hex form.
 */
export function imageKey(item: NonNullable<MessageItem["image_item"]>): Buffer | null {
  if (item.aeskey) return Buffer.from(item.aeskey, "hex");
  if (!item.media?.aes_key) return null;
  const decoded = Buffer.from(item.media.aes_key, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (/^[0-9a-f]{32}$/i.test(ascii)) return Buffer.from(ascii, "hex");
  throw new IlinkError(`unexpected aes_key length ${decoded.length}`);
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Buffer): Uint8Array {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** Downloads and decrypts a photo. Returns raw image bytes. */
export async function downloadImage(item: NonNullable<MessageItem["image_item"]>, fetchImpl: Fetch = fetch): Promise<Uint8Array> {
  const media = item.media;
  const url =
    media?.full_url ??
    (media?.encrypt_query_param
      ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : null);
  if (!url) throw new IlinkError("image has no download location");

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new IlinkError(`CDN download HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) throw new IlinkError(`image too large (${declared} bytes)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_SOURCE_BYTES) throw new IlinkError(`image too large (${bytes.length} bytes)`);

  const key = imageKey(item);
  return key ? decryptAesEcb(bytes, key) : bytes;
}
