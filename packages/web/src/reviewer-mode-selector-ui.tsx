import { useEffect, useState } from "react";
import type { ReviewerModeSelectorModel } from "./api-client-contracts.js";

export function ReviewerModeSelector({ model, onChange }: {
  model: ReviewerModeSelectorModel;
  onChange(mode: string): void;
}) {
  const [selectedMode, setSelectedMode] = useState(model.selectedMode);
  useEffect(() => setSelectedMode(model.selectedMode), [model.selectedMode]);
  return <select id="reviewer-mode" value={selectedMode} onChange={event => {
    const value = event.currentTarget.value;
    setSelectedMode(value);
    onChange(value);
  }}>
    {model.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select>;
}
