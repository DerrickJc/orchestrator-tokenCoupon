import type { PlanOverviewModel } from "./api-client-contracts.js";

export function PlanOverviewView({ model, onPrimaryAction, onResume }: {
  model: PlanOverviewModel;
  onPrimaryAction(): void;
  onResume(): void;
}) {
  return (
    <section className="card panel-section">
      <div className="section-title">
        <h3>当前进度与下一步</h3>
        <span id="plan-stage" className={`badge ${model.stageTone}`}>{model.stage}</span>
      </div>
      <p id="plan-next-action">{model.nextAction}</p>
      <div id="plan-summary" className="summary-grid">
        <div><strong>{model.taskCount}</strong><span>计划任务</span></div>
        <div><strong>{model.completedTaskCount}</strong><span>执行完成</span></div>
        <div><strong>{model.reviewStatus}</strong><span>审查报告</span></div>
      </div>
      <div className="button-row">
        <button id="plan-primary-action" type="button" className="button button-primary" onClick={onPrimaryAction}>{model.primaryActionLabel}</button>
        <button id="copy-plan-resume" type="button" className="button button-quiet" disabled={model.resumeDisabled} onClick={onResume}>复制网页继续提示</button>
      </div>
    </section>
  );
}
