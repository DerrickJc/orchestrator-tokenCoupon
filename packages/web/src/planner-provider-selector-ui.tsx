import type { PlannerProviderOption, PlannerProviderSelectorModel } from "./api-client-contracts.js";

function options(items: PlannerProviderOption[]) {
  return items.map(item => <option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>);
}

export function PlannerProviderSelector({ model, onChange }: { model: PlannerProviderSelectorModel; onChange(providerId: string): void }) {
  return <select id="planner-provider" value={model.selectedProviderId} onChange={event => onChange(event.currentTarget.value)}>
    {options(model.standalone)}
    {!!model.localAgents.length && <optgroup label="本机 Agent（只读规划／审查）">{options(model.localAgents)}</optgroup>}
    {!!model.apiProviders.length && <optgroup label="模型 API / 离线演示">{options(model.apiProviders)}</optgroup>}
  </select>;
}
