import type { AttemptSelectionModel } from "./api-client-contracts.js";

export function AttemptSelection({ model, onSelect, onLatest }: {
  model: AttemptSelectionModel;
  onSelect(attemptId: string): void;
  onLatest(): void;
}) {
  return <>
    <label>查看 Attempt
      <select id="attempt-select" value={model.selectedAttemptId} onChange={event => onSelect(event.currentTarget.value)}>
        {!model.choices.length && <option value="">请选择执行记录</option>}
        {model.choices.map(choice => <option key={choice.attemptId} value={choice.attemptId}>{choice.label}</option>)}
      </select>
    </label>
    <div className="attempt-selection-context">
      <p id="attempt-selection-context" className={`hint${model.historical ? " is-history" : ""}`} role="status">{model.contextText}</p>
      <button id="attempt-show-latest" type="button" className="button button-quiet" disabled={model.latestDisabled} onClick={onLatest}>查看最新执行</button>
    </div>
  </>;
}
