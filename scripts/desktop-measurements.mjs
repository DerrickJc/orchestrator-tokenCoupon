import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Logical file sizes; links are counted but never followed or reported by name. */
export async function directoryFootprint(directory) {
  if (!isAbsolute(directory) || !(await lstat(directory)).isDirectory()) throw new Error("desktop_metrics_directory_invalid");
  const pending = [directory]; const result = { logicalBytes: 0, files: 0, directories: 0, linksNotFollowed: 0 };
  while (pending.length) {
    const current = pending.pop(), info = await lstat(current);
    if (info.isSymbolicLink()) { result.linksNotFollowed++; continue; }
    if (info.isDirectory()) {
      result.directories++;
      for (const entry of await readdir(current)) pending.push(join(current, entry));
    } else if (info.isFile()) { result.files++; result.logicalBytes += info.size; }
    if (result.files + result.directories + result.linksNotFollowed > 100_000) throw new Error("desktop_metrics_entry_limit");
  }
  return result;
}
