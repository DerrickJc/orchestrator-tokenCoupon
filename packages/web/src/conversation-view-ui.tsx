import type { ConversationViewModel } from "./api-client-contracts.js";

export function ConversationView({ model }: { model: ConversationViewModel }) {
  return (
    <>
      <div className="section-title">
        <div><span className="eyebrow">CONVERSATION</span><h3>需求与澄清</h3></div>
        <span id="turn-count" className="count-pill">{model.count} 条</span>
      </div>
      <div id="conversation" className="conversation">
        {model.messages.length
          ? model.messages.map(message => (
            <article className={`message ${message.roleClass}`} key={message.messageId}>
              <div className="message-label">{message.label}</div>
              <div>{message.content}</div>
            </article>
          ))
          : <div className="empty-state">本轮还没有对话内容。</div>}
      </div>
    </>
  );
}
