// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AttemptDiagnosisHistoryModel } from "../src/api-client-contracts.js";
import { AttemptDiagnosisHistory } from "../src/attempt-diagnosis-history-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount(model: AttemptDiagnosisHistoryModel) {
  host = document.createElement("section");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptDiagnosisHistory, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders user and assistant diagnosis history with safe text and verdict highlighting", () => {
  const mounted = mount({
    messages: [
      { messageId: "user-1", role: "user", heading: "你", content: "为什么失败？ <img src=x>" },
      { messageId: "assistant-1", role: "assistant", heading: "Codex · gpt-6.1-sol", content: "完成结论：可继续\n```text\n错误：只是示例\n```\n失败原因：测试未通过" },
    ],
    emptyMessage: "从一个问题开始",
    showEmptyMessage: false,
    running: false,
  });
  const messages = [...mounted.querySelectorAll("article.diagnosis-chat-message")];
  expect(messages.map(message => message.classList.contains("is-user") ? "user" : "assistant")).toEqual(["user", "assistant"]);
  expect(messages[0]?.querySelector("img")).toBeNull();
  expect(messages[0]?.textContent).toContain("<img src=x>");
  expect(messages[1]?.querySelector(".reply-success")?.textContent).toBe("完成结论：可继续");
  expect(messages[1]?.querySelector(".reply-error")?.textContent).toBe("失败原因：测试未通过");
  expect(messages[1]?.querySelectorAll(".reply-verdict")).toHaveLength(2);
});

it("renders the empty, pending, error, and running diagnosis states", () => {
  const mounted = mount({ messages: [], emptyMessage: "从一个问题开始", showEmptyMessage: true, pendingMessage: "继续分析一下", errorMessage: "分析未完成：服务错误", running: true });
  expect(mounted.querySelector(".diagnosis-chat-empty")?.textContent).toBe("从一个问题开始");
  expect(mounted.querySelector(".diagnosis-chat-message.is-user")?.textContent).toContain("继续分析一下");
  expect(mounted.querySelector(".field-error")?.textContent).toContain("服务错误");
  expect(mounted.querySelector(".diagnosis-chat-pending")?.textContent).toBe("正在分析…");
});
