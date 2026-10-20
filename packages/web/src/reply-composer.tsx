import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReplyComposerBridge } from "./api-client-contracts.js";
import { SubmitTextarea } from "./planner-request-composer-ui.js";

const host = document.getElementById("reply-composer-root");
const source = document.getElementById("reply-text") as HTMLTextAreaElement | null;

if (host && source) {
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SubmitTextarea, {
    id: "reply-composer-input",
    className: "reply-composer-input",
    rows: 2,
    maxLength: 8192,
    placeholder: "回答澄清问题，或补充需求",
    ariaLabel: "回答澄清问题或补充需求",
    ariaDescribedBy: "reply-shortcuts",
    initialValue: source.value,
    onValueChange(value: string) { source.value = value; },
    onSubmit() { (document.getElementById("reply-form") as HTMLFormElement | null)?.requestSubmit(); },
  })));
  const renderedInput = host.querySelector<HTMLTextAreaElement>("#reply-composer-input");
  if (renderedInput) {
    source.classList.add("hidden");
    const bridge: ReplyComposerBridge = {
      setValue(value) { source.value = value; renderedInput.value = value; },
      setPlaceholder(value) { source.placeholder = value; renderedInput.placeholder = value; },
      setDisabled(value) { source.disabled = value; renderedInput.disabled = value; },
      focus() { renderedInput.focus(); },
    };
    globalThis.tokenCouponReplyComposer = bridge;
  }
}
