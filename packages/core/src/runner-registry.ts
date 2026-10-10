import { createHash } from "node:crypto";
import type { ExecutionConfig, RequiredRunnerCapability, TaskDefinition } from "./task.js";
import type { ResolvedRunnerSpec, Runner, RunnerProfile, RunnerRegistration } from "./runner.js";

const RUNNER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const FORBIDDEN_SETTING = /(api[-_]?key|secret|password|token|credential)/i;

export interface RunnerResolution {
  runner: Runner;
  spec: ResolvedRunnerSpec;
}

export class RunnerRegistry {
  private readonly registrations = new Map<string, RunnerRegistration>();

  register(registration: RunnerRegistration): void {
    if (!RUNNER_ID.test(registration.id)) throw new Error(`Runner ID 无效：${registration.id}`);
    if (!registration.adapterVersion.trim() || !Number.isSafeInteger(registration.configurationVersion) || registration.configurationVersion < 1) {
      throw new Error(`Runner ${registration.id} 的适配器/配置版本无效`);
    }
    if (this.registrations.has(registration.id)) throw new Error(`Runner 重复注册：${registration.id}`);
    this.registrations.set(registration.id, registration);
  }

  list(): Array<Pick<RunnerRegistration, "id" | "adapterVersion" | "configurationVersion" | "supportedModes" | "capabilities">> {
    return [...this.registrations.values()].map(({ id, adapterVersion, configurationVersion, supportedModes, capabilities }) => ({
      id, adapterVersion, configurationVersion, supportedModes: [...supportedModes], capabilities,
    }));
  }

  resolve(task: TaskDefinition, profile?: RunnerProfile, overrides: Readonly<Record<string, unknown>> = {}): RunnerResolution {
    const id = task.execution.runnerId;
    const registration = this.registrations.get(id);
    if (!registration) throw new Error(`不支持的 Runner：${id}`);
    const mode = task.execution.mode;
    if (!registration.supportedModes.includes(mode)) throw new Error(`Runner ${id} 不支持 ${mode} 模式`);
    if (task.execution.modelId && !registration.supportsModel) throw new Error(`Runner ${id} 不支持 modelId`);

    const entry = profile?.runners[id];
    const version = entry?.configVersion ?? registration.configurationVersion;
    const settings = registration.validateSettings({ ...(entry?.settings ?? {}), ...overrides }, version);
    const capabilities = registration.capabilities[mode];
    const required = [...new Set(task.execution.requiredCapabilities ?? [])];
    assertRequiredCapabilities(id, required, capabilities);

    const normalizedSettings = cloneJsonObject(settings, `Runner ${id} settings`);
    const spec: ResolvedRunnerSpec = Object.freeze({
      runnerId: id,
      adapterVersion: registration.adapterVersion,
      configurationVersion: registration.configurationVersion,
      mode,
      ...(task.execution.modelId === undefined ? {} : { requestedModel: task.execution.modelId }),
      settingsHash: createHash("sha256").update(stableJson(normalizedSettings), "utf8").digest("hex"),
      requiredCapabilities: Object.freeze(required),
      capabilities,
    });
    const adapter = registration.create(normalizedSettings, mode);
    if (adapter.id !== id) throw new Error(`Runner 注册项 ${id} 创建了身份不匹配的实例 ${adapter.id}`);
    const runner: Runner = {
      id: adapter.id,
      supportsModel: adapter.supportsModel,
      resolvedSpec: spec,
      checkAvailable: () => adapter.checkAvailable(),
      ...(adapter.diagnose ? { diagnose: (cwd: string) => adapter.diagnose!(cwd) } : {}),
      run: (input, context) => adapter.run(input, context),
    };
    return { runner, spec };
  }

  assertProfile(profile: RunnerProfile): void {
    for (const id of Object.keys(profile.runners)) {
      const registration = this.registrations.get(id);
      if (!registration) throw new Error(`Runner profile 包含未注册 Runner：${id}`);
      const entry = profile.runners[id]!;
      registration.validateSettings(entry.settings, entry.configVersion);
    }
  }
}

export function parseRunnerProfile(value: unknown): RunnerProfile {
  const root = object(value, "runner profile");
  exactKeys(root, ["schemaVersion", "runners"], "runner profile");
  if (root.schemaVersion !== 1) throw new Error("Runner profile schemaVersion 必须是 1");
  const rawRunners = object(root.runners, "runner profile.runners");
  const runners: Record<string, { configVersion: number; settings: Readonly<Record<string, unknown>> }> = {};
  for (const [id, raw] of Object.entries(rawRunners)) {
    if (!RUNNER_ID.test(id)) throw new Error(`Runner profile ID 无效：${id}`);
    const entry = object(raw, `runner profile.runners.${id}`);
    exactKeys(entry, ["configVersion", "settings"], `runner profile.runners.${id}`);
    if (!Number.isSafeInteger(entry.configVersion) || (entry.configVersion as number) < 1) throw new Error(`Runner ${id} configVersion 无效`);
    const settings = cloneJsonObject(object(entry.settings, `Runner ${id} settings`), `Runner ${id} settings`);
    rejectSecrets(settings, `Runner ${id} settings`);
    runners[id] = { configVersion: entry.configVersion as number, settings };
  }
  return { schemaVersion: 1, runners };
}

export function runnerProfileHash(profile: RunnerProfile): string {
  return createHash("sha256").update(stableJson(profile), "utf8").digest("hex");
}

function assertRequiredCapabilities(id: string, required: RequiredRunnerCapability[], actual: RunnerRegistration["capabilities"][ExecutionConfig["mode"]]): void {
  for (const capability of required) {
    const status = actual[capability];
    if (status !== "supported") throw new Error(`Runner ${id} 的 ${capability} 能力为 ${status}，任务要求 supported`);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path} 包含未知字段：${unknown}`);
}

function cloneJsonObject(value: Record<string, unknown>, path: string): Record<string, unknown> {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("无法序列化");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} 必须只包含有限、可序列化的 JSON 值`);
  }
}

function rejectSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_SETTING.test(key)) throw new Error(`${path}.${key} 不允许保存凭证；请使用 Runner 的环境变量或原生安全存储`);
    rejectSecrets(item, `${path}.${key}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
