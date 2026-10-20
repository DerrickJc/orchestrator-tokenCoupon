export function TaskDependencyDialog() {
  return <div className="dag-dialog-content">
    <div className="section-title"><h3 id="dag-title">任务依赖图</h3><button id="dag-close" type="button" className="button button-quiet">关闭</button></div>
    <div className="dag-toolbar">
      <button id="dag-zoom-out" type="button" className="button button-quiet" aria-label="缩小依赖图">−</button>
      <span id="dag-zoom-value">100%</span>
      <button id="dag-zoom-in" type="button" className="button button-quiet" aria-label="放大依赖图">＋</button>
      <button id="dag-fit" type="button" className="button button-quiet">适应窗口</button>
      <button id="dag-reset" type="button" className="button button-quiet">原始大小</button>
      <button id="dag-current" type="button" className="button button-quiet">定位运行任务</button>
      <label className="dag-focus-label">聚焦任务<select id="dag-focus" aria-label="聚焦任务"></select></label>
      <button id="dag-expand" type="button" className="button button-quiet">展开一层</button>
      <button id="dag-collapse" type="button" className="button button-quiet">收起远端</button>
    </div>
    <p id="dag-scope" className="hint" role="status"></p>
    <div className="dag-legend"><span className="dag-incoming">● 前置任务 → 当前任务</span><span className="dag-outgoing">◆ 当前任务 → 后续任务</span><span>分支连线按来源配色 · ✓ 已完成 · ◉ 运行中 · ! 错误／中断 · ○ 未开始</span></div>
    <div id="dag-viewport" className="dag-viewport" tabIndex={0}></div>
  </div>;
}
