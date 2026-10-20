import type { ExecutionProgressModel } from "./api-client-contracts.js";

export function ExecutionProgress({ model }: { model: ExecutionProgressModel }) {
  return (
    <>
      <span className={`execution-state badge ${model.statusTone}`}>{model.statusLabel}</span>
      {model.hasSession && (
        <>
          <progress max={model.total || 1} value={model.completed} aria-label="已完成任务比例" />
          <div className="execution-metrics">
            {model.metrics.map(metric => (
              <div className="execution-metric" data-kind={metric.kind} key={metric.kind}>
                <span>{metric.label} </span><strong>{metric.value}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
