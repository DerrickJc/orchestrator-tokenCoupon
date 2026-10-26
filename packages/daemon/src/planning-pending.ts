import type { PlanningTodoDto, PlanningViewDto } from "@token-coupon/client";

/** Read-only projection of the existing workflow and observed Session, never an approval gate. */
export function planningTodo(view: PlanningViewDto): PlanningTodoDto | null {
  if (view.localOperation?.status === "running") return null;
  const stage = view.workflow?.stage;
  if (!stage || ["execution_succeeded", "execution_cancelled", "execution_running", "execution_pausing", "waiting_input"].includes(stage)) return null;
  const tab = view.session || stage === "approved" ? "execution" : stage.startsWith("review") || ["awaiting_review", "awaiting_approval"].includes(stage) ? "review" : "overview";
  return { workspaceId: view.workspace.workspaceId, workspaceLabel: view.workspace.label, planningId: view.planningId,
    title: view.title || view.draft?.plan.title || "未命名计划", revision: view.revision,
    stage, label: view.workflow!.label, tab };
}
