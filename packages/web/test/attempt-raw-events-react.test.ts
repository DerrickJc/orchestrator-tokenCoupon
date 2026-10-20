// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AttemptRawEventsModel } from "../src/api-client-contracts.js";
import { AttemptRawEvents } from "../src/attempt-raw-events-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLPreElement | undefined;

function mount(model: AttemptRawEventsModel) {
  host = document.createElement("pre");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AttemptRawEvents, { model })));
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

it("renders filtered raw event lines as text in the supplied page order", () => {
  const mounted = mount({ lines: ['{"sequence":16,"type":"command.completed"}', '{"sequence":17,"type":"runner.output"}'] });
  expect(mounted.textContent).toBe('{"sequence":16,"type":"command.completed"}\n{"sequence":17,"type":"runner.output"}\n');
  expect(mounted.querySelector("script,img")).toBeNull();
});

it("renders an empty raw event page without extra text", () => {
  expect(mount({ lines: [] }).textContent).toBe("");
});
