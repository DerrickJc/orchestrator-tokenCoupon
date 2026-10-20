import { useEffect, useState } from "react";
import type { ModelChoiceSelectorModel } from "./api-client-contracts.js";

export function ModelChoiceSelector({ prefix, model, onChange }: {
  prefix: "planner" | "runner";
  model: ModelChoiceSelectorModel;
  onChange(modelId: string): void;
}) {
  const [selectedModelId, setSelectedModelId] = useState(model.selectedModelId);
  useEffect(() => setSelectedModelId(model.selectedModelId), [model.selectedModelId]);
  return <select id={`${prefix}-model-choice`} value={selectedModelId} onChange={event => {
    const value = event.currentTarget.value;
    setSelectedModelId(value);
    onChange(value);
  }}>
    {model.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
  </select>;
}
