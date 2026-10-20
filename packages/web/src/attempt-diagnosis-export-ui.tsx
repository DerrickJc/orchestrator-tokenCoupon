import type { AttemptDiagnosisExportModel } from "./api-client-contracts.js";

export function AttemptDiagnosisExport({ model, onClose, onCopy, onSwitch }: { model: AttemptDiagnosisExportModel; onClose(): void; onCopy(): void; onSwitch(): void }) {
  return <>
    <div className="section-title"><h3>到网页分析</h3><div className="button-row"><button type="button" className="text-button" onClick={onSwitch}>切换分析方式</button><button type="button" data-diagnosis-close className="text-button" onClick={onClose}>关闭</button></div></div>
    <p id="diagnosis-export-status" role="status">{model.status}</p>
    <label>证据文件<input id="diagnosis-export-path" readOnly value={model.path} /></label>
    <p className="hint">在已连接 Token Coupon MCP 的 GPT／Claude 网页粘贴提示即可读取。网页无法直接访问本机路径；未启用 MCP 时，请上传此文件。此操作不调用本机诊断模型。</p>
    <button id="diagnosis-export-copy" type="button" className="button button-primary" disabled={model.copyDisabled} onClick={onCopy}>{model.copyLabel}</button>
  </>;
}
