import type { TaskResultFileView, TaskResultsModel } from "./api-client-contracts.js";

export function TaskResultsDialogContent({ model, callbacks }: {
  model: TaskResultsModel;
  callbacks: {
    onPreview: (path: string) => void;
    onCopyPath: (file: TaskResultFileView) => void;
    onLoadMore: () => void;
  };
}) {
  const visibleFiles = model.files.slice(0, 3);
  const overflowFiles = model.files.slice(3);
  const renderFile = (file: TaskResultFileView) => <article className="task-result-file" key={file.path}>
    <code title={file.path}>{file.absolutePath}</code>
    <button type="button" className="text-button" onClick={() => callbacks.onPreview(file.path)}>预览 {file.path}</button>
    <button type="button" className="text-button" onClick={() => callbacks.onCopyPath(file)}>复制路径</button>
  </article>;

  return <>
    <p id="task-results-summary" className="hint" role="status">{model.summary}</p>
    <div id="task-results-files">
      {visibleFiles.map(renderFile)}
      {overflowFiles.length > 0 && <details className="task-results-overflow foldout">
        <summary>展开其余 {overflowFiles.length} 个文件</summary>
        {overflowFiles.map(renderFile)}
      </details>}
    </div>
    <button id="task-results-more" type="button" className={`button button-quiet${model.hasMore ? "" : " hidden"}`} disabled={model.loadingMore} onClick={callbacks.onLoadMore}>{model.loadingMore ? "正在加载…" : "加载更多文件"}</button>
    <section id="task-results-preview-wrap" className={model.preview ? "" : "hidden"}>
      <h4 id="task-results-path">{model.preview?.absolutePath || ""}</h4>
      <pre id="task-results-preview">{model.preview?.content || ""}</pre>
    </section>
    <p id="task-results-error" className="field-error" role="status">{model.error}</p>
  </>;
}
