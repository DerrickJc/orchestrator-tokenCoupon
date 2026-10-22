// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { act } from "react";
import { expect, it, vi } from "vitest";

it("uses the real React bridges while switching Attempts, typing a custom model and refreshing catalogs", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.innerHTML = await readFile(join(process.cwd(), "packages/web/public/index.html"), "utf8");
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const requests: string[] = [];
  globalThis.tokenCouponClient = {
    async api(path) {
      requests.push(path);
      if (path.includes("/attempts/")) {
        const id = path.includes("/attempts/first/") ? "first" : "second";
        return { taskId: id, attempt: { attemptId: id, runnerId: "codex", status: "succeeded", exitCode: 0 }, fileId: id, cursor: 2, hasMore: false, events: [
          { sequence: 1, type: "message.completed", payload: { messageId: `${id}-message`, text: `${id} 回复` } },
          { sequence: 2, type: "tool.completed", payload: { summary: `${id} 工具活动` } },
        ] };
      }
      return { models: [{ id: "fast", label: "Fast" }], customAllowed: true };
    },
    openEventStream: vi.fn(),
  };
  await import("../src/attempt-messages.js");
  await import("../src/attempt-tools.js");
  await import("../src/runtime-model-controls.js");
  await import("../src/model-catalog-status.js");
  const script = (await readFile(join(process.cwd(), "packages/web/public/app.js"), "utf8")).replace("void init();", "");
  const app = new Function("setInterval", script + "\nreturn { state, selectAttempt, renderRuntimeModelControls }; ")(() => 0);
  const state = app.state;
  state.workspace = { workspaceId: "workspace", label: "项目" };
  state.planning = { planningId: "plan", config: { provider: "mock" } };
  state.attemptChoices = ["first", "second"].map(attemptId => ({ attemptId, label: attemptId }));
  state.attemptSelection = { selectedAttemptId: "first", mode: "history" };
  await act(async () => { await app.selectAttempt(); });
  expect(document.getElementById("attempt-messages")?.textContent).toContain("first 回复");
  expect(document.getElementById("attempt-tools")?.textContent).toContain("first 工具活动");
  state.attemptSelection.selectedAttemptId = "second";
  await act(async () => { await app.selectAttempt(); });
  expect(document.getElementById("attempt-messages")?.textContent).toContain("second 回复");
  expect(document.getElementById("attempt-messages")?.textContent).not.toContain("first 回复");
  expect(document.getElementById("attempt-tools")?.textContent).toContain("second 工具活动");

  state.runtimeModelCandidates = [{ taskId: "task", title: "任务" }];
  state.runtimeModelTaskId = "task";
  state.runtimeModelChoices = [{ id: "__custom__", label: "自定义模型" }];
  state.runtimeModelChoice = "__custom__";
  act(() => app.renderRuntimeModelControls());
  const input = document.getElementById("runtime-model-custom") as HTMLInputElement;
  for (const value of ["g", "gpt", "gpt-local"]) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe(value);
    expect(state.runtimeModelCustomValue).toBe(value);
  }

  (document.getElementById("runner-id") as HTMLSelectElement).replaceChildren(new Option("Codex", "codex"));
  (document.getElementById("planner-provider") as HTMLSelectElement).replaceChildren(new Option("DeepSeek", "deepseek-api"));
  await act(async () => { document.getElementById("refresh-models")?.click(); });
  expect(requests).toContain("/api/v1/runners/codex/models?workspaceId=workspace&refresh=1");
  expect(requests).toContain("/api/v1/providers/deepseek-api/models?refresh=1");
  expect((document.getElementById("refresh-models") as HTMLButtonElement).disabled).toBe(false);
  expect(document.getElementById("runner-model-hint")?.textContent).toContain("候选模型");
});
