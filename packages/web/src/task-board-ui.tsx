import type { TaskBoardEntry, TaskBoardModel } from "./api-client-contracts.js";

function DependencyList({ label, items }: { label: string; items: TaskBoardEntry["dependencies"] }) {
  return (
    <>
      {label && <span className="task-sub">{label}</span>}
      {items.map((item, index) => <span className={`dependency-chip ${item.tone}`} key={`${item.label}:${index}`}>{item.label}</span>)}
    </>
  );
}

function TaskCard({ task }: { task: TaskBoardEntry }) {
  return (
    <div className="task-row" data-task-id={task.taskId}>
      <span className={`task-icon ${task.iconTone}`}>{task.icon}</span>
      <span>
        <span className="task-name">{task.title}</span>
        <span className="task-sub">{task.taskId} · {task.runnerModel}</span>
        <span className="task-sub">{task.attemptSummary}<span className="task-elapsed">{task.elapsed}</span>{task.reasonCode && ` · ${task.reasonCode}`}</span>
        <span className="task-sub">{task.activity}</span>
        {task.resultSummary && <details className="foldout"><summary>任务结果摘要{task.resultTruncated ? "（已截断，查看完整回复）" : ""}</summary><pre>{task.resultSummary}</pre></details>}
        <div className="task-dependency-chips">
          {task.dependencies.length === 0 ? "起始任务 · 无前置依赖" : <DependencyList label={task.dependencyLabel} items={task.dependencies} />}
          {task.completedDependencies && task.completedDependencies.length > 0 && <DependencyList label={task.completedDependencyLabel || ""} items={task.completedDependencies} />}
        </div>
        {task.nextModel && <span className="task-sub">{task.nextModel}</span>}
        {task.outcome && <p className={`task-outcome ${task.statusTone}`}>{task.outcome}</p>}
      </span>
      <span className={`badge ${task.statusTone}`}>{task.statusLabel}</span>
      {task.actions.map((action, index) => <button type="button" className="button button-quiet" key={`${action.label}:${index}`} onClick={action.onClick}>{action.label}</button>)}
    </div>
  );
}

export function TaskBoard({ model }: { model: TaskBoardModel }) {
  if (model.emptyMessage) return <div className="empty-state">{model.emptyMessage}</div>;
  return (
    <div className="task-board">
      {model.groups.map(group => (
        <section className="task-board-column" data-group={group.id} key={group.id}>
          <h4>{group.label}<span className="task-board-count"> {group.tasks.length}</span></h4>
          <div className="task-board-rows">
            {group.tasks.slice(0, 3).map(task => <TaskCard task={task} key={task.taskId} />)}
          </div>
          <details className={`task-board-overflow ${group.tasks.length > 3 ? "" : "hidden"}`}>
            <summary>展开其余 {Math.max(0, group.tasks.length - 3)} 项任务</summary>
            <div className="task-board-extra">{group.tasks.slice(3).map(task => <TaskCard task={task} key={task.taskId} />)}</div>
          </details>
        </section>
      ))}
    </div>
  );
}
