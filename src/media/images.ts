import { readFileSync, statSync } from "node:fs";
import type { ImageInput } from "../domain.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Detects JPEG, PNG or WebP from the file's bytes, not its name. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export class ImageError extends Error {}

export function loadImage(path: string): ImageInput {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ImageError(`找不到图片：${path}`);
  }
  if (size > MAX_IMAGE_BYTES) throw new ImageError(`图片太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
  const bytes = new Uint8Array(readFileSync(path));
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new ImageError("只支持 JPEG、PNG、WebP（iPhone 的 HEIC 需要先转成 JPEG）");
  return { mimeType, bytes };
}
