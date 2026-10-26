import type { AttemptDiagnosisDialogModel } from "./api-client-contracts.js";

export function AttemptDiagnosisDialog({ model, onClose, onSwitch }: { model: AttemptDiagnosisDialogModel; onClose(): void; onSwitch(): void }) {
  return <>
    <div className="section-title">
      <div><h3>任务诊断</h3><p id="attempt-diagnosis-context" className="hint">{model.contextText}</p></div>
      <div className="button-row"><button type="button" className="text-button" onClick={onSwitch}>切换分析方式</button><button type="button" data-diagnosis-close className="text-button" onClick={onClose}>关闭</button></div>
    </div>
    <div id="attempt-diagnosis-history-controls-root"><select id="attempt-diagnosis-history-select" aria-label="历史诊断" className="hidden"></select></div>
    <p id="attempt-diagnosis-status" className="diagnosis-chat-status" role="status">{model.statusText}</p>
    <section id="attempt-diagnosis-history" className="diagnosis-chat-history" aria-label="诊断对话"></section>
    <form id="attempt-diagnosis-form" className="diagnosis-chat-composer">
      <label className="sr-only" htmlFor="attempt-diagnosis-reply">发送诊断问题</label>
      <div id="attempt-diagnosis-composer-root"><textarea id="attempt-diagnosis-reply" rows={3} maxLength={8192} placeholder="输入问题、补充事实，或讨论处理方案…"></textarea></div>
      <div className="diagnosis-chat-footer">
        <div id="attempt-diagnosis-model-controls-root" className="diagnosis-model-selectors">
          <label>助手<select id="attempt-diagnosis-runner"><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
          <label>模型<select id="attempt-diagnosis-model"><option value="">默认模型</option><option value="__custom__">自定义模型…</option></select></label>
          <label id="diagnosis-custom-wrap" className="hidden">模型 ID<input id="diagnosis-custom-model" maxLength={200} placeholder="输入模型 ID" /></label>
        </div>
        <button id="attempt-diagnosis-send" type="submit" className="button button-primary" disabled={model.sendDisabled}>{model.sendLabel}</button>
      </div>
      <p className="hint">发送会调用所选模型。这里只分析与讨论；修复、重试和计划变更需另行确认。</p>
    </form>
  </>;
}
