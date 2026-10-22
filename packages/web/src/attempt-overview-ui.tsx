import type { AttemptOverviewModel } from "./api-client-contracts.js";

export function AttemptOverview({ model, onDiagnose }: { model: AttemptOverviewModel; onDiagnose: () => void }) {
  return (
    <div className="attempt-overview-content">
      <p id="attempt-state" className="hint" role="status">{model.state}</p>
      <div id="attempt-diagnostic-actions" className="button-row">
        <button id="attempt-diagnose" type="button" className={`button button-primary${model.diagnoseVisible ? "" : " hidden"}`} onClick={onDiagnose}>分析原因</button>
      </div>
      <p id="attempt-notice" className="hint" role="status">{model.notice}</p>
      <p id="attempt-outcome" className={`attempt-outcome ${model.outcomeClass}${model.outcomeVisible ? "" : " hidden"}`} role="status">{model.outcome}</p>
      <h4 id="attempt-reply-heading">{model.replyHeading}</h4>
    </div>
  );
}
