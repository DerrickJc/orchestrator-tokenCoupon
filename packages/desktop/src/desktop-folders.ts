import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";

/** A local renderer may request a real directory, never a shell command or URL. */
export async function existingDesktopDirectory(input: unknown): Promise<string> {
  if (typeof input !== "string" || !input || input.length > 32768 || /[\x00-\x1f]/.test(input) || !isAbsolute(input)) {
    throw new Error("desktop_directory_invalid：请选择本机已有的绝对目录");
  }
  const path = await realpath(input);
  if (!(await stat(path)).isDirectory()) throw new Error("desktop_directory_invalid：只能打开文件夹");
  return path;
}
