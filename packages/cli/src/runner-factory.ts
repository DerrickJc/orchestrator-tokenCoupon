import { createDefaultRunnerRegistry, InputValidationError, executeTask } from "@token-coupon/core";
import type { RunnerDiagnostics } from "@token-coupon/core";
import type { Runner, RunnerContext, RunnerInput, TaskDefinition, TaskRunnerFactory, TaskRunnerFactoryOptions } from "@token-coupon/core";
import type { RunnerProfile } from "@token-coupon/core";

const registry = createDefaultRunnerRegistry();

export function createTaskRunner(task: TaskDefinition, options: TaskRunnerFactoryOptions): Runner {
  const settings: Record<string, unknown> = { ...(options.runnerSettings ?? {}) };
  if (options.acceptEdits) {
    if (task.execution.runnerId !== "claude-code") throw new InputValidationError("--accept-edits", "仅适用于 claude-code Runner");
    if (settings.permissionMode !== undefined && settings.permissionMode !== "acceptEdits") throw new InputValidationError("--accept-edits", "与 Runner profile 的 permissionMode 冲突");
    settings.permissionMode = "acceptEdits";
  }
  if (options.mockScenario !== undefined) {
    if (task.execution.runnerId !== "mock") throw new InputValidationError("--mock-scenario", "仅适用于 mock Runner");
    settings.mockScenario = options.mockScenario;
  }
  try {
    const resolution = registry.resolve(task, options.runnerProfile, settings);
    const adapter = resolution.runner;
    return {
      id: adapter.id,
      supportsModel: adapter.supportsModel,
      resolvedSpec: resolution.spec,
      checkAvailable: () => adapter.checkAvailable(),
      ...(adapter.diagnose ? { diagnose: (cwd: string) => adapter.diagnose!(cwd) } : {}),
      run: (input: RunnerInput, context: RunnerContext) => adapter.run(input, context),
    };
  }
  catch (error) {
    if (error instanceof InputValidationError) throw error;
    throw new InputValidationError("task.execution", error instanceof Error ? error.message : String(error));
  }
}

export const defaultTaskRunnerFactory: TaskRunnerFactory = createTaskRunner;

export function validateCliRunnerProfile(profile: RunnerProfile): void {
  registry.assertProfile(profile);
}

export function listRegisteredRunners() {
  return registry.list();
}

export async function diagnoseRegisteredRunners(runnerId?: string, cwd = process.cwd()): Promise<Array<{ id: string; mode: string; available: boolean; error?: string; diagnostics?: RunnerDiagnostics }>> {
  const results: Array<{ id: string; mode: string; available: boolean; error?: string; diagnostics?: RunnerDiagnostics }> = [];
  const registrations = registry.list();
  if (runnerId && !registrations.some((registration) => registration.id === runnerId)) {
    throw new InputValidationError("--runner", `未知 Runner：${runnerId}`);
  }
  for (const registration of registrations.filter((item) => runnerId === undefined || item.id === runnerId)) {
    for (const mode of registration.supportedModes) {
      const task: TaskDefinition = { schemaVersion: 1, id: "runner-doctor", title: "Runner doctor", prompt: "Check runner availability without running a task.", execution: { runnerId: registration.id, mode } };
      const runner = registry.resolve(task).runner;
      try {
        await runner.checkAvailable();
        const diagnostics = await runner.diagnose?.(cwd);
        results.push({ id: registration.id, mode, available: true, ...(diagnostics ? { diagnostics } : {}) });
      } catch (error) {
        results.push({ id: registration.id, mode, available: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

export async function probeRegisteredRunner(runnerId: string, workspace: string, signal: AbortSignal, modelId?: string): Promise<Awaited<ReturnType<typeof executeTask>>> {
  const task: TaskDefinition = { schemaVersion: 1, id: "runner-inference-probe", title: "Runner inference probe",
    prompt: "Reply with PROBE_OK. Do not invoke tools, ask questions, run commands or edit files. Then follow the completion requirements below.",
    execution: { runnerId, mode: "managed", ...(modelId ? { modelId } : {}) } };
  const runner = createTaskRunner(task, { ...(runnerId === "codex" ? { runnerSettings: { sandbox: "read-only" } } : {}) });
  await runner.checkAvailable();
  return executeTask({ task, cwd: workspace, runner, signal, onInteraction: async () => { throw new Error("模型连接探针禁止工具调用和人工交互"); } });
}
