import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

export function createTrayPng(size) {
  if (!Number.isSafeInteger(size) || size < 16 || size > 512) throw new Error("tray_icon_size_invalid");
  const scanlines = Buffer.alloc((size * 4 + 1) * size), radius = size * 0.23;
  const insideRoundRect = (x, y) => {
    const cx = Math.max(radius, Math.min(size - radius, x)), cy = Math.max(radius, Math.min(size - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); scanlines[row] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5, offset = row + 1 + x * 4;
      if (!insideRoundRect(px, py)) continue;
      const isStem = px >= size * 0.405 && px <= size * 0.595 && py >= size * 0.34 && py <= size * 0.77;
      const isTop = px >= size * 0.23 && px <= size * 0.77 && py >= size * 0.235 && py <= size * 0.37;
      scanlines[offset] = isStem || isTop ? 255 : 35;
      scanlines[offset + 1] = isStem || isTop ? 255 : 112;
      scanlines[offset + 2] = isStem || isTop ? 255 : 82;
      scanlines[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
}

export function createTrayIco(sizes = [16, 20, 24, 32, 40, 48, 64, 256]) {
  const images = sizes.map(size => ({ size, png: createTrayPng(size) }));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16); let offset = header.length + entries.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16; entries[entry] = size === 256 ? 0 : size; entries[entry + 1] = size === 256 ? 0 : size;
    entries.writeUInt16LE(1, entry + 4); entries.writeUInt16LE(32, entry + 6); entries.writeUInt32LE(png.length, entry + 8); entries.writeUInt32LE(offset, entry + 12); offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map(image => image.png)]);
}

export async function writeTrayIcons(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "token-coupon.png"), createTrayPng(256)),
    writeFile(join(outputDirectory, "token-coupon.ico"), createTrayIco()),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await writeTrayIcons(join(packageDirectory, "dist"));
}
