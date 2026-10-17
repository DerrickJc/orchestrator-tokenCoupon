import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkspacePath, type WorkspaceEnvironment } from "../src/workspace-path.js";
import { ApplicationService } from "../src/application-service.js";

const wsl: WorkspaceEnvironment = { platform: "linux", isWsl: true, distro: "Ubuntu", home: "/home/test-user", currentDirectory: "/home/test-user/project" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("workspace paths across Windows browser and WSL daemon", () => {
  it("converts the reported Chinese Windows path through the WSL translator without shell evaluation", async () => {
    const input = "D:\\工作项目整理\\数据库文件\\数据库文件";
    const translated = "/mnt/d/工作项目整理/数据库文件/数据库文件";
    const translate = vi.fn(async () => translated);
    expect(await normalizeWorkspacePath(`  \"${input}\"  `, wsl, translate)).toBe(translated);
    expect(translate).toHaveBeenCalledExactlyOnceWith(input);
    const literal = "D:\\含 空格\\$(touch secret)";
    const literalTranslate = vi.fn(async () => "/custom-drives/d/含 空格/$(touch secret)");
    expect(await normalizeWorkspacePath(literal, wsl, literalTranslate)).toBe("/custom-drives/d/含 空格/$(touch secret)");
    expect(literalTranslate).toHaveBeenCalledExactlyOnceWith(literal);
  });

  it("accepts quoted Linux paths and expands only the current user's home shorthand", async () => {
    expect(await normalizeWorkspacePath(" '/home/test-user/项目目录' ", wsl)).toBe("/home/test-user/项目目录");
    expect(await normalizeWorkspacePath("~/项目目录", wsl)).toBe("/home/test-user/项目目录");
    await expect(normalizeWorkspacePath("~another/project", wsl)).rejects.toThrow("workspace_path_invalid");
    await expect(normalizeWorkspacePath("project", wsl)).rejects.toThrow("绝对目录");
    await expect(normalizeWorkspacePath("D:relative", wsl)).rejects.toThrow("绝对目录");
    await expect(normalizeWorkspacePath("/home/test-user\n/project", wsl)).rejects.toThrow("换行");
  });

  it("accepts only UNC paths belonging to this WSL distro", async () => {
    expect(await normalizeWorkspacePath("\\\\wsl.localhost\\Ubuntu\\home\\test-user\\项目", wsl)).toBe("/home/test-user/项目");
    expect(await normalizeWorkspacePath("\\\\wsl$\\ubuntu\\home\\test-user\\项目", wsl)).toBe("/home/test-user/项目");
    await expect(normalizeWorkspacePath("\\\\wsl.localhost\\Debian\\home\\test-user", wsl)).rejects.toThrow("当前后台是 Ubuntu");
    await expect(normalizeWorkspacePath("\\\\server\\share", wsl)).rejects.toThrow("先挂载");
  });

  it("keeps native Windows paths native and explains unsupported cross-platform paths", async () => {
    const windows = { ...wsl, platform: "win32" as const, isWsl: false, home: "C:\\Users\\tester", currentDirectory: "C:\\project" };
    expect(await normalizeWorkspacePath("D:\\项目目录", windows)).toBe("D:\\项目目录");
    expect(await normalizeWorkspacePath("~/项目目录", windows)).toBe("C:\\Users\\tester\\项目目录");
    await expect(normalizeWorkspacePath("D:\\项目目录", { ...wsl, isWsl: false })).rejects.toThrow("需先挂载");
  });

  it("registers canonical paths once and reports nonexistent or non-directory inputs clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "token-coupon-workspace-path-")); roots.push(root);
    const directory = join(root, "项目目录"); await mkdir(directory);
    const alias = join(root, "alias"); await symlink(directory, alias, "dir");
    const service = new ApplicationService({ dataDirectory: join(root, "daemon") }); await service.initialize();
    const entry = await service.addWorkspace(`\"${directory}\"`);
    expect((await service.addWorkspace(alias)).workspaceId).toBe(entry.workspaceId);
    expect(service.listWorkspaces()).toHaveLength(1);
    await expect(service.addWorkspace(join(root, "missing"))).rejects.toThrow("目录不存在或在后台不可见");
    const file = join(root, "file.txt"); await writeFile(file, "test");
    await expect(service.addWorkspace(file)).rejects.toThrow("所选路径不是目录");
    expect(service.listWorkspaces()).toHaveLength(1);
  });
});
