import type { ModelCatalogKind, ModelCatalogStatusModel } from "./api-client-contracts.js";

export function ModelCatalogStatus({ kind, model }: {
  kind: ModelCatalogKind;
  model: ModelCatalogStatusModel;
}) {
  const status = <span id={`${kind}-model-hint`} className="hint" aria-live="polite" role="status">{model.message}</span>;
  if (kind === "planner") return status;
  return <div className="model-hint-row">
    {status}
    <button id="refresh-models" type="button" className="text-button" disabled={model.loading} onClick={() => document.dispatchEvent(new Event("token-coupon:refresh-models"))}>
      {model.loading ? "正在读取模型…" : "刷新模型列表"}
    </button>
  </div>;
}
