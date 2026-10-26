import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
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

// The user selected the graphic displayed by the installed desktop executable.
// Keep one source PNG shared with the sidebar; generate actual-sized ICO members.
const sourcePng = readFileSync(new URL("../../web/public/app-icon.png", import.meta.url));
function sourcePixels() {
  const width = sourcePng.readUInt32BE(16), height = sourcePng.readUInt32BE(20);
  if (sourcePng[24] !== 8 || sourcePng[25] !== 6 || sourcePng[28] !== 0 || width > 512 || height > 512) throw new Error("app_icon_source_invalid");
  const parts = [];
  for (let offset = 8; offset < sourcePng.length;) {
    const length = sourcePng.readUInt32BE(offset), type = sourcePng.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") parts.push(sourcePng.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)), pixels = Buffer.alloc(width * height * 4), stride = width * 4;
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error("app_icon_filter_invalid");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= 4 ? pixels[i - 4] : 0, above = y ? pixels[i - stride] : 0, diagonal = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, diagonal)][filter];
      pixels[i] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}
const source = sourcePixels();
export function createTrayPng(size) {
  if (!Number.isSafeInteger(size) || size < 16 || size > 512) throw new Error("tray_icon_size_invalid");
  if (size === source.width && size === source.height) return Buffer.from(sourcePng);
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.max(0, (x + 0.5) * source.width / size - 0.5), sy = Math.max(0, (y + 0.5) * source.height / size - 0.5);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const output = y * (size * 4 + 1) + 1 + x * 4, values = [0, 0, 0, 0];
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const i = (Math.min(source.height - 1, y0 + dy) * source.width + Math.min(source.width - 1, x0 + dx)) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), alpha = source.pixels[i + 3];
      values[3] += alpha * weight;
      for (let c = 0; c < 3; c++) values[c] += source.pixels[i + c] * alpha * weight;
    }
    for (let c = 0; c < 3; c++) scanlines[output + c] = values[3] ? Math.round(values[c] / values[3]) : 0;
    scanlines[output + 3] = Math.round(values[3]);
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
