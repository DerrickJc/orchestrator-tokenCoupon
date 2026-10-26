// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AttemptRecordControlsModel } from "../src/api-client-contracts.js";
import { AttemptLoadMoreButton, AttemptRefreshButton } from "../src/attempt-record-controls-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: AttemptRecordControlsModel, onRefresh = vi.fn(), onMore = vi.fn()) {
  const refreshHost = document.createElement("div"), moreHost = document.createElement("div");
  document.body.append(refreshHost, moreHost); hosts.push(refreshHost, moreHost);
  const refreshRoot = createRoot(refreshHost), moreRoot = createRoot(moreHost); roots.push(refreshRoot, moreRoot);
  act(() => {
    refreshRoot.render(createElement(AttemptRefreshButton, { loading: model.loading, onRefresh }));
    moreRoot.render(createElement(AttemptLoadMoreButton, { model, onMore }));
  });
  return { refreshHost, moreHost, onRefresh, onMore };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  for (const host of hosts) host.remove();
  hosts = [];
});

it("shows read-in-progress state and disables both record actions", () => {
  const { refreshHost, moreHost } = mount({ hasMore: true, loading: true });
  expect(refreshHost.querySelector<HTMLButtonElement>("#attempt-refresh")?.textContent).toBe("正在读取…");
  expect(refreshHost.querySelector<HTMLButtonElement>("#attempt-refresh")?.disabled).toBe(true);
  expect(moreHost.querySelector<HTMLButtonElement>("#attempt-more")?.textContent).toBe("正在读取历史记录…");
  expect(moreHost.querySelector<HTMLButtonElement>("#attempt-more")?.disabled).toBe(true);
});

it("hides the load-more action when the event log is complete", () => {
  const { moreHost } = mount({ hasMore: false, loading: false });
  expect(moreHost.querySelector<HTMLButtonElement>("#attempt-more")?.hidden).toBe(true);
});

it("routes refresh and load-more actions to the application callbacks", () => {
  const { refreshHost, moreHost, onRefresh, onMore } = mount({ hasMore: true, loading: false });
  act(() => refreshHost.querySelector<HTMLButtonElement>("#attempt-refresh")!.click());
  act(() => moreHost.querySelector<HTMLButtonElement>("#attempt-more")!.click());
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onMore).toHaveBeenCalledOnce();
});
