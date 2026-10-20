import { useEffect, useRef, useState } from "react";
import type { PendingInteractionGuidanceModel } from "./api-client-contracts.js";

export function PendingInteractionGuidance({ model }: { model: PendingInteractionGuidanceModel }) {
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const editor = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) textarea.current?.focus();
  }, [open]);

  const submit = () => {
    const value = guidance.trim();
    if (!value) {
      model.onInvalid();
      textarea.current?.focus();
      return;
    }
    model.onSubmit(value);
  };

  return (
    <div className="approval-guidance">
      <button
        type="button"
        className="button button-quiet interaction-no"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >NO, tell what to do · 拒绝并指导</button>
      <div className={`guidance-editor${open ? "" : " hidden"}`} ref={editor}>
        <textarea
          ref={textarea}
          maxLength={4096}
          rows={3}
          aria-label="拒绝后的调整指导"
          placeholder="说明应采用的替代方案、临时要求或下一步操作。"
          value={guidance}
          onChange={event => setGuidance(event.currentTarget.value)}
        />
        <p className="hint">
          {model.kind === "elicitation"
            ? "当前 MCP 请求会被拒绝；指导在当前原生轮次结束后交给 Codex，继续同一 Attempt。不会作为表单答案发给 MCP。"
            : "拒绝当前建议并传递调整说明；后续工具请求仍需单独审批。"}
        </p>
        <div className="button-row">
          <button type="button" className="button button-primary" onClick={submit}>拒绝并提交指导</button>
          <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>放弃指导</button>
        </div>
      </div>
    </div>
  );
}
