import { Fragment } from "react";
import type { PlanningNavigationItem } from "./api-client-contracts.js";

type PlanningNavigationProps = {
  items: PlanningNavigationItem[];
  activeTool?: string;
  onSelect: (planningId: string) => void;
  onOpenTool: (planningId: string, tab: string) => void;
  onToolsToggle: (planningId: string, expanded: boolean) => void;
};

function creationTime(value?: string) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return <span className="planning-created">创建时间未记录</span>;
  const text = date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return <time className="planning-created" dateTime={date.toISOString()} title={date.toLocaleString()}>创建 {text}</time>;
}

export function PlanningNavigation({ items, activeTool, onSelect, onOpenTool, onToolsToggle }: PlanningNavigationProps) {
  return items.map(item => (
    <Fragment key={item.planningId}>
      <button
        type="button"
        className={`workspace-item${item.selected ? " active" : ""}`}
        title={`${item.title} · ${item.workflowLabel || item.status}`}
        aria-current={item.selected ? "page" : undefined}
        onClick={() => onSelect(item.planningId)}
      >
        <span className="workspace-glyph" aria-hidden="true">↗</span>
        <span className="planning-list-copy">
          <span className="planning-list-title">{item.title}</span>
          <span className={`planning-list-state badge ${item.statusTone}`}>{item.status}</span>
          {creationTime(item.createdAt)}
        </span>
      </button>
      <details
        className="plan-tools"
        data-planning-id={item.planningId}
        open={item.toolsExpanded}
        onToggle={event => onToolsToggle(item.planningId, event.currentTarget.open)}
      >
        <summary>任务工具</summary>
        <button type="button" className="workspace-item plan-tool-link" data-plan-tool="models" aria-current={item.selected && activeTool === "models" ? "page" : undefined} onClick={() => onOpenTool(item.planningId, "models")}>切换模型</button>
        <button type="button" className="workspace-item plan-tool-link" data-plan-tool="attempts" aria-current={item.selected && activeTool === "attempts" ? "page" : undefined} onClick={() => onOpenTool(item.planningId, "attempts")}>任务详情</button>
      </details>
    </Fragment>
  ));
}

type PlanningCardsProps = Pick<PlanningNavigationProps, "items" | "onSelect">;

export function PlanningCards({ items, onSelect }: PlanningCardsProps) {
  if (!items.length) return <div className="empty-state">还没有 Plan。新建规划，或在网页通过 MCP 提交，之后会出现在这里。</div>;
  return items.map(item => (
    <button key={item.planningId} type="button" className={`project-card${item.selected ? " selected" : ""}`} aria-pressed={item.selected} onClick={() => onSelect(item.planningId)}>
      <span className={`badge ${item.statusTone}`}>{item.status}</span>
      <strong>{item.title}</strong>
      <span className="muted small">{item.taskCount} 个任务</span>
      {creationTime(item.createdAt)}
      <span className="card-link">打开计划 →</span>
    </button>
  ));
}
