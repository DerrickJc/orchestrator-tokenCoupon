// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ConversationViewModel } from "../src/api-client-contracts.js";
import { ConversationView } from "../src/conversation-view-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: ConversationViewModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ConversationView, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders user, Planner, and registered webpage messages with the current count", () => {
  const mounted = mount({
    count: 3,
    messages: [
      { messageId: "u1", roleClass: "user", label: "你", content: "确认默认方案" },
      { messageId: "a1", roleClass: "assistant", label: "Planner", content: "已生成草案" },
      { messageId: "pending", roleClass: "user", label: "你 · 已登记，等待网页", content: "补充一个边界条件" },
    ],
  });
  expect(mounted.querySelector("#turn-count")?.textContent).toBe("3 条");
  expect(mounted.querySelectorAll("#conversation article")).toHaveLength(3);
  expect(mounted.querySelector("#conversation article.assistant .message-label")?.textContent).toBe("Planner");
  expect(mounted.querySelector("#conversation article.user:last-child .message-label")?.textContent).toContain("等待网页");
});

it("renders conversation content as text and gives an explicit empty state", () => {
  const mounted = mount({ count: 1, messages: [{ messageId: "safe", roleClass: "assistant", label: "Planner", content: "<img src=x onerror=alert(1)>" }] });
  expect(mounted.querySelector("img")).toBeNull();
  expect(mounted.querySelector("#conversation")?.textContent).toContain("<img src=x onerror=alert(1)>");
  act(() => root?.render(createElement(ConversationView, { model: { count: 0, messages: [] } })));
  expect(mounted.querySelector("#conversation .empty-state")?.textContent).toBe("本轮还没有对话内容。");
});
