import type { AttemptRawEventsModel } from "./api-client-contracts.js";

export function AttemptRawEvents({ model }: { model: AttemptRawEventsModel }) {
  return <>{model.lines.map((line, index) => <span key={`${index}:${line}`}>{line}{"\n"}</span>)}</>;
}
