import { expect, it } from "vitest";
import type { PlanningTodoPageDto } from "@token-coupon/client";
import { createPlanningTodoState } from "../src/planning-todo-state.js";
const page = (nextCursor: string | null, epoch = "one"): PlanningTodoPageDto => ({ epoch, items: [], warnings: [], scanned: 5, nextCursor });
it("uses server cursors, allows backward reads, and ignores old responses after restart", async () => {
  const seen: Array<string | undefined> = [];
  let finish!: (value: PlanningTodoPageDto) => void;
  const state = createPlanningTodoState(cursor => { seen.push(cursor); return new Promise(resolve => { finish = resolve; }); }, () => {});
  state.reset("one"); const first = state.first(); finish(page("page-two")); await first;
  const second = state.move(1); finish(page(null)); await second;
  expect(state.current().pageIndex).toBe(1);
  const back = state.move(-1); finish(page("page-two")); await back;
  expect(seen).toEqual([undefined, "page-two", undefined]);
  const stale = state.refresh(); state.reset("two"); finish(page(null)); await stale;
  expect(state.current().page).toBeNull();
  const current = state.refresh(); finish(page(null, "one")); await current;
  expect(state.current().error).toContain("后台已变化");
});
