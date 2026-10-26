export function AttemptDiagnosisChoice({ onClose, onLocal, onWeb }: { onClose(): void; onLocal(): void; onWeb(): void }) {
  return <>
    <div className="section-title"><h3>选择分析方式</h3><button type="button" data-diagnosis-close className="text-button" onClick={onClose}>关闭</button></div>
    <div className="diagnosis-options">
      <button id="diagnosis-local" className="diagnosis-option" type="button" onClick={onLocal}>
        <strong>在此页面分析</strong><span>与 Codex 或 Claude Code 继续对话，可在下方选择模型。</span><small>会使用所选模型的调用额度</small>
      </button>
      <button id="diagnosis-web" className="diagnosis-option" type="button" onClick={onWeb}>
        <strong>复制提示到网页分析</strong><span>把证据保存在工作区，通过已连接的 GPT／Claude 网页读取分析。</span><small>使用网页额度，节省执行模型的诊断调用</small>
      </button>
    </div>
  </>;
}
