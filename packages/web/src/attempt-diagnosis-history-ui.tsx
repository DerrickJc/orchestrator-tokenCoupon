import type { AttemptDiagnosisHistoryModel } from "./api-client-contracts.js";

const verdictLine = /^\s*(?:#{1,6}\s*|[-*]\s*|\*\*)?(?:完成结论|验证结果|测试结果|中止结论|错误|失败原因|取消原因|任务失败|Error:|FAIL\b)/i;
const errorLine = /错误|失败|中止|取消|Error:|FAIL\b/i;

function HighlightedReply({ text }: { text: string }) {
  let fenced = false;
  return <>{text.split("\n").map((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const verdict = !fenced && verdictLine.test(line);
    return <span key={index}>{verdict ? <span className={`reply-verdict ${errorLine.test(line) ? "reply-error" : "reply-success"}`}>{line}</span> : line}{"\n"}</span>;
  })}</>;
}

export function AttemptDiagnosisHistory({ model }: { model: AttemptDiagnosisHistoryModel }) {
  return <>
    {model.messages.map(message => <article key={message.messageId} className={`diagnosis-chat-message is-${message.role === "user" ? "user" : "assistant"}`}>
      <small>{message.heading}</small>
      <div className="diagnosis-chat-body"><HighlightedReply text={message.content} /></div>
    </article>)}
    {model.showEmptyMessage && <p className="diagnosis-chat-empty">{model.emptyMessage}</p>}
    {model.pendingMessage && <article className="diagnosis-chat-message is-user"><small>你</small><div className="diagnosis-chat-body">{model.pendingMessage}</div></article>}
    {model.errorMessage && <p className="field-error">{model.errorMessage}</p>}
    {model.running && <p className="diagnosis-chat-pending">正在分析…</p>}
  </>;
}
