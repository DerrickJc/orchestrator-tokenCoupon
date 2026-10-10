import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RunnerRegistry, parsePlan, runPlan, SessionStore } from "../packages/core/dist/index.js";

const stamp = new Date().toISOString().replaceAll(":", "-");
const workspace = resolve("demo-workspace", "phase6-demo", stamp);
const reportPath = join(workspace, "phase6-demo-report.json");
await mkdir(workspace, { recursive: true });

const supported = { structuredEvents: "supported", userInput: "supported", toolApproval: "supported", cancellation: "supported", reportedModel: "supported" };
const unsupported = { structuredEvents: "supported", userInput: "unsupported", toolApproval: "unsupported", cancellation: "supported", reportedModel: "unsupported" };

class SimulatedAgentRunner {
  id = "phase6-demo";
  supportsModel = false;

  async checkAvailable() {}

  async run(input, context) {
    context.onStarted();
    const approval = await context.requestInteraction({
      kind: "approval", title: "Run the requested test command", summary: "The agent wants to run node --test.",
      operation: { kind: "command", command: "node --test" }, decisions: ["allow-once", "deny"],
    });
    assert.equal(approval.kind, "approval");
    assert.equal(approval.decision, "allow-once");

    const answer = await context.requestInteraction({
      kind: "question", title: "Clarify the greeting behavior", summary: "The agent needs one domain answer.",
      questions: [{ id: "empty-name", text: "Should an empty name be allowed?", options: [{ id: "allow", label: "Allow it" }, { id: "reject", label: "Reject it" }] }],
    });
    assert.equal(answer.kind, "question");
    assert.deepEqual(answer.answers[0], { questionId: "empty-name", optionIds: ["allow"] });

    await context.recordEvent?.({ type: "tool.started", toolId: "demo-test", name: "commandExecution", summary: "node --test" });
    await context.recordEvent?.({ type: "tool.completed", toolId: "demo-test", name: "commandExecution", summary: "node --test", exitCode: 0 });
    context.onOutput({ stream: "stdout", text: "Demo task completed.\n" + input.completionMarker + "\n", agentText: "Demo task completed.\n" + input.completionMarker + "\n" });
    return { started: true, exitCode: 0, signal: null, transport: "app-server", nativeOutcome: "completed", cleanupStatus: "completed", reportedModel: "simulated-agent" };
  }
}

const registry = new RunnerRegistry();
registry.register({
  id: "phase6-demo", adapterVersion: "demo-1", configurationVersion: 1, supportedModes: ["managed"], supportsModel: false,
  capabilities: { non_interactive: unsupported, managed: supported },
  validateSettings: (settings) => {
    if (Object.keys(settings).length) throw new Error("The demo adapter accepts no settings.");
    return {};
  },
  create: () => new SimulatedAgentRunner(),
});

const plan = parsePlan({
  schemaVersion: 1, id: "phase6-interaction-demo", title: "Phase 6 Runner interaction demo",
  tasks: [{
    task: { schemaVersion: 1, id: "interactive", title: "Interactive implementation", prompt: "Ask before running a test, then clarify empty-name behavior.",
      execution: { runnerId: "phase6-demo", mode: "managed", requiredCapabilities: ["toolApproval", "userInput"] } },
    dependsOn: [], status: "planned",
  }],
});
const runnerProfile = { schemaVersion: 1, runners: { "phase6-demo": { configVersion: 1, settings: {} } } };
const interactionLog = [];
const result = await runPlan({
  plan, workspace, runnerProfile,
  createRunner: (task, options) => registry.resolve(task, options.runnerProfile).runner,
  onInteraction: async (requestId, request, owner) => {
    interactionLog.push({ requestId, kind: request.kind, title: request.title, taskId: owner.taskId, attemptId: owner.attemptId });
    if (request.kind === "approval") return { kind: "approval", decision: "allow-once" };
    return { kind: "question", answers: [{ questionId: "empty-name", optionIds: ["allow"] }] };
  },
});
assert.equal(result.snapshot.status, "succeeded");
const record = await new SessionStore(workspace).load(result.snapshot.sessionId);
assert.equal(record.snapshot.runnerProfileHash.length, 64);
const attemptId = record.snapshot.tasks[0].attempts[0].attemptId;
const attempt = await new SessionStore(workspace).readAttempt(attemptId);
assert.equal(attempt.runnerSpec.runnerId, "phase6-demo");
assert.equal(interactionLog.length, 2);

const report = {
  schemaVersion: 1, status: "succeeded", workspace, sessionId: result.snapshot.sessionId, attemptId,
  resolvedRunnerSpec: attempt.runnerSpec, runnerProfileHash: record.snapshot.runnerProfileHash,
  interactions: interactionLog,
  checks: [
    "registered a simulated future-agent adapter without adding Runner-ID branches to the orchestrator",
    "routed a one-time tool approval and a native question through the same Attempt owner",
    "persisted the credential-free profile hash and resolved Runner spec",
  ],
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
console.log("Report: " + reportPath);
