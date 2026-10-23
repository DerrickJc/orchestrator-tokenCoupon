import type { AttemptDiagnosisControlsModel } from "./api-client-contracts.js";

type HistoryProps = {
  diagnostics: AttemptDiagnosisControlsModel["diagnostics"];
  selectedId: string;
  disabled: boolean;
  onChange(id: string): void;
};

export function AttemptDiagnosisHistorySelect({ diagnostics, selectedId, disabled, onChange }: HistoryProps) {
  return <select id="attempt-diagnosis-history-select" aria-label="历史诊断" className={diagnostics.length > 1 ? "" : "hidden"} value={selectedId} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>
    {diagnostics.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
  </select>;
}

type ModelProps = {
  model: AttemptDiagnosisControlsModel;
  callbacks: { onRunnerChange(runnerId: string): void; onModelChange(modelId: string): void; onCustomModelChange(modelId: string): void };
};

export function AttemptDiagnosisModelSelectors({ model, callbacks }: ModelProps) {
  return <div className="diagnosis-model-selectors">
    <label>助手<select id="attempt-diagnosis-runner" value={model.runnerId} disabled={model.disabled} onChange={event => callbacks.onRunnerChange(event.currentTarget.value)}>
      <option value="codex">Codex</option><option value="claude-code">Claude Code</option>
    </select></label>
    <label>模型<select id="attempt-diagnosis-model" value={model.modelId} disabled={model.disabled || model.loading} aria-busy={!!model.loading} onChange={event => callbacks.onModelChange(event.currentTarget.value)}>
      <option value="">{model.loading ? "正在加载模型…" : "默认模型"}</option>
      {model.models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      <option value="__custom__">自定义模型…</option>
    </select></label>
    <label id="diagnosis-custom-wrap" className={model.modelId === "__custom__" ? "" : "hidden"}>模型 ID<input id="diagnosis-custom-model" maxLength={200} placeholder="输入模型 ID" value={model.customModelId} disabled={model.disabled} onChange={event => callbacks.onCustomModelChange(event.currentTarget.value)} /></label>
  </div>;
}
