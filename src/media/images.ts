import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageInput } from "../domain.ts";

/** Largest image sent to the model. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Largest file read at all; HEIC sources are converted and resized first. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const tooBig = (size: number) => new ImageError(`图片太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);

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

const isHeic = (bytes: Uint8Array) => {
  const brand = String.fromCharCode(...bytes.subarray(4, 12));
  return brand.startsWith("ftyp") && /heic|heix|mif1|msf1/.test(brand.slice(4));
};

/** HEIC (iPhone photos) → JPEG via macOS's built-in sips. Temp files are removed. */
function convertHeic(bytes: Uint8Array): ImageInput {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-heic-"));
  const src = join(dir, "photo.heic");
  const out = join(dir, "photo.jpg");
  try {
    writeFileSync(src, bytes);
    execFileSync("sips", ["-s", "format", "jpeg", "-Z", "2048", src, "--out", out], { stdio: "ignore" });
    return { mimeType: "image/jpeg", bytes: new Uint8Array(readFileSync(out)) };
  } catch {
    throw new ImageError("HEIC 转换失败（需要 macOS 自带的 sips），请先手动转成 JPEG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Checks type and size of raw image bytes, converting HEIC to JPEG. */
export function imageFromBytes(bytes: Uint8Array): ImageInput {
  if (bytes.length > MAX_SOURCE_BYTES) throw tooBig(bytes.length);
  const mimeType = sniffImageType(bytes);
  if (mimeType) {
    if (bytes.length > MAX_IMAGE_BYTES) throw tooBig(bytes.length);
    return { mimeType, bytes };
  }
  if (isHeic(bytes)) {
    const converted = convertHeic(bytes);
    if (converted.bytes.length > MAX_IMAGE_BYTES) throw tooBig(converted.bytes.length);
    return converted;
  }
  throw new ImageError("只支持 JPEG、PNG、WebP、HEIC");
}

export function loadImage(path: string): ImageInput {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ImageError(`找不到图片：${path}`);
  }
  if (size > MAX_SOURCE_BYTES) throw tooBig(size);
  return imageFromBytes(new Uint8Array(readFileSync(path)));
}

/**
 * Splits "/img" arguments into a path and caption. Accepts quoted paths and
 * backslash-escaped spaces, as produced by dragging a file into the terminal.
 */
export function parseImageArgs(input: string): { path: string; caption: string } {
  const s = input.trim();
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    if (end > 0) return { path: s.slice(1, end), caption: s.slice(end + 1).trim() };
  }
  let path = "";
  let i = 0;
  for (; i < s.length && !/\s/.test(s[i]); i++) {
    if (s[i] === "\\" && i + 1 < s.length) i++;
    path += s[i];
  }
  return { path, caption: s.slice(i).trim() };
}
