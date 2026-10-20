import { useEffect, useState } from "react";
import type { RunParametersModel } from "./api-client-contracts.js";

export function RunParameters({ model, onChange }: {
  model: RunParametersModel;
  onChange(field: "parallel" | "isolation" | "verification", value: string): void;
}) {
  const [selectedParallel, setSelectedParallel] = useState(model.selectedParallel);
  const [selectedIsolation, setSelectedIsolation] = useState(model.selectedIsolation);
  const [selectedVerification, setSelectedVerification] = useState(model.selectedVerification);
  useEffect(() => setSelectedParallel(model.selectedParallel), [model.selectedParallel]);
  useEffect(() => setSelectedIsolation(model.selectedIsolation), [model.selectedIsolation]);
  useEffect(() => setSelectedVerification(model.selectedVerification), [model.selectedVerification]);
  return <div className="settings-grid advanced-grid">
    <label>任务并发<select id="run-parallel" value={selectedParallel} onChange={event => {
      const value = event.currentTarget.value;
      setSelectedParallel(value);
      onChange("parallel", value);
    }}>{model.parallelOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    <label>任务隔离<select id="run-isolation" value={selectedIsolation} onChange={event => {
      const value = event.currentTarget.value;
      setSelectedIsolation(value);
      onChange("isolation", value);
    }}>{model.isolationOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    <label id="run-verification-wrap" className={model.showVerification ? "" : "hidden"}>最终验证任务<select id="run-verification" value={selectedVerification} onChange={event => {
      const value = event.currentTarget.value;
      setSelectedVerification(value);
      onChange("verification", value);
    }}>{model.verificationOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
  </div>;
}
