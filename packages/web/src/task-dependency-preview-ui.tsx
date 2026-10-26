import { useLayoutEffect, useRef } from "react";
import type { TaskDependencyPreviewModel } from "./api-client-contracts.js";

export function TaskDependencyPreview({ model }: { model: TaskDependencyPreviewModel | null }) {
  const graphHost = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = graphHost.current;
    if (!host || !model) return;
    host.replaceChildren(model.svg);
    return () => {
      if (model.svg.parentElement === host) model.svg.remove();
    };
  }, [model?.svg]);

  if (!model) return null;
  return (
    <>
      <h4>任务依赖 · {model.taskCount} 个任务</h4>
      <div className="dag-preview dag-mini-map" ref={graphHost} />
      <button type="button" className="button button-quiet task-dag-full" onClick={model.onOpen}>放大查看任务 DAG</button>
      <p className="hint">以{model.focusLabel}为中心 · 显示 {model.shown}/{model.taskCount} 项 · 远端分支折叠</p>
    </>
  );
}
