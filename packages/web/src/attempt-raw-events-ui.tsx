import { useEffect, useState } from "react";
import type { AttemptRawEventsModel } from "./api-client-contracts.js";

const PAGE_SIZE = 15;

export function AttemptRawEvents({ model, onFilter, onPageChange }: { model: AttemptRawEventsModel; onFilter(value: string): void; onPageChange(page: number): void }) {
  const [filterValue, setFilterValue] = useState(model.filterValue);
  const [page, setPage] = useState(model.initialPage);
  const filter = filterValue.trim();
  const filtered = model.events.filter(event => !filter || event.type.includes(filter) || event.stream === filter);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(page, pages - 1));
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  const lines = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const label = `第 ${currentPage + 1} / ${pages} 页 · 已加载 ${filtered.length} 条${model.hasMore ? "（还有历史待加载）" : ""}`;
  const changeFilter = (value: string) => { setFilterValue(value); setPage(0); onFilter(value); onPageChange(0); };
  const changePage = (nextPage: number) => { setPage(nextPage); onPageChange(nextPage); };

  return <>
    <label>类型筛选<input id="attempt-event-filter" value={filterValue} placeholder="例如 tool.completed 或 stderr" onChange={event => changeFilter(event.currentTarget.value)} /></label>
    <pre id="attempt-raw">{lines.map((event, index) => <span key={`${index}:${event.line}`}>{event.line}{"\n"}</span>)}</pre>
    <nav className="pagination" aria-label="原始事件分页">
      <button id="attempt-raw-prev" type="button" className="button button-quiet" disabled={currentPage === 0} onClick={() => changePage(Math.max(0, currentPage - 1))}>上一页</button>
      <span id="attempt-raw-page" role="status">{label}</span>
      <button id="attempt-raw-next" type="button" className="button button-quiet" disabled={currentPage + 1 >= pages} onClick={() => changePage(Math.min(pages - 1, currentPage + 1))}>下一页</button>
    </nav>
    <p className="hint">原始事件仅用于调试；消息正文显示在上方。更多历史通过继续加载读取。</p>
  </>;
}
