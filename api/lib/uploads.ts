import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env";

const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "./uploads/products");
const maxImageBytes = 5 * 1024 * 1024;

const formats = [
  { mime: "image/jpeg", extension: "jpg", signature: (buffer: Buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { mime: "image/png", extension: "png", signature: (buffer: Buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", extension: "webp", signature: (buffer: Buffer) => buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" },
] as const;

export async function saveProductImage(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw new Error("Format foto harus JPG, PNG, atau WebP.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > maxImageBytes) throw new Error("Ukuran foto maksimal 5 MB.");
  const format = formats.find((item) => item.mime === match[1] && item.signature(buffer));
  if (!format) throw new Error("Isi file tidak sesuai dengan format gambar.");
  await fs.mkdir(uploadDirectory, { recursive: true });
  const filename = `${randomUUID()}.${format.extension}`;
  await fs.writeFile(path.join(uploadDirectory, filename), buffer, { flag: "wx" });
  return { imageUrl: `${env.publicApiUrl}/uploads/products/${filename}` };
}

export async function readProductImage(filename: string) {
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(filename)) return null;
  try {
    const buffer = await fs.readFile(path.join(uploadDirectory, filename));
    const extension = path.extname(filename);
    const contentType = extension === ".jpg" ? "image/jpeg" : extension === ".png" ? "image/png" : "image/webp";
    return { buffer, contentType };
  } catch {
    return null;
  }
}
