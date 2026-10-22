import type { PendingApprovalOverviewModel } from "./api-client-contracts.js";

export function PendingApprovalOverview({ model }: { model: PendingApprovalOverviewModel }) {
  return (
    <>
      <div className="section-title">
        <h3 id="pending-approval-heading">需要你的决定 · 审批与回答</h3>
        <span id="pending-approval-count" className="badge badge-neutral">{model.count} 项</span>
      </div>
      <p id="pending-approval-summary" className="hint" role="status">{model.summary}</p>
    </>
  );
}
