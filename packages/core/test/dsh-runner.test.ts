import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarnessRunner } from "../src/runners/dsh-runner.js";
import { createDefaultRunnerRegistry } from "../src/default-runner-registry.js";
import type { RunnerContext, RunnerInput, RunnerInteractionRequest } from "../src/runner.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("DeepSeek Harness ACP Runner", () => {
  it("is registered as a managed Runner with truthful interactive capabilities", () => {
    const registered = createDefaultRunnerRegistry().list().find((item) => item.id === "dsh");
    expect(registered?.supportedModes).toEqual(["managed"]);
    expect(registered?.capabilities.managed).toMatchObject({
      structuredEvents: "supported", userInput: "unsupported", toolApproval: "supported", cancellation: "supported", reportedModel: "unverified",
    });
  });

  it("selects the requested advertised model, forwards text and grants only the one-shot permission", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-acp-"));
    temporary.push(cwd);
    const executable = await makeFakeDsh(cwd);
    const output: string[] = [];
    const events: unknown[] = [];
    const interactions: RunnerInteractionRequest[] = [];
    const context: RunnerContext = {
      signal: new AbortController().signal,
      onStarted: () => undefined,
      onOutput: (item) => { if (item.text) output.push(item.text); },
      recordEvent: async (event) => { events.push(event); },
      requestInteraction: async (request) => {
        interactions.push(request);
        return { kind: "approval", decision: "allow-once", interactionId: "interaction-1" };
      },
    };
    const result = await new DeepSeekHarnessRunner(executable).run(input(cwd, "model-fast"), context);
    expect(result, JSON.stringify({ result, interactions, events, output })).toMatchObject({ started: true, exitCode: 0, nativeOutcome: "completed", transport: "app-server" });
    expect(output.join("")).toContain("dsh task output");
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ kind: "approval", decisions: ["allow-once", "deny"] });
    expect(events).toContainEqual(expect.objectContaining({ type: "runner.native.finished", outcome: "completed" }));
  });

  it("refuses an unavailable requested model rather than silently using the profile default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-acp-"));
    temporary.push(cwd);
    const executable = await makeFakeDsh(cwd);
    const result = await new DeepSeekHarnessRunner(executable).run(input(cwd, "not-advertised"), {
      signal: new AbortController().signal,
      onStarted: () => undefined,
      onOutput: () => undefined,
    });
    expect(result.started).toBe(false);
    expect(result.nativeOutcome).toBe("failed");
    expect(result.executionError, JSON.stringify(result)).toContain("未提供请求的模型");
  });
});

function input(cwd: string, modelId: string): RunnerInput {
  return {
    attemptId: "4b2a2f1c-e851-46d3-83ac-3994dc52201e",
    cwd,
    task: { schemaVersion: 1, id: "dsh-test", title: "dsh test", prompt: "Complete the task", execution: { runnerId: "dsh", mode: "managed", modelId } },
    execution: { runnerId: "dsh", mode: "managed", modelId },
    prompt: "Complete the task",
    completionMarker: "COMPLETE",
  };
}

async function makeFakeDsh(directory: string): Promise<string> {
  const executable = join(directory, "dsh-fake.py");
  const script = `#!/usr/bin/env python3
import json, sys
prompt_id = None
def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0", "id":msg["id"], "result":{"protocolVersion":1}})
    elif method == "initialized":
        pass
    elif method == "session/new":
        send({"jsonrpc":"2.0", "id":msg["id"], "result":{"sessionId":"session-1", "configOptions":[{"type":"select", "id":"model", "currentValue":"model-default", "options":[{"value":"model-default", "name":"Default"}, {"value":"model-fast", "name":"Fast"}]}]}})
    elif method == "session/set_config_option":
        send({"jsonrpc":"2.0", "id":msg["id"], "result":{"configOptions":[]}})
    elif method == "session/prompt":
        prompt_id = msg["id"]
        send({"jsonrpc":"2.0", "id":"approval-1", "method":"session/request_permission", "params":{"sessionId":"session-1", "title":"Run a command", "description":"Test one-shot approval", "subject":{"type":"command", "command":"node --test", "cwd":sys.argv[0]}, "options":[{"optionId":"allow-once", "name":"Allow once", "kind":"allow_once"}, {"optionId":"reject-once", "name":"Reject", "kind":"reject_once"}]}})
    elif msg.get("id") == "approval-1":
        if msg.get("result", {}).get("outcome", {}).get("optionId") == "allow-once":
            send({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":"session-1", "update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"dsh task output"}}}})
            send({"jsonrpc":"2.0", "id":prompt_id, "result":{"stopReason":"end_turn"}})
        else:
            send({"jsonrpc":"2.0", "id":prompt_id, "result":{"stopReason":"cancelled"}})
    elif method == "session/close":
        send({"jsonrpc":"2.0", "id":msg["id"], "result":{}})
        break
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return executable;
}
