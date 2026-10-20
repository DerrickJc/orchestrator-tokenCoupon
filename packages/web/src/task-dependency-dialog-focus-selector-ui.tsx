import type { DagFocusOption } from "./api-client-contracts.js";

export function DagFocusSelector({ options, selectedId, onChange }: {
  options: DagFocusOption[];
  selectedId: string;
  onChange: (taskId: string) => void;
}) {
  return <label className="dag-focus-label">聚焦任务<select id="dag-focus" aria-label="聚焦任务" value={selectedId} onChange={event => onChange(event.currentTarget.value)}>
    {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select></label>;
}
