import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/** Runtime state is local data, including when Git is initialized after planning. */
export async function ensureRuntimeMetadataIgnored(workspace: string): Promise<void> {
  const root = join(workspace, ".token-coupon");
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime_directory_invalid：.token-coupon 必须是普通目录");
  const file = await open(join(root, ".gitignore"), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("runtime_ignore_invalid：运行目录的 .gitignore 无效");
    const text = await file.readFile("utf8");
    if (!text.split(/\r?\n/).some(line => line.trim() === "*")) await file.writeFile(`${text && !text.endsWith("\n") ? "\n" : ""}# Token Coupon local runtime state\n*\n`);
  } finally { await file.close(); }
}
