import type { PendingQueueItemDto, PlanningTodoDto, PlanningTodoPageDto } from "@token-coupon/client";

export interface GlobalPendingModel {
  items: PendingQueueItemDto[]; total: number; offset: number; nextOffset: number | null;
  loading: boolean; error: string | null;
  authorizations: Array<{ requestId: string; label: string }>; authorizationFresh: boolean;
  onOpen(item: PendingQueueItemDto): void; onAuthorization(requestId: string): void; onPage(offset: number): void;
  plans?: { page: PlanningTodoPageDto | null; pageIndex: number; loading: boolean; error: string | null;
    onOpen(item: PlanningTodoDto): void; onPage(direction: -1 | 1): void };
}
const labels = { approval: "工具审批", question: "模型提问", elicitation: "MCP 确认" };

export function GlobalPending({ model }: { model: GlobalPendingModel }) {
  return <>
    <p className="hint">汇总所有工作区当前的 Runner 请求和网页授权。打开所属页面后核对详情；这里不会直接批准或回答。</p>
    <div role="status" aria-live="polite">{model.loading ? "正在核对最新状态…" : model.error || `当前 Runner 待处理 ${model.total} 项`}</div>
    <h4>任务审批与提问</h4>
    <div className="global-pending-list" aria-busy={model.loading}>
      {model.items.map(item => <button key={item.requestId} type="button" className="global-pending-item" disabled={model.loading || !!model.error} onClick={() => model.onOpen(item)}>
        <span><strong>{labels[item.kind]} · {item.taskId}</strong><small>{item.workspaceLabel} · {item.runnerId}</small></span>
        <span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><small>打开所属计划 →</small></span>
      </button>)}
      {!model.loading && !model.error && !model.items.length && <p className="empty-state">没有当前有效的 Runner 请求。</p>}
    </div>
    {(model.offset > 0 || model.nextOffset !== null) && <nav className="button-row" aria-label="待处理分页">
      <button className="button button-quiet" disabled={model.loading || model.offset === 0} onClick={() => model.onPage(Math.max(0, model.offset - 100))}>上一页</button>
      <span>{model.offset + 1}–{model.offset + model.items.length} / {model.total}</span>
      <button className="button button-quiet" disabled={model.loading || model.nextOffset === null} onClick={() => model.onPage(model.nextOffset!)}>下一页</button>
    </nav>}
    <h4>网页连接授权</h4>
    {!model.authorizationFresh ? <p className="hint">授权状态尚未核实，请刷新；不代表当前没有请求。</p> : model.authorizations.length ?
      <div className="global-pending-list">{model.authorizations.map(item => <button className="global-pending-item" type="button" key={item.requestId} onClick={() => model.onAuthorization(item.requestId)}><strong>{item.label}</strong><span>核对工作区与权限 →</span></button>)}</div> : <p className="empty-state">没有待批准的网页连接。</p>}
    <h4>计划审查、批准与会话恢复</h4>
    {!model.plans ? <p className="hint">当前后台尚未提供计划待办，请在工作区查看。</p> : <>
      <p className="hint" role="status">{model.plans.loading ? "正在按页核对计划状态…" : model.plans.error || `本页已检查 ${model.plans.page?.scanned ?? 0} 个计划；有待办 ${model.plans.page?.items.length ?? 0} 项。列表按工作区分页，并非全部计划总量。`}</p>
      <div className="global-pending-list">{model.plans.page?.items.map(item => <button key={`${item.workspaceId}:${item.planningId}`} type="button" className="global-pending-item" disabled={model.plans!.loading || !!model.plans!.error} onClick={() => model.plans!.onOpen(item)}>
        <span><strong>{item.title}</strong><small>{item.workspaceLabel} · 计划版本 {item.revision}</small></span><span>{item.label}<small>打开所属计划 →</small></span>
      </button>)}</div>
      {model.plans.page?.warnings.map((warning, index) => <p key={index} className="notice notice-warn">{warning.workspaceLabel}：{warning.message}</p>)}
      <nav className="button-row" aria-label="计划待办分页"><button type="button" className="button button-quiet" disabled={model.plans.loading || model.plans.pageIndex === 0} onClick={() => model.plans!.onPage(-1)}>上一页计划</button>
        <button type="button" className="button button-quiet" disabled={model.plans.loading || !model.plans.page?.nextCursor} onClick={() => model.plans!.onPage(1)}>继续检查更多计划</button></nav>
    </>}
    <p className="hint">所有处理都在所属页面核对后提交；侧栏数量只统计实时请求，不把计划待办或历史记录冒充当前审批。</p>
  </>;
}
