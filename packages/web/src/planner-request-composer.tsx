import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlannerRequestComposerBridge } from "./api-client-contracts.js";
import { SubmitTextarea } from "./planner-request-composer-ui.js";

const host = document.getElementById("planner-request-composer-root");
const source = document.getElementById("request-text") as HTMLTextAreaElement | null;

if (host && source) {
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SubmitTextarea, {
    id: "planner-request-input",
    className: "planner-request-input",
    rows: 4,
    maxLength: 8192,
    placeholder: "例如：给现有服务增加课程查询接口，先检查项目约定，再补充测试。",
    ariaLabel: "需求描述",
    ariaDescribedBy: "request-shortcuts",
    initialValue: source.value,
    onValueChange(value) { source.value = value; },
    onSubmit() { document.getElementById("start-planning")?.click(); },
  })));
  const renderedInput = host.querySelector<HTMLTextAreaElement>("#planner-request-input");
  if (renderedInput) {
    source.classList.add("hidden");
    const bridge: PlannerRequestComposerBridge = {
      setValue(value) {
        source.value = value;
        renderedInput.value = value;
      },
      focus() { renderedInput.focus(); },
    };
    globalThis.tokenCouponPlannerRequestComposer = bridge;
  }
}
