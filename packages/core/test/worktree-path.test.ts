import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeDirectorySegments } from "../src/worktree-path.js";

describe("worktree directory containment", () => {
  it("accepts native Windows separators, Chinese names, spaces and drive roots", () => {
    expect(worktreeDirectorySegments("D:\\项目 目录", "D:\\项目 目录\\.token-coupon\\worktrees\\session", win32)).toEqual([".token-coupon", "worktrees", "session"]);
    expect(worktreeDirectorySegments("d:\\PROJECT", "D:/project/.token-coupon/worktrees", win32)).toEqual([".token-coupon", "worktrees"]);
    expect(worktreeDirectorySegments("D:\\", "D:\\.token-coupon\\worktrees", win32)).toEqual([".token-coupon", "worktrees"]);
    expect(worktreeDirectorySegments("\\\\server\\share\\repo", "\\\\server\\share\\repo\\.token-coupon", win32)).toEqual([".token-coupon"]);
  });
  it("rejects Windows sibling paths, traversal, other drives/shares and the root itself", () => {
    for (const target of ["D:\\repo-other\\worktrees", "D:\\repo\\..\\outside", "E:\\repo\\worktrees", "D:\\repo"]) {
      expect(() => worktreeDirectorySegments("D:\\repo", target, win32)).toThrow("worktree_path_outside_workspace");
    }
    expect(() => worktreeDirectorySegments("\\\\server\\share\\repo", "\\\\server\\other\\repo\\worktrees", win32)).toThrow("worktree_path_outside_workspace");
  });
  it("keeps POSIX containment checks and supports a filesystem-root workspace", () => {
    expect(worktreeDirectorySegments("/home/project", "/home/project/.token-coupon/worktrees", posix)).toEqual([".token-coupon", "worktrees"]);
    expect(worktreeDirectorySegments("/", "/.token-coupon/worktrees", posix)).toEqual([".token-coupon", "worktrees"]);
    for (const target of ["/home/project-other/worktrees", "/home/project/../outside", "/home/project"]) {
      expect(() => worktreeDirectorySegments("/home/project", target, posix)).toThrow("worktree_path_outside_workspace");
    }
  });
});
