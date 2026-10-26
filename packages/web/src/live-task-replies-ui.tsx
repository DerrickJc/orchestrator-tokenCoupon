import type { LiveTaskReplyCard, LiveTaskRepliesModel } from "./api-client-contracts.js";

function ReplyCard({ card }: { card: LiveTaskReplyCard }) {
  return (
    <article className="live-task-reply" data-attempt-id={card.attemptId}>
      <strong>{card.heading}</strong>
      {card.error && <p className="reply-verdict reply-error">{card.error}</p>}
      <p>{card.reply}</p>
      <p className="hint">{card.activity}</p>
      {card.showDiagnosis && <button type="button" className="button button-quiet" onClick={card.onDiagnose}>分析原因</button>}
    </article>
  );
}

export function LiveTaskReplies({ model }: { model: LiveTaskRepliesModel }) {
  return (
    <>
      {model.visible.map(card => <ReplyCard card={card} key={card.attemptId} />)}
      {model.overflow.length > 0 && (
        <details className="live-replies-overflow foldout">
          <summary>{model.overflowLabel}</summary>
          {model.overflow.map(card => <ReplyCard card={card} key={card.attemptId} />)}
        </details>
      )}
    </>
  );
}
