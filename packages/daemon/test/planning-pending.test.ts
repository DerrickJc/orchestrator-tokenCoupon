import { expect, it } from "vitest";
import type { PlanningViewDto } from "@token-coupon/client";
import { planningTodo } from "../src/planning-pending.js";

function view(stage: string, session = false) {
  return { workspace: { workspaceId: "workspace", label: "Project" }, planningId: "plan", revision: 4, title: "Planning",
    workflow: { stage, label: "Current workflow" }, ...(session ? { session: { status: stage.replace("execution_", "") } } : {}) } as PlanningViewDto;
}
it("routes review and approval to review, and approved or interrupted execution to its execution page", () => {
  expect(planningTodo(view("awaiting_approval"))?.tab).toBe("review");
  expect(planningTodo(view("review_stale"))?.tab).toBe("review");
  expect(planningTodo(view("approved"))?.tab).toBe("execution");
  expect(planningTodo(view("execution_interrupted", true))?.tab).toBe("execution");
  expect(planningTodo(view("execution_unavailable", true))?.label).toBe("Current workflow");
  expect(planningTodo(view("plan_needs_continue"))?.tab).toBe("overview");
});
it("does not turn running, cancelled, completed or active native requests into Plan approval actions", () => {
  for (const stage of ["execution_running", "execution_pausing", "execution_succeeded", "execution_cancelled", "waiting_input"]) expect(planningTodo(view(stage, true))).toBeNull();
  expect(planningTodo({ ...view("awaiting_approval"), localOperation: { status: "running" } as any })).toBeNull();
});
