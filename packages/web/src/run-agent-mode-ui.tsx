import type { RunAgentModeModel } from "./api-client-contracts.js";

export function RunAgentModeSelector({ model, onChange }: {
  model: RunAgentModeModel;
  onChange(mode: "plan" | "unified" | "per-task"): void;
}) {
  return <select id="run-agent-mode" value={model.selectedMode} onChange={event => onChange(event.currentTarget.value as "plan" | "unified" | "per-task")}>
    {model.options.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
  </select>;
}
