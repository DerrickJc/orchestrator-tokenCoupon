import type { RuntimeModelControlsCallbacks, RuntimeModelControlsModel } from "./api-client-contracts.js";

export function RuntimeModelControls({ model, callbacks }: {
  model: RuntimeModelControlsModel;
  callbacks: RuntimeModelControlsCallbacks;
}) {
  return <div className="settings-grid">
    <label>目标任务<select id="runtime-model-task" value={model.selectedTaskId} onChange={event => callbacks.onTaskChange(event.currentTarget.value)}>
      {model.tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}
    </select></label>
    <label>模型<select id="runtime-model-choice" value={model.selectedModelId} onChange={event => callbacks.onModelChange(event.currentTarget.value)}>
      {model.models.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
    </select></label>
    <label className={model.selectedModelId === "__custom__" ? "" : "hidden"}>自定义模型 ID<input id="runtime-model-custom" value={model.customModelId} autoComplete="off" placeholder="输入 Runner 支持的模型 ID" onChange={event => callbacks.onCustomModelChange(event.currentTarget.value)} /></label>
  </div>;
}
