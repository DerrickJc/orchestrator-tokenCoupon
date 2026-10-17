import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parsePlan, runGit, runPlan } from "@token-coupon/core";
import { readTaskResults } from "../src/task-results.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(isolation: "shared" | "git-worktree" = "git-worktree") {
  const workspace = await mkdtemp(join(tmpdir(), "tc-task-results-")); roots.push(workspace);
  await runGit(workspace, ["init", "--quiet"]);
  await runGit(workspace, ["config", "user.name", "Task Results Test"]);
  await runGit(workspace, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(workspace, ".gitignore"), ".token-coupon/\n.env\n");
  await runGit(workspace, ["add", ".gitignore"]); await runGit(workspace, ["commit", "--quiet", "-m", "initial test fixture"]);
  const plan = parsePlan({ schemaVersion: 1, id: "task-results", title: "Task results", tasks: ["produce", "verify"].map((id, index) => ({
    task: { schemaVersion: 1, id, title: id, prompt: id, execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: index ? ["produce"] : [], status: "planned",
  })) });
  const result = await runPlan({ workspace, plan, isolation, ...(isolation === "git-worktree" ? { verificationTaskId: "verify" } : {}), createRunner: () => ({
    id: "mock", supportsModel: false, checkAvailable: async () => {}, run: async (input, context) => {
      context.onStarted();
      if (input.task.id === "produce") {
        await mkdir(join(input.cwd, "docs"), { recursive: true });
        for (let index = 0; index < 4; index++) await writeFile(join(input.cwd, "docs", `result-${index}.md`), `# Result ${index}\n<script>text only</script>`);
      }
      context.onOutput({ stream: "stdout", text: input.completionMarker, agentText: input.completionMarker });
      return { started: true, exitCode: 0, signal: null };
    },
  }) });
  expect(result.snapshot.status).toBe("succeeded");
  return { workspace, sessionId: result.snapshot.sessionId };
}
it("uses per-task Git evidence, reads only listed files and refuses substituted symlinks", async () => {
  const h = await fixture(), data = await readTaskResults(h.workspace, h.sessionId, "produce");
  expect(data.source).toBe("git-isolation"); expect(data.total).toBe(4); expect(data.files!.map(file => file.path)).toEqual([0, 1, 2, 3].map(index => `docs/result-${index}.md`));
  expect(data.files![0]!.absolutePath).toContain("/.token-coupon/worktrees/");
  const preview = await readTaskResults(h.workspace, h.sessionId, "produce", "docs/result-0.md");
  expect(preview.file.content).toContain("<script>text only</script>");
  await expect(readTaskResults(h.workspace, h.sessionId, "produce", "../outside.txt")).rejects.toThrow("只能预览");
  await expect(readTaskResults(h.workspace, h.sessionId, "unknown")).rejects.toThrow("不属于");
  const noChanges = await readTaskResults(h.workspace, h.sessionId, "verify"); expect(noChanges.files).toEqual([]); expect(noChanges.total).toBe(0);
  const outside = join(h.workspace, "outside.txt"); await writeFile(outside, "outside sentinel");
  await rm(data.files![0]!.absolutePath); await symlink(outside, data.files![0]!.absolutePath);
  await expect(readTaskResults(h.workspace, h.sessionId, "produce", "docs/result-0.md")).rejects.toThrow("不允许预览");
});
it("does not attribute all shared-workspace files to an individual task", async () => {
  const h = await fixture("shared"), result = await readTaskResults(h.workspace, h.sessionId, "produce");
  expect(result.source).toBe("unrecorded"); expect(result.files).toEqual([]); expect(result.message).toContain("未记录任务级文件清单");
  await expect(readTaskResults(h.workspace, h.sessionId, "produce", "docs/result-0.md")).rejects.toThrow("没有可核验");
});
