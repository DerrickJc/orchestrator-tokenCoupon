import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PlannerStore } from "../src/planner-store.js";

it("pages stable planner IDs without reading bodies and ignores unrelated entries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tc-planner-index-")), root = join(workspace, ".token-coupon", "planners");
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  try {
    const store = new PlannerStore(workspace); expect(await store.listIdsPage()).toEqual({ planningIds: [], nextAfter: null });
    await mkdir(root, { recursive: true }); await mkdir(join(root, "unrelated"));
    for (const id of ids) await mkdir(join(root, id));
    await writeFile(join(root, "00000000-0000-4000-8000-000000000003"), "not a directory");
    expect(await store.listIdsPage(undefined, 1)).toEqual({ planningIds: [ids[0]], nextAfter: ids[0] });
    expect(await store.listIdsPage(ids[0], 1)).toEqual({ planningIds: [ids[1]], nextAfter: null });
    await rm(join(root, ids[0]!), { recursive: true });
    expect((await store.listIdsPage(ids[0], 1)).planningIds).toEqual([ids[1]]);
    await expect(store.listIdsPage("../outside")).rejects.toThrow();
    await expect(store.listIdsPage(undefined, 101)).rejects.toThrow();
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
