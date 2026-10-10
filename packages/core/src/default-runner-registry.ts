import { RunnerRegistry } from "./runner-registry.js";
import type { RunnerRegistration } from "./runner.js";
import { MockRunner } from "./runners/mock-runner.js";
import { ClaudeCodeRunner } from "./runners/claude-runner.js";
import { ClaudeManagedRunner } from "./runners/claude-managed-runner.js";
import { CodexRunner } from "./runners/codex-runner.js";

const MODES = ["non_interactive", "managed"] as const;
const NONE = "unsupported" as const;

export function createDefaultRunnerRegistry(): RunnerRegistry {
  const registry = new RunnerRegistry();
  registry.register({
    id: "mock", adapterVersion: "1", configurationVersion: 1, supportedModes: MODES, supportsModel: false,
    capabilities: {
      non_interactive: { structuredEvents: "supported", userInput: NONE, toolApproval: NONE, cancellation: "supported", reportedModel: NONE },
      managed: { structuredEvents: "supported", userInput: NONE, toolApproval: NONE, cancellation: "supported", reportedModel: NONE },
    },
    validateSettings: (settings, version) => {
      requireVersion(version, 1, "Mock");
      exactSettings(settings, ["mockScenario"], "Mock");
      const scenario = settings.mockScenario;
      if (scenario !== undefined && (typeof scenario !== "string" || !MOCK_SCENARIOS.has(scenario))) throw new Error("Mock mockScenario 无效");
      return scenario === undefined ? {} : { mockScenario: scenario };
    },
    create: (settings) => new MockRunner(typeof settings.mockScenario === "string" ? settings.mockScenario : "success"),
  });

  registry.register({
    id: "claude-code", adapterVersion: "1", configurationVersion: 1, supportedModes: MODES, supportsModel: true,
    capabilities: {
      non_interactive: { structuredEvents: "supported", userInput: NONE, toolApproval: NONE, cancellation: "supported", reportedModel: "unverified" },
      managed: { structuredEvents: "supported", userInput: "supported", toolApproval: "supported", cancellation: "supported", reportedModel: "unverified" },
    },
    validateSettings: validateClaudeSettings,
    create: (settings, mode) => mode === "managed"
      ? new ClaudeManagedRunner(settings)
      : new ClaudeCodeRunner(settings.permissionMode === "acceptEdits" ? "acceptEdits" : undefined),
  });
  registry.register({
    id: "codex", adapterVersion: "1", configurationVersion: 1, supportedModes: ["managed"], supportsModel: true,
    capabilities: {
      non_interactive: { structuredEvents: "unsupported", userInput: NONE, toolApproval: NONE, cancellation: "unsupported", reportedModel: NONE },
      managed: { structuredEvents: "supported", userInput: "supported", toolApproval: "supported", cancellation: "supported", reportedModel: "unverified" },
    },
    validateSettings: (settings, version) => {
      requireVersion(version, 1, "Codex");
      exactSettings(settings, ["sandbox", "approvalPolicy"], "Codex");
      const sandbox = settings.sandbox ?? "workspace-write";
      const approvalPolicy = settings.approvalPolicy ?? "on-request";
      if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("Codex sandbox 只允许 read-only 或 workspace-write");
      if (approvalPolicy !== "on-request" && approvalPolicy !== "untrusted") throw new Error("Codex approvalPolicy 只允许 on-request 或 untrusted");
      return { sandbox, approvalPolicy };
    },
    create: (settings) => new CodexRunner(settings as { sandbox: "read-only" | "workspace-write"; approvalPolicy: "on-request" | "untrusted" }),
  });
  return registry;
}

const MOCK_SCENARIOS = new Set(["success", "missing-marker", "marker-nonzero", "old-marker", "stderr-marker", "quoted-marker", "large-output", "hang", "marker-then-hang", "spawn-child"]);

function validateClaudeSettings(settings: Readonly<Record<string, unknown>>, version: number): Readonly<Record<string, unknown>> {
  requireVersion(version, 1, "Claude Code");
  exactSettings(settings, ["permissionMode", "allowedTools", "disallowedTools"], "Claude Code");
  const output: Record<string, unknown> = {};
  if (settings.permissionMode !== undefined) {
    if (!["default", "acceptEdits", "plan", "dontAsk"].includes(String(settings.permissionMode))) throw new Error("Claude Code permissionMode 无效");
    output.permissionMode = settings.permissionMode;
  }
  for (const key of ["allowedTools", "disallowedTools"] as const) {
    const value = settings[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 512)) {
      throw new Error(`Claude Code ${key} 必须是最多 128 项的非空字符串数组`);
    }
    output[key] = [...value];
  }
  return output;
}

function exactSettings(settings: Readonly<Record<string, unknown>>, allowed: string[], runner: string): void {
  const unknown = Object.keys(settings).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${runner} settings 包含未知字段：${unknown}`);
}

function requireVersion(version: number, expected: number, runner: string): void {
  if (version !== expected) throw new Error(`${runner} profile configVersion ${version} 不受支持`);
}
