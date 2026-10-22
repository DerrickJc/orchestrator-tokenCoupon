import type { PlanDiffModel } from "./api-client-contracts.js";

export function PlanDiffView({ model }: { model: PlanDiffModel }) {
  if (model.error) return <p className="plan-diff-error" role="alert">JSON 校验失败：{model.error}</p>;
  return <div className="plan-diff-view">
    <strong>草案差异</strong>
    <p>修改 {model.changed.length} 项 / 新增 {model.addedTasks.length} 项 / 删除 {model.removedTasks.length} 项</p>
    {model.titleChange && <section><h4>计划标题</h4><p>{model.titleChange.from} → {model.titleChange.to}</p></section>}
    {model.changed.length > 0
      ? <section><h4>修改字段</h4><ul>{model.changed.map((change, index) => <li key={`${change.taskId}:${change.label}:${index}`}>任务 {change.taskId} · {change.label}</li>)}</ul></section>
      : <p>正文无字段修改</p>}
    {model.addedTasks.length > 0 && <section><h4>新增任务</h4><ul>{model.addedTasks.map(id => <li key={id}>{id}</li>)}</ul></section>}
    {model.removedTasks.length > 0 && <section><h4>删除任务</h4><ul>{model.removedTasks.map(id => <li key={id}>{id}</li>)}</ul></section>}
  </div>;
}
