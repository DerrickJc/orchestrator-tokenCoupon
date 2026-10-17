import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readAttemptEvents } from "../src/attempt-observation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tc-observation-")); roots.push(root);
  const attemptId = randomUUID(), directory = join(root, ".token-coupon", "runs", attemptId); await mkdir(directory, { recursive: true });
  return { root, attemptId, directory, path: join(directory, "events.jsonl") };
}
it("paginates complete UTF-8 events beyond the rolling event window with no lost or repeated bytes", async () => {
  const h = await fixture();
  const events = Array.from({ length: 1800 }, (_, i) => ({ sequence: i + 1, attemptId: h.attemptId, type: "message.delta", payload: { root: true, text: `课程 ${i} ` + "文".repeat(100) } }));
  await writeFile(h.path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  let cursor = 0, fileId: string | undefined; const loaded: unknown[] = [];
  for (;;) { const page = await readAttemptEvents(h.root, h.attemptId, cursor, fileId); loaded.push(...page.events); cursor = page.cursor; fileId = page.fileId; if (!page.hasMore) break; }
  expect(loaded).toEqual(events);
  const final = { sequence: 1801, attemptId: h.attemptId, type: "runner.output", payload: { finalText: "最终返回".repeat(2000) } };
  await appendFile(h.path, JSON.stringify(final) + "\n");
  expect((await readAttemptEvents(h.root, h.attemptId, cursor, fileId)).events).toEqual([final]);
});
it("waits for incomplete tail lines and reports malformed records and replaced files", async () => {
  const h = await fixture();
  const line = JSON.stringify({ sequence: 1, attemptId: h.attemptId, type: "runner.output", payload: { text: "中文" } });
  await writeFile(h.path, line.slice(0, -2));
  const first = await readAttemptEvents(h.root, h.attemptId); expect(first.cursor).toBe(0); expect(first.pendingPartial).toBe(true);
  await appendFile(h.path, line.slice(-2) + "\ninvalid-json\nnull\n");
  const completed = await readAttemptEvents(h.root, h.attemptId); expect(completed.events).toHaveLength(1); expect(completed.malformed).toBe(2);
  await expect(readAttemptEvents(h.root, h.attemptId, 3)).rejects.toThrow("attempt_cursor_invalid");
  await rename(h.path, h.path + ".old"); await writeFile(h.path, line + "\n");
  const replaced = await readAttemptEvents(h.root, h.attemptId, completed.cursor, first.fileId); expect(replaced.reset).toBe(true); expect(replaced.events).toHaveLength(1);
});
it("rejects arbitrary paths and symlink files or directories", async () => {
  const h = await fixture(); await writeFile(join(h.root, "secret"), "private"); await symlink(join(h.root, "secret"), h.path);
  await expect(readAttemptEvents(h.root, h.attemptId)).rejects.toThrow("attempt_path_invalid");
  await expect(readAttemptEvents(h.root, "../../secret")).rejects.toThrow("attempt_id_invalid");
  await rm(h.directory, { recursive: true }); await symlink(h.root, h.directory, "dir");
  await expect(readAttemptEvents(h.root, h.attemptId)).rejects.toThrow("attempt_path_invalid");
});

it("groups streamed progress into readable latest replies instead of showing one token or a completion marker", async () => {
  const h = await fixture(); await writeFile(join(h.directory, "attempt.json"), JSON.stringify({ attemptId: h.attemptId, status: "running", runnerId: "codex" }));
  const events = [
    { type: "message.delta", payload: { messageId: "progress", root: true, text: "已经核对" } },
    { type: "runner.output", payload: { agentText: "已经核对", structuredEvent: { type: "codex.message.delta" } } },
    { type: "message.delta", payload: { messageId: "progress", root: true, text: "接口文档，继续运行测试。" } },
  ];
  await writeFile(h.path, events.map((event, index) => JSON.stringify({ ...event, sequence: index + 1, attemptId: h.attemptId })).join("\n") + "\n");
  const { readAttemptInfo } = await import("../src/attempt-observation.js");
  expect((await readAttemptInfo(h.root, h.attemptId)).lastReply).toBe("已经核对接口文档，继续运行测试。");
  await appendFile(h.path, JSON.stringify({ type: "runner.output", payload: { finalText: "完成结论：测试通过\n<<<TOKEN_COUPON_DONE:abc>>>" } }) + "\n");
  expect((await readAttemptInfo(h.root, h.attemptId)).lastReply).toBe("完成结论：测试通过");
});
