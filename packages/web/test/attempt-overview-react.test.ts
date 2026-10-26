// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptOverviewModel } from "../src/api-client-contracts.js";
import { AttemptOverview } from "../src/attempt-overview-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptOverviewModel, onDiagnose = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptOverview, { model, onDiagnose })));
  return { host, onDiagnose };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

const base = (overrides: Partial<AttemptOverviewModel> = {}): AttemptOverviewModel => ({
  state: "Codex / gpt-6.1-sol（Runner 已报告） · 失败 · 退出码 0",
  notice: "日志还有历史内容待加载。",
  outcome: "错误结论：任务失败 · 退出码 0",
  outcomeClass: "badge-error",
  outcomeVisible: true,
  replyHeading: "模型回复",
  diagnoseVisible: true,
  ...overrides,
});

it("renders Attempt status, highlighted outcome and diagnosis action from one view model", () => {
  const onDiagnose = vi.fn();
  const { host } = mount(base(), onDiagnose);
  expect(host.querySelector("#attempt-state")?.textContent).toContain("gpt-6.1-sol");
  expect(host.querySelector("#attempt-notice")?.textContent).toContain("历史内容待加载");
  expect(host.querySelector("#attempt-outcome")?.className).toContain("badge-error");
  expect(host.querySelector("#attempt-outcome")?.textContent).toContain("错误结论");
  expect(host.querySelector<HTMLButtonElement>("#attempt-diagnose")?.className).not.toContain("hidden");
  act(() => host.querySelector<HTMLButtonElement>("#attempt-diagnose")?.click());
  expect(onDiagnose).toHaveBeenCalledOnce();
});

it("hides diagnosis and conclusion when the current Attempt has no such action", () => {
  const { host } = mount(base({
    state: "Claude Code / 实际模型未报告 · 运行中",
    outcome: "",
    outcomeClass: "badge-warning",
    outcomeVisible: false,
    replyHeading: "模型回复 · 接收中",
    diagnoseVisible: false,
  }));
  expect(host.querySelector("#attempt-outcome")?.className).toContain("hidden");
  expect(host.querySelector("#attempt-diagnose")?.className).toContain("hidden");
  expect(host.querySelector("#attempt-reply-heading")?.textContent).toBe("模型回复 · 接收中");
});
