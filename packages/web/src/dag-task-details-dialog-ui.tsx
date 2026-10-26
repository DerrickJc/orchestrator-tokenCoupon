import type { DagTaskDetailsModel } from "./api-client-contracts.js";

export function DagTaskDetailsDialog({ model, onViewAttempt }: { model: DagTaskDetailsModel; onViewAttempt: () => void }) {
  return <>
    <div id="dag-task-content" className="dag-task-detail-content">
      {model.sections.map(section => <section key={section.label}>
        <h4>{section.label}</h4>
        <pre>{section.value}</pre>
      </section>)}
    </div>
    <button id="dag-task-attempt" type="button" className="button button-primary" disabled={!model.canOpenAttempt} onClick={onViewAttempt}>查看执行回复与工具活动</button>
  </>;
}
