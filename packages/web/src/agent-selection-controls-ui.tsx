import type { AgentSelectionControlsCallbacks, AgentSelectionControlsModel } from "./api-client-contracts.js";

export function AgentSelectionControls({ model, callbacks }: {
  model: AgentSelectionControlsModel;
  callbacks: AgentSelectionControlsCallbacks;
}) {
  return <div className="agent-selection-controls">
    <div className="settings-grid task-agent-config-fields">
      <label>Runner<select data-field="runner" value={model.selectedRunnerId} onChange={event => callbacks.onRunnerChange(event.currentTarget.value)}>
        {model.runners.map(runner => <option key={runner.id} value={runner.id} disabled={runner.disabled}>{runner.label}</option>)}
      </select></label>
      <label>模型<select data-field="model-choice" value={model.selectedModelChoice} disabled={model.loading} aria-busy={!!model.loading} onChange={event => callbacks.onModelChoice(event.currentTarget.value)}>
        {model.modelChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
        <input data-field="model" type="text" maxLength={120} autoComplete="off" placeholder="输入自定义模型 ID" value={model.modelId} hidden={!model.showCustomModel} disabled={model.loading} onChange={event => callbacks.onModelInput(event.currentTarget.value)} />
        <button type="button" className="text-button" disabled={model.loading} onClick={callbacks.onRefresh}>{model.loading ? "正在加载模型…" : "刷新模型"}</button>
      </label>
    </div>
    <p className="hint" role="status">{model.hint}</p>
  </div>;
}
