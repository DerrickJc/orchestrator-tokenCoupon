import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTrayIcons } from "./generate-icons.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
await copyFile(resolve(root, "src/preload.cjs"), resolve(root, "dist/preload.cjs"));
await writeTrayIcons(resolve(root, "dist"));
