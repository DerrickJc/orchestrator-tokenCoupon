// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptRawEventsModel } from "../src/api-client-contracts.js";
import { AttemptRawEvents } from "../src/attempt-raw-events-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(model: AttemptRawEventsModel) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptRawEvents, { model, onFilter: () => undefined, onPrevious: () => undefined, onNext: () => undefined })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders filtered raw event lines as text in the supplied page order", () => {
  const mounted = mount({ lines: ['{"sequence":16,"type":"command.completed"}', '{"sequence":17,"type":"runner.output"}'], filterValue: "stderr", pageLabel: "第 2 / 2 页", previousDisabled: false, nextDisabled: true });
  expect(mounted.querySelector("#attempt-raw")?.textContent).toBe('{"sequence":16,"type":"command.completed"}\n{"sequence":17,"type":"runner.output"}\n');
  expect(mounted.querySelector<HTMLInputElement>("#attempt-event-filter")?.value).toBe("stderr");
  expect(mounted.querySelector("#attempt-raw-page")?.textContent).toBe("第 2 / 2 页");
  expect(mounted.querySelector<HTMLButtonElement>("#attempt-raw-prev")?.disabled).toBe(false);
  expect(mounted.querySelector<HTMLButtonElement>("#attempt-raw-next")?.disabled).toBe(true);
  expect(mounted.querySelector("script,img")).toBeNull();
});

it("renders an empty raw event page without extra text", () => {
  const mounted = mount({ lines: [], filterValue: "", pageLabel: "第 1 / 1 页", previousDisabled: true, nextDisabled: true });
  expect(mounted.querySelector("#attempt-raw")?.textContent).toBe("");
});

it("routes raw-event filtering and pagination actions to the application callbacks", () => {
  const onFilter = vi.fn(), onPrevious = vi.fn(), onNext = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root?.render(createElement(AttemptRawEvents, {
    model: { lines: [], filterValue: "", pageLabel: "第 2 / 3 页", previousDisabled: false, nextDisabled: false }, onFilter, onPrevious, onNext,
  })));
  const input = host.querySelector<HTMLInputElement>("#attempt-event-filter")!;
  const setValue = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!;
  act(() => { setValue.call(input, "stderr"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => host!.querySelector<HTMLButtonElement>("#attempt-raw-prev")!.click());
  act(() => host!.querySelector<HTMLButtonElement>("#attempt-raw-next")!.click());
  expect(onFilter).toHaveBeenCalledWith("stderr");
  expect(onPrevious).toHaveBeenCalledOnce();
  expect(onNext).toHaveBeenCalledOnce();
});
