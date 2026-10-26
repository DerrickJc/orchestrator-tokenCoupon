import type { AttemptToolsPaginationModel } from "./api-client-contracts.js";

export function AttemptToolsPagination({ model, onPrevious, onNext }: {
  model: AttemptToolsPaginationModel;
  onPrevious(): void;
  onNext(): void;
}) {
  return <nav className="pagination" aria-label="工具活动分页">
    <button id="attempt-tools-prev" type="button" className="button button-quiet" disabled={model.previousDisabled} onClick={onPrevious}>上一页</button>
    <span id="attempt-tools-page" role="status">{model.pageLabel}</span>
    <button id="attempt-tools-next" type="button" className="button button-quiet" disabled={model.nextDisabled} onClick={onNext}>下一页</button>
  </nav>;
}
