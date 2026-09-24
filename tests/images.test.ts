import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ImageError, loadImage, parseImageArgs, sniffImageType } from "../src/media/images.ts";

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

test("parses dragged, quoted and plain image paths", () => {
  expect(parseImageArgs(" /tmp/My\\ Photos/cat\\ 1.jpg 路上看到的")).toEqual({ path: "/tmp/My Photos/cat 1.jpg", caption: "路上看到的" });
  expect(parseImageArgs(` '/tmp/My Photos/cat.jpg' 看`)).toEqual({ path: "/tmp/My Photos/cat.jpg", caption: "看" });
  expect(parseImageArgs(" cat.png")).toEqual({ path: "cat.png", caption: "" });
  expect(parseImageArgs("  ")).toEqual({ path: "", caption: "" });
});

const heic = "/System/Library/Desktop Pictures/Sonoma.heic";
test.skipIf(process.platform !== "darwin" || !existsSync(heic))("converts HEIC to JPEG with sips", () => {
  const image = loadImage(heic);
  expect(image.mimeType).toBe("image/jpeg");
  expect(sniffImageType(image.bytes)).toBe("image/jpeg");
});
