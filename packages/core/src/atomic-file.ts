import { randomUUID } from "node:crypto";
import { writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Keep the old file intact until replacement succeeds; Windows readers may briefly lock it. */
export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.snapshot-${randomUUID()}.tmp`);
  const delays = [10, 25, 50, 100, 200, 400, 800];
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
