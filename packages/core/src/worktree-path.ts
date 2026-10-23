import path from "node:path";

/** Validate containment using the host's path rules, including drive/UNC boundaries. */
export function worktreeDirectorySegments(workspace: string, target: string, paths: Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep"> = path): string[] {
  const relative = paths.relative(paths.resolve(workspace), paths.resolve(target));
  const parts = relative.split(paths.sep);
  if (!relative || paths.isAbsolute(relative) || parts.some(part => part === ".." || part === "")) {
    throw new Error("worktree_path_outside_workspace：隔离路径越出 workspace");
  }
  return parts;
}
