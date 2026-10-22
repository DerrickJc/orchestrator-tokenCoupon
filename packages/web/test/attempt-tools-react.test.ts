// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AttemptToolsModel } from "../src/api-client-contracts.js";
import { AttemptTools } from "../src/attempt-tools-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptToolsModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptTools, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders tool events as safe foldouts with preserved open and error states", () => {
  const mounted = mount({
    openEventKeys: ["2"],
    tools: [
      { eventKey: "2", summary: "10:00 · command.completed · 退出码 1 · npm test", text: "错误：测试失败\n<img src=x onerror=alert(1)>", isError: true },
      { eventKey: "1", summary: "09:59 · tool.completed · 检查接口", text: "读取结果", isError: false },
    ],
  });
  const events = [...mounted.querySelectorAll<HTMLDetailsElement>("details")];
  expect(events.map(event => event.dataset.eventKey)).toEqual(["2", "1"]);
  expect(events[0]?.open).toBe(true);
  expect(events[0]?.classList.contains("activity-error")).toBe(true);
  expect(events[0]?.querySelector("summary")?.textContent).toContain("退出码 1");
  expect(events[0]?.querySelector("pre")?.textContent).toContain("<img src=x");
  expect(events[0]?.querySelector("img,script")).toBeNull();
  expect(events[1]?.open).toBe(false);
  expect(events[1]?.classList.contains("activity-error")).toBe(false);
});

it("renders an empty activity page without adding a placeholder row", () => {
  const mounted = mount({ tools: [], openEventKeys: [] });
  expect(mounted.querySelector("details")).toBeNull();
});
