// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptRawEventsModel } from "../src/api-client-contracts.js";
import { AttemptRawEvents } from "../src/attempt-raw-events-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("filters raw events, resets pagination, and keeps event content as text", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const events = Array.from({ length: 16 }, (_, index) => ({
    line: JSON.stringify(index === 15 ? { type: "runner.output", payload: { stream: "stderr", text: "<script>alert(1)</script>" } } : { type: "tool.completed", sequence: index + 1 }),
    type: index === 15 ? "runner.output" : "tool.completed",
    ...(index === 15 ? { stream: "stderr" } : {}),
  }));
  const model: AttemptRawEventsModel = { identity: "attempt-a:0", events, filterValue: "", initialPage: 1, hasMore: true };
  const onFilter = vi.fn(), onPageChange = vi.fn();
  act(() => root?.render(createElement(AttemptRawEvents, { model, onFilter, onPageChange })));

  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 2 / 2 页 · 已加载 16 条（还有历史待加载）");
  expect(host.querySelector("#attempt-raw")?.textContent).toContain("stderr");
  expect(host.querySelector("#attempt-raw script")).toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>("#attempt-raw-prev")!.click());
  expect(onPageChange).toHaveBeenLastCalledWith(0);
  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 1 / 2 页");

  const filter = host.querySelector<HTMLInputElement>("#attempt-event-filter")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(filter, "stderr");
  act(() => filter.dispatchEvent(new Event("input", { bubbles: true })));
  expect(onFilter).toHaveBeenLastCalledWith("stderr");
  expect(onPageChange).toHaveBeenLastCalledWith(0);
  expect(host.querySelector("#attempt-raw")?.textContent).toContain("<script>alert(1)</script>");
  expect(host.querySelector("#attempt-raw script")).toBeNull();
  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 1 / 1 页 · 已加载 1 条");
  expect((host.querySelector("#attempt-raw-next") as HTMLButtonElement).disabled).toBe(true);
});

it("renders an empty raw event page with both navigation buttons disabled", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const model: AttemptRawEventsModel = { identity: "attempt-empty:0", events: [], filterValue: "missing", initialPage: 4, hasMore: false };
  act(() => root?.render(createElement(AttemptRawEvents, { model, onFilter: vi.fn(), onPageChange: vi.fn() })));
  expect(host.querySelector("#attempt-raw")?.textContent).toBe("");
  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 1 / 1 页 · 已加载 0 条");
  expect((host.querySelector("#attempt-raw-prev") as HTMLButtonElement).disabled).toBe(true);
  expect((host.querySelector("#attempt-raw-next") as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the current page when the parent refreshes events for the same Attempt", () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const events = Array.from({ length: 16 }, (_, index) => ({ line: `event-${index + 1}`, type: "tool.completed" }));
  const model: AttemptRawEventsModel = { identity: "attempt-refresh:0", events, filterValue: "", initialPage: 0, hasMore: true };
  const onFilter = vi.fn(), onPageChange = vi.fn();
  act(() => root?.render(createElement(AttemptRawEvents, { model, onFilter, onPageChange })));
  act(() => host!.querySelector<HTMLButtonElement>("#attempt-raw-next")!.click());
  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 2 / 2 页");
  act(() => root?.render(createElement(AttemptRawEvents, { model: { ...model, events: [...events, { line: "event-17", type: "tool.completed" }] }, onFilter, onPageChange })));
  expect(host.querySelector("#attempt-raw-page")?.textContent).toContain("第 2 / 2 页 · 已加载 17 条");
  expect(onPageChange).toHaveBeenCalledWith(1);
});
