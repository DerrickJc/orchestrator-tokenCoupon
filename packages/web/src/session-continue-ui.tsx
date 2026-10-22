import type { SessionContinueModel } from "./api-client-contracts.js";

export function SessionContinueButton({ model }: { model: SessionContinueModel }) {
  return <button id="session-continue" type="button" className="button button-primary" disabled={model.disabled} onClick={model.onContinue}>{model.label}</button>;
}

export function SessionContinueInfo({ model }: { model: SessionContinueModel }) {
  return (
    <div className="session-continue-info">
      <p id="session-continue-hint" className="hint" role="status">{model.message}</p>
      <div id="session-blocker-actions" className={`button-row ${model.blockers.length ? "" : "hidden"}`}>
        {model.blockers.map(blocker => <button type="button" className="button button-quiet" key={blocker.taskId} onClick={blocker.onView}>{blocker.label}</button>)}
        {model.blockers.length > 0 && <button type="button" className="button button-primary" onClick={model.onRevise}>补充决策并新建关联修订</button>}
      </div>
    </div>
  );
}
