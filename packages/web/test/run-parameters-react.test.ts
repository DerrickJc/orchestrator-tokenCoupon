// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RunParametersModel } from "../src/api-client-contracts.js";
import { RunParameters } from "../src/run-parameters-ui.js";

const testGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mount(model: RunParametersModel, onChange = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  act(() => root.render(createElement(RunParameters, { model, onChange })));
  return { host, root, onChange };
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount()); roots = [];
  for (const host of hosts) host.remove(); hosts = [];
});

const model: RunParametersModel = {
  parallelOptions: [{ id: "1", label: "1 个任务" }, { id: "2", label: "2 个任务" }], selectedParallel: "1",
  isolationOptions: [{ id: "git-worktree", label: "独立 Git worktree" }, { id: "shared", label: "共享工作区（串行）" }], selectedIsolation: "git-worktree",
  verificationOptions: [{ id: "verify", label: "最终验证 · verify" }], selectedVerification: "verify", showVerification: true,
};

it("renders the run-parameter selectors and reports each changed field", () => {
  const { host, onChange } = mount(model);
  const isolation = host.querySelector<HTMLSelectElement>("#run-isolation")!;
  act(() => {
    isolation.value = "shared";
    isolation.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("isolation", "shared");
  expect(host.querySelector<HTMLSelectElement>("#run-verification")?.value).toBe("verify");
});

it("syncs persisted parameters and verification candidates from the application", () => {
  const { host, root } = mount(model);
  const next: RunParametersModel = { ...model, selectedParallel: "2", selectedIsolation: "shared", verificationOptions: [{ id: "", label: "没有合法验证任务" }], selectedVerification: "", showVerification: false };
  act(() => root.render(createElement(RunParameters, { model: next, onChange: vi.fn() })));
  expect(host.querySelector<HTMLSelectElement>("#run-parallel")?.value).toBe("2");
  expect(host.querySelector<HTMLSelectElement>("#run-isolation")?.value).toBe("shared");
  expect(host.querySelector<HTMLSelectElement>("#run-verification")?.options[0]?.textContent).toContain("没有合法验证任务");
  expect(host.querySelector("#run-verification-wrap")?.classList.contains("hidden")).toBe(true);
});
