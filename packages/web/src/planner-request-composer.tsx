import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlannerRequestComposerBridge } from "./api-client-contracts.js";
import { PlannerRequestComposer } from "./planner-request-composer-ui.js";

const host = document.getElementById("planner-request-composer-root");
const source = document.getElementById("request-text") as HTMLTextAreaElement | null;

if (host && source) {
  const root = createRoot(host);
  flushSync(() => root.render(createElement(PlannerRequestComposer, {
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
