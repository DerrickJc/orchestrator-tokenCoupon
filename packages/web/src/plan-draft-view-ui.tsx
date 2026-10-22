import { useState } from "react";
import type { PlanDraftViewModel } from "./api-client-contracts.js";

export function PlanDraftView({ model }: { model: PlanDraftViewModel }) {
  const [expanded, setExpanded] = useState(() => new Set<string>());
  if (model.emptyMessage) return <div className="empty-state">{model.emptyMessage}</div>;

  return (
    <div className="plan-card-list">
      {model.tasks.map(task => (
        <details
          className="plan-card"
          data-task-id={task.taskId}
          key={task.taskId}
          open={expanded.has(task.taskId)}
          onToggle={event => {
            const taskId = task.taskId, isOpen = event.currentTarget.open;
            setExpanded(previous => {
              if (previous.has(taskId) === isOpen) return previous;
              const next = new Set(previous);
              if (isOpen) next.add(taskId);
              else next.delete(taskId);
              return next;
            });
          }}
        >
          <summary>
            <span>{task.title}</span>
            <span className="muted small">{task.taskId} · {task.schemaLabel} · 查看详情</span>
          </summary>
          <div className="plan-field-preview">
            {task.sections.map(section => (
              <section key={section.label}>
                <strong>{section.label}</strong>
                <p>{Array.isArray(section.value) ? section.value.map((line, index) => `${index + 1}. ${line}`).join("\n") : section.value}</p>
              </section>
            ))}
          </div>
          <div className="task-meta">依赖：{task.dependsOn.join(", ") || "无"} · {task.runnerLabel} / {task.modelLabel}</div>
        </details>
      ))}
    </div>
  );
}
