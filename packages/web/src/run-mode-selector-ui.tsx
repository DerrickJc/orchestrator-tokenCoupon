import { useEffect, useState } from "react";
import type { RunModeSelectorModel } from "./api-client-contracts.js";

export function RunModeSelector({ model, onChange }: {
  model: RunModeSelectorModel;
  onChange(mode: "default" | "custom"): void;
}) {
  const [selectedMode, setSelectedMode] = useState(model.selectedMode);
  useEffect(() => setSelectedMode(model.selectedMode), [model.selectedMode]);
  return <>{model.options.map(option => (
    <label className="run-config-choice" key={option.id}>
      <input type="radio" name="run-mode-choice" value={option.id} checked={selectedMode === option.id} onChange={() => {
        setSelectedMode(option.id);
        onChange(option.id);
      }} />
      <span><strong>{option.title}</strong><small>{option.description}</small></span>
    </label>
  ))}</>;
}
