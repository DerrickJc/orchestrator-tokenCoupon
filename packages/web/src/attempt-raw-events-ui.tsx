import type { AttemptRawEventsModel } from "./api-client-contracts.js";

export function AttemptRawEvents({ model, onFilter, onPrevious, onNext }: { model: AttemptRawEventsModel; onFilter(value: string): void; onPrevious(): void; onNext(): void }) {
  return <>
    <label>类型筛选<input id="attempt-event-filter" value={model.filterValue} placeholder="例如 tool.completed 或 stderr" onChange={event => onFilter(event.currentTarget.value)} /></label>
    <pre id="attempt-raw">{model.lines.map((line, index) => <span key={`${index}:${line}`}>{line}{"\n"}</span>)}</pre>
    <nav className="pagination" aria-label="原始事件分页">
      <button id="attempt-raw-prev" type="button" className="button button-quiet" disabled={model.previousDisabled} onClick={onPrevious}>上一页</button>
      <span id="attempt-raw-page" role="status">{model.pageLabel}</span>
      <button id="attempt-raw-next" type="button" className="button button-quiet" disabled={model.nextDisabled} onClick={onNext}>下一页</button>
    </nav>
    <p className="hint">原始事件仅用于调试；消息正文显示在上方。更多历史通过继续加载读取。</p>
  </>;
}
