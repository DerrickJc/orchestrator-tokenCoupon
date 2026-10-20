import type { AttemptToolsModel } from "./api-client-contracts.js";

function ToolEvent({ eventKey, summary, text, isError, open }: AttemptToolsModel["tools"][number] & { open: boolean }) {
  return (
    <details className={`foldout${isError ? " activity-error" : ""}`} data-event-key={eventKey} open={open}>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  );
}

export function AttemptTools({ model }: { model: AttemptToolsModel }) {
  const openKeys = new Set(model.openEventKeys);
  return <>{model.tools.map(tool => <ToolEvent key={tool.eventKey} {...tool} open={openKeys.has(tool.eventKey)} />)}</>;
}
