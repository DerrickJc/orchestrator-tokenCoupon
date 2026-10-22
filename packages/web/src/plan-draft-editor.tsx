import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PlanDraftEditorBridge, PlanDraftEditorPlan } from "./api-client-contracts.js";
import { PlanDraftEditor } from "./plan-draft-editor-ui.js";

type EditorEntry = { root: Root; model: { identity: string; plan: PlanDraftEditorPlan; disabled: boolean }; onChange: (plan: PlanDraftEditorPlan) => void };
const editors = new Map<HTMLElement, EditorEntry>();
const bridge: PlanDraftEditorBridge = {
  render(mount: HTMLElement, model, onChange) {
    let entry = editors.get(mount);
    if (!entry) {
      entry = { root: createRoot(mount), model, onChange };
      editors.set(mount, entry);
    } else { entry.model = model; entry.onChange = onChange; }
    flushSync(() => entry?.root.render(createElement(PlanDraftEditor, { key: model.identity, model, onChange })));
  },
  setDisabled(mount: HTMLElement, disabled: boolean) {
    const entry = editors.get(mount);
    if (!entry || entry.model.disabled === disabled) return;
    entry.model = { ...entry.model, disabled };
    flushSync(() => entry.root.render(createElement(PlanDraftEditor, { key: entry.model.identity, model: entry.model, onChange: entry.onChange })));
  },
  unmount(mount: HTMLElement) {
    const entry = editors.get(mount);
    if (!entry) return;
    entry.root.unmount(); editors.delete(mount);
  },
};

globalThis.tokenCouponPlanDraftEditor = bridge;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const entry of editors.values()) entry.root.unmount();
    editors.clear();
    delete globalThis.tokenCouponPlanDraftEditor;
  });
}
