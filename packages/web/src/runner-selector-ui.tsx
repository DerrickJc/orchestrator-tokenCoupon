import type { RunnerSelectorModel } from "./api-client-contracts.js";

export function RunnerSelector({ model, onChange }: { model: RunnerSelectorModel; onChange(runnerId: string): void }) {
  return <select id="runner-id" value={model.selectedRunnerId} onChange={event => onChange(event.currentTarget.value)}>
    {model.options.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
  </select>;
}
