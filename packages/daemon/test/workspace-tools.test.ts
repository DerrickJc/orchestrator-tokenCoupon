import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectGitRepository, runGit } from "@token-coupon/core";
import { ApplicationService } from "../src/application-service.js";
import { browseDirectories, prepareWorkspaceGit, workspaceGitStatus, previewGitCommit, commitWorkspaceGit } from "../src/workspace-tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tc-workspace-tools-")); roots.push(root);
  const path = join(root, "中文 项目"); await mkdir(path);
  const service = new ApplicationService({ dataDirectory: join(root, "daemon") }); await service.initialize();
  const workspace = await service.addWorkspace(path);
  return { root, path, service, workspace };
}
async function identity(path: string) { await runGit(path, ["config", "user.name", "Workspace Test"]); await runGit(path, ["config", "user.email", "workspace@example.invalid"]); }

it("protects runtime files before Git exists and explains missing repository and initial commit separately", async () => {
  const h = await fixture();
  expect((await workspaceGitStatus(h.path)).state).toBe("not_repository");
  await expect(inspectGitRepository(h.path)).rejects.toThrow("git_repository_required");
  const runtime = join(h.path, ".token-coupon", "conversation.json"); await writeFile(runtime, "first");
  expect(await readFile(join(h.path, ".token-coupon", ".gitignore"), "utf8")).toContain("*");
  expect((await prepareWorkspaceGit(h.path, "initialize")).state).toBe("no_commit");
  await expect(inspectGitRepository(h.path)).rejects.toThrow("git_initial_commit_required");
  await identity(h.path);
  expect((await prepareWorkspaceGit(h.path, "initial-commit")).state).toBe("ready");
  await writeFile(join(h.path, "README.md"), "business source");
  await runGit(h.path, ["add", "."]);
  expect((await runGit(h.path, ["ls-files", "--", ".token-coupon"])).stdout).toBe("");
  await runGit(h.path, ["commit", "-m", "add business source"]);
  await writeFile(runtime, "new conversation revision");
  expect((await runGit(h.path, ["status", "--porcelain"])).stdout).toBe("");
  expect((await workspaceGitStatus(h.path)).state).toBe("ready");
});

it("untracks existing runtime state without deleting files or automatically committing index changes", async () => {
  const h = await fixture(); await prepareWorkspaceGit(h.path, "initialize"); await identity(h.path); await prepareWorkspaceGit(h.path, "initial-commit");
  const runtime = join(h.path, ".token-coupon", "conversation.json"); await writeFile(runtime, "saved conversation");
  await runGit(h.path, ["add", "-f", "--", ".token-coupon/conversation.json"]); await runGit(h.path, ["commit", "-m", "accidental runtime tracking"]);
  const head = (await runGit(h.path, ["rev-parse", "HEAD"])).stdout;
  await writeFile(runtime, "latest user conversation");
  expect(await workspaceGitStatus(h.path)).toMatchObject({ state: "metadata_tracked", trackedMetadataCount: 1 });
  expect((await prepareWorkspaceGit(h.path, "untrack-runtime")).state).toBe("dirty");
  expect(await readFile(runtime, "utf8")).toBe("latest user conversation");
  expect((await runGit(h.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  expect((await runGit(h.path, ["diff", "--cached", "--name-only"])).stdout).toContain(".token-coupon/conversation.json");
  await runGit(h.path, ["commit", "-m", "stop tracking runtime"]);
  await writeFile(runtime, "another revision");
  expect((await workspaceGitStatus(h.path)).state).toBe("ready");
});

it("restores missing ignore protection for workspaces registered before the fix without hiding business changes", async () => {
  const h = await fixture();
  await rm(join(h.path, ".token-coupon", ".gitignore"));
  const runtime = join(h.path, ".token-coupon", "conversation.json"); await writeFile(runtime, "existing conversation");
  await runGit(h.path, ["init"]); await identity(h.path); await runGit(h.path, ["commit", "--allow-empty", "-m", "initial"]);
  expect((await workspaceGitStatus(h.path)).state).toBe("dirty");
  expect((await h.service.gitStatus(h.workspace.workspaceId)).state).toBe("dirty");
  await expect(readFile(join(h.path, ".token-coupon", ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  await prepareWorkspaceGit(h.path, "protect-runtime");
  expect((await h.service.gitStatus(h.workspace.workspaceId)).state).toBe("ready");
  expect(await readFile(runtime, "utf8")).toBe("existing conversation");
  await writeFile(join(h.path, "user-code.py"), "user data");
  expect((await h.service.gitStatus(h.workspace.workspaceId)).state).toBe("dirty");
});

it("refuses to commit a nonempty index and explains selecting a repository subdirectory", async () => {
  const h = await fixture(); await prepareWorkspaceGit(h.path, "initialize"); await identity(h.path);
  await writeFile(join(h.path, "user.txt"), "keep staged data"); await runGit(h.path, ["add", "user.txt"]);
  await expect(prepareWorkspaceGit(h.path, "initial-commit")).rejects.toThrow("git_index_not_empty");
  expect((await runGit(h.path, ["diff", "--cached", "--name-only"])).stdout).toContain("user.txt");
  const sub = join(h.path, "sub"); await mkdir(sub);
  expect(await workspaceGitStatus(sub)).toMatchObject({ state: "wrong_root", repositoryRoot: h.path });
});

it("browses only visible directories, preserves Chinese paths and paginates without reading files", async () => {
  const h = await fixture();
  await mkdir(join(h.path, "课程设计")); await mkdir(join(h.path, "node_modules")); await mkdir(join(h.path, ".private"));
  await writeFile(join(h.path, "secret.env"), "never returned"); await symlink(h.root, join(h.path, "external-link"), "dir");
  const data = await browseDirectories(h.path);
  expect(data.entries.map(entry => entry.name)).toEqual(["课程设计"]); expect(data.path).toBe(h.path); expect(data.parent).toBe(h.root);
  expect(data.breadcrumbs.at(-1)).toEqual({ label: "中文 项目", path: h.path });
  expect(data.environment.label).toBeTruthy();
  expect(JSON.stringify(data)).not.toContain("never returned");
  await Promise.all(Array.from({ length: 102 }, (_, i) => mkdir(join(h.path, `folder-${i}`))));
  const first = await browseDirectories(h.path); expect(first.entries).toHaveLength(100); expect(first.nextOffset).toBe(100);
  expect((await browseDirectories(h.path, 100)).entries).toHaveLength(3);
  await mkdir(join(h.path, "ZZ-Target"));
  const found = await browseDirectories(h.path, 0, "target");
  expect(found.entries.map(entry => entry.name)).toEqual(["ZZ-Target"]); expect(found.totalMatches).toBe(1); expect(found.nextOffset).toBeNull();
  await expect(browseDirectories(h.path, 0, "x".repeat(257))).rejects.toThrow("directory_query_invalid");
});

it("rejects a symlink runtime directory without writing outside the selected workspace", async () => {
  const h = await fixture(), other = join(h.root, "outside"); await mkdir(other);
  const second = join(h.root, "unsafe"); await mkdir(second); await symlink(other, join(second, ".token-coupon"), "dir");
  await expect(h.service.addWorkspace(second)).rejects.toThrow("runtime_directory_invalid");
  await expect(readFile(join(other, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("previews and explicitly commits runtime cleanup without deleting local records, rejecting other staged files", async () => {
  const h = await fixture(); await prepareWorkspaceGit(h.path, "initialize"); await identity(h.path); await prepareWorkspaceGit(h.path, "initial-commit");
  const file = join(h.path, ".token-coupon", "conversation.json"); await writeFile(file, "latest conversation");
  await runGit(h.path, ["add", "-f", "--", ".token-coupon/conversation.json"]); await runGit(h.path, ["commit", "-m", "old tracked records"]);
  await prepareWorkspaceGit(h.path, "untrack-runtime");
  const preview = await previewGitCommit(h.path, "runtime", []);
  expect(preview.paths).toEqual([".token-coupon/conversation.json"]);
  await writeFile(join(h.path, "unrelated.txt"), "keep this staged"); await runGit(h.path, ["add", "unrelated.txt"]);
  await expect(commitWorkspaceGit(h.path, { ...preview, mode: "runtime", message: preview.suggestedMessage })).rejects.toThrow("git_staged_other_changes");
  expect((await runGit(h.path, ["diff", "--cached", "--name-only"])).stdout).toContain("unrelated.txt");
  await runGit(h.path, ["reset", "--", "unrelated.txt"]);
  const refreshed = await previewGitCommit(h.path, "runtime", []);
  const result = await commitWorkspaceGit(h.path, { ...refreshed, mode: "runtime", message: refreshed.suggestedMessage });
  expect(result.commit).not.toBe(preview.head); expect(result.status.state).toBe("dirty");
  expect(await readFile(file, "utf8")).toBe("latest conversation");
  expect((await runGit(h.path, ["show", "--pretty=", "--name-only", "HEAD"])).stdout.trim()).toBe(".token-coupon/conversation.json");
});

it("binds selected Unicode files to their preview and never adds unselected or ignored files", async () => {
  const h = await fixture(); await prepareWorkspaceGit(h.path, "initialize"); await identity(h.path);
  await writeFile(join(h.path, "课程.mjs"), "export const name = '课程';\n");
  await writeFile(join(h.path, "other.txt"), "not selected");
  let preview = await previewGitCommit(h.path, "selected", ["课程.mjs"]);
  await writeFile(join(h.path, "课程.mjs"), "export const name = '改动';\n");
  await expect(commitWorkspaceGit(h.path, { ...preview, mode: "selected", message: "initial source" })).rejects.toThrow("git_preview_stale");
  expect((await runGit(h.path, ["diff", "--cached", "--name-only"])).stdout).toBe("");
  preview = await previewGitCommit(h.path, "selected", ["课程.mjs"]);
  const result = await commitWorkspaceGit(h.path, { ...preview, mode: "selected", message: "initial source" });
  expect(result.status.state).toBe("dirty");
  expect((await runGit(h.path, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean)).toEqual(["课程.mjs"]);
  await expect(previewGitCommit(h.path, "selected", [".token-coupon/.gitignore"])).rejects.toThrow("git_selection_invalid");
});

it("refuses partial staging and preserves a failing hook's index and files", async () => {
  const h = await fixture(); await prepareWorkspaceGit(h.path, "initialize"); await identity(h.path); await prepareWorkspaceGit(h.path, "initial-commit");
  await writeFile(join(h.path, "code.txt"), "staged version"); await runGit(h.path, ["add", "code.txt"]);
  await writeFile(join(h.path, "code.txt"), "unstaged version");
  await expect(previewGitCommit(h.path, "selected", ["code.txt"])).rejects.toThrow("git_manual_index_required");
  expect((await runGit(h.path, ["show", ":code.txt"])).stdout).toBe("staged version");
  await runGit(h.path, ["add", "code.txt"]);
  await writeFile(join(h.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const preview = await previewGitCommit(h.path, "selected", ["code.txt"]);
  await expect(commitWorkspaceGit(h.path, { ...preview, mode: "selected", message: "must fail" })).rejects.toThrow("git commit");
  expect((await runGit(h.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(preview.head);
  expect((await runGit(h.path, ["show", ":code.txt"])).stdout).toBe("unstaged version");
});
