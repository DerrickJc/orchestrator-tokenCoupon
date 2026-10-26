import type { AttemptRecordControlsModel } from "./api-client-contracts.js";

export function AttemptRefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh(): void }) {
  return <button id="attempt-refresh" type="button" className="text-button" disabled={loading} onClick={onRefresh}>{loading ? "正在读取…" : "刷新记录"}</button>;
}

export function AttemptLoadMoreButton({ model, onMore }: { model: AttemptRecordControlsModel; onMore(): void }) {
  return <button id="attempt-more" type="button" className={`button button-quiet${model.hasMore ? "" : " hidden"}`} hidden={!model.hasMore} disabled={model.loading} onClick={onMore}>{model.loading ? "正在读取历史记录…" : "继续加载历史记录"}</button>;
}
