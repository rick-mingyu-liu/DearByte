import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ImageError, loadImage, sniffImageType } from "../src/media/images.ts";

test("detects formats from bytes", () => {
  expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  expect(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImageType(new TextEncoder().encode("\0\0\0\x18ftypheic"))).toBeNull();
});

test("rejects a renamed non-image and a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-img-"));
  const fake = join(dir, "cat.jpg");
  writeFileSync(fake, "not really a jpeg");
  expect(() => loadImage(fake)).toThrow(ImageError);
  expect(() => loadImage(join(dir, "missing.jpg"))).toThrow("找不到图片");
});
