import type { AttemptMessageView, AttemptMessagesModel } from "./api-client-contracts.js";

const verdictLine = /^\s*(?:#{1,6}\s*|[-*]\s*|\*\*)?(?:完成结论|验证结果|测试结果|中止结论|错误|失败原因|取消原因|任务失败|Error:|FAIL\b)/i;
const errorLine = /错误|失败|中止|取消|Error:|FAIL\b/i;

function ReplyText({ text }: { text: string }) {
  let fenced = false;
  return (
    <pre>{text.split("\n").map((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const verdict = !fenced && verdictLine.test(line);
      return <span key={index}>{verdict ? <span className={`reply-verdict ${errorLine.test(line) ? "reply-error" : "reply-success"}`}>{line}</span> : line}{"\n"}</span>;
    })}</pre>
  );
}

function ReplyCard({ message }: { message: AttemptMessageView }) {
  return (
    <article className="attempt-message" data-message-id={message.messageId}>
      <strong>{message.title}</strong>
      <ReplyText text={message.text} />
    </article>
  );
}

export function AttemptMessages({ model }: { model: AttemptMessagesModel }) {
  if (!model.messages.length) return <div className="empty-state">{model.emptyMessage}</div>;
  return <>{model.messages.map(message => <ReplyCard key={message.messageId} message={message} />)}</>;
}
