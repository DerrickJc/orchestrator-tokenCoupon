import type { PendingApprovalDecisionModel } from "./api-client-contracts.js";

export function PendingApprovalDecisionActions({ model }: { model: PendingApprovalDecisionModel }) {
  return (
    <div className="interaction-actions">
      <button className="button button-primary" type="button" onClick={model.onAllow}>本次允许</button>
      <button className="button button-quiet" type="button" onClick={model.onDeny}>拒绝本次操作</button>
    </div>
  );
}
