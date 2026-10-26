// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AttemptMessagesModel } from "../src/api-client-contracts.js";
import { AttemptMessages } from "../src/attempt-messages-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptMessagesModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptMessages, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders messages in supplied order and highlights conclusions without interpreting HTML", () => {
  const mounted = mount({ messages: [
    { messageId: "latest", title: "2. 最新回复 · 最终结论", text: "完成结论：接口通过\n```text\n错误：这是代码示例\n```\n失败原因：命令未找到" },
    { messageId: "older", title: "1. 接收记录", text: "阶段性进度" },
  ], emptyMessage: "尚无回复" });
  const cards = [...mounted.querySelectorAll<HTMLElement>(".attempt-message")];
  expect(cards.map(card => card.dataset.messageId)).toEqual(["latest", "older"]);
  expect(cards[0]?.querySelector("strong")?.textContent).toContain("最终结论");
  expect(cards[0]?.querySelector(".reply-success")?.textContent).toBe("完成结论：接口通过");
  expect(cards[0]?.querySelector(".reply-error")?.textContent).toBe("失败原因：命令未找到");
  expect(cards[0]?.querySelector("img,script")).toBeNull();
  expect(cards[0]?.querySelectorAll(".reply-verdict")).toHaveLength(2);
});

it("renders the empty-record explanation when there are no model messages", () => {
  const mounted = mount({ messages: [], emptyMessage: "尚无模型正文；可展开工具活动或原始事件查看。" });
  expect(mounted.querySelector(".empty-state")?.textContent).toContain("尚无模型正文");
  expect(mounted.querySelector(".attempt-message")).toBeNull();
});
