import { useState } from "react";
import type { PlanDraftEditorPlan } from "./api-client-contracts.js";

const runnerLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "deepseek-api": "DeepSeek API",
};

export function PlanDraftEditor({ model, onChange }: {
  model: { identity: string; plan: PlanDraftEditorPlan; disabled: boolean };
  onChange: (plan: PlanDraftEditorPlan) => void;
}) {
  const [plan, setPlan] = useState(model.plan);
  const [fieldText, setFieldText] = useState<Record<string, string>>({});
  const update = (mutate: (draft: PlanDraftEditorPlan) => void) => {
    const next = structuredClone(plan);
    mutate(next);
    setPlan(next);
    onChange(next);
  };
  const field = (label: string, value: string | string[] | undefined, onValue: (value: string | string[]) => void, multiline = false, array = false) => {
    const text = fieldText[label] ?? (array && Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "");
    const change = (raw: string) => {
      setFieldText(previous => ({ ...previous, [label]: raw }));
      onValue(array ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : raw);
    };
    const rows = array ? Math.min(8, Math.max(3, (Array.isArray(value) ? value.length : 0) + 1)) : 5;
    return <label className="draft-text-field" key={label}>{label}
      {multiline
        ? <textarea value={text} rows={rows} disabled={model.disabled} onChange={event => change(event.currentTarget.value)} />
        : <input value={text} disabled={model.disabled} onChange={event => change(event.currentTarget.value)} />}
    </label>;
  };

  return <div className="plan-draft-editor">
    {field("计划标题", plan.title, value => update(draft => { draft.title = String(value); }))}
    {plan.tasks.map((entry, index) => {
      const task = entry.task, execution = task.execution || {};
      const heading = `任务 ${index + 1} · ${task.id} · 依赖 ${entry.dependsOn.join(", ") || "无"} · ${runnerLabels[execution.runnerId || ""] || execution.runnerId || "未设置 Runner"} / ${execution.modelId || "默认模型"}`;
      const updateField = (name: string, value: string | string[], array = false, optional = false) => update(draft => {
        const target = draft.tasks[index]!.task;
        if (optional && typeof value === "string" && !value.trim()) delete target[name];
        else target[name] = array && typeof value === "string" ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : value;
      });
      return <section className="draft-editor-task" key={task.id}>
        <h4 className="draft-task-heading">{heading}</h4>
        {field(`任务 ${index + 1} 标题`, task.title, value => updateField("title", value))}
        {task.schemaVersion === 2 ? <>
          {field(`任务 ${index + 1} · 需求目标`, task.objective, value => updateField("objective", value), true)}
          {field(`任务 ${index + 1} · 设计与技术方案`, task.approach, value => updateField("approach", value), true)}
          {field(`任务 ${index + 1} · 实施步骤（每行一项）`, task.steps, value => updateField("steps", value, true), true, true)}
          {field(`任务 ${index + 1} · 交付物（每行一项）`, task.deliverables, value => updateField("deliverables", value, true), true, true)}
          {field(`任务 ${index + 1} · 验收标准（每行一项）`, task.acceptanceCriteria, value => updateField("acceptanceCriteria", value, true), true, true)}
          {field(`任务 ${index + 1} · 约束（每行一项，可空）`, task.constraints, value => updateField("constraints", value, true), true, true)}
          {field(`任务 ${index + 1} · 其他说明`, task.notes, value => updateField("notes", value, false, true), true)}
        </> : field(`任务 ${index + 1} · 旧版正文`, task.prompt, value => updateField("prompt", value), true)}
      </section>;
    })}
  </div>;
}
