import type { WorkspaceCardItem } from "./api-client-contracts.js";

type WorkspaceCardsProps = {
  workspaces: WorkspaceCardItem[];
  selectedWorkspaceId?: string;
  onSelect: (workspaceId: string) => void;
};

export function WorkspaceCards({ workspaces, selectedWorkspaceId, onSelect }: WorkspaceCardsProps) {
  if (!workspaces.length) return <div className="empty-state">添加一个项目目录，或先完成上一步连接。</div>;

  return workspaces.map(workspace => {
    const selected = workspace.workspaceId === selectedWorkspaceId;
    return (
      <button
        key={workspace.workspaceId}
        type="button"
        className={`project-card${selected ? " selected" : ""}`}
        aria-label={`打开工作区：${workspace.label}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(workspace.workspaceId)}
      >
        <span className="eyebrow">WORKSPACE</span>
        <strong>{workspace.label}</strong>
        <span className="muted small">{workspace.path}</span>
        <span className="card-link">打开工作区 →</span>
      </button>
    );
  });
}

export function WorkspaceNavigation({ workspaces, selectedWorkspaceId, onSelect }: WorkspaceCardsProps) {
  if (!workspaces.length) return <div className="muted small" style={{ padding: 8 }}>尚未添加项目</div>;

  return workspaces.map(workspace => {
    const selected = workspace.workspaceId === selectedWorkspaceId;
    return (
      <button
        key={workspace.workspaceId}
        type="button"
        className={`workspace-item${selected ? " active" : ""}`}
        aria-label={`打开工作区：${workspace.label}`}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(workspace.workspaceId)}
      >
        <span className="workspace-glyph" aria-hidden="true">⌂</span>
        <span>{workspace.label}</span>
      </button>
    );
  });
}
