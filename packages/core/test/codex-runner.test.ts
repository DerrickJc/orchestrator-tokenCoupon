import { describe, expect, it } from "vitest";
import { CodexRunner } from "../src/runners/codex-runner.js";
import type { RunnerEvent, RunnerInteractionRequest } from "../src/runner.js";
import type { TaskDefinition } from "../src/task.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTask, validateRunnerInteractionReply } from "../src/execute-task.js";

const task: TaskDefinition = {
  schemaVersion: 1, id: "codex-task", title: "Codex interaction fixture", prompt: "Complete a tiny task",
  execution: { runnerId: "codex", mode: "managed", modelId: "test-model" },
};

describe("CodexRunner app-server transport", () => {
  it("sends execution-role instructions separately and preserves bounded MCP failures without failing a recovered task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-mcp-observation-"));
    try {
      const script = String.raw`
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'){
  fs.writeFileSync('host-instructions.txt',m.params.developerInstructions||'');
  send({id:m.id,result:{thread:{id:'mcp-observation-thread'}}});
 }
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn'}}});
  const item={id:'mcp-call',type:'mcpToolCall',server:'token-coupon',tool:'workspace_query',status:'inProgress',arguments:{token:'argument-private-value'}};
  send({method:'item/started',params:{item}});
  send({method:'item/completed',params:{item:{...item,status:'failed',error:{message:'transport ECONNRESET Bearer credential-value'},result:{content:[{type:'text',text:'result-private-value'}]}}}});
  const marker=m.params.input[0].text.match(/<<<TOKEN_COUPON_DONE:[a-f0-9]+>>>/)[0];
  send({method:'item/agentMessage/delta',params:{itemId:'final',delta:'本地任务已完成\n'+marker+'\n'}});
  send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
 }
});rl.on('close',()=>process.exit());`;
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", script] });
      const result = await executeTask({ task, cwd, runner, onInteraction: async () => { throw new Error("unexpected interaction"); } });
      expect(result.attempt.status).toBe("succeeded");
      const instructions = await readFile(join(cwd, "host-instructions.txt"), "utf8");
      expect(instructions).toContain("你就是编排器已经启动的本机 Runner");
      expect(instructions).toContain(result.attempt.attemptId);
      const events = (await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", payload: expect.objectContaining({ serverName: "token-coupon", toolName: "workspace_query", status: "failed", nativeError: { message: "transport ECONNRESET Bearer [REDACTED]" } }) }));
      expect(events).toContainEqual(expect.objectContaining({ type: "runner.diagnostic", payload: expect.objectContaining({ code: "mcp_tool_failed", severity: "warning", serverName: "token-coupon", toolName: "workspace_query" }) }));
      for (const secret of ["credential-value", "argument-private-value", "result-private-value"]) expect(JSON.stringify(events)).not.toContain(secret);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("routes native questions and one-call approvals, then records the completed turn and cleanup", async () => {
    const script = fakeServerScript();
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", script] });
    const abort = new AbortController();
    const outputs: string[] = [];
    const events: RunnerEvent[] = [];
    const requests: RunnerInteractionRequest[] = [];
    const result = await runner.run({ attemptId: "attempt", cwd: process.cwd(), task, execution: task.execution, prompt: "run <<<TOKEN_COUPON_DONE:abc123>>>" , completionMarker: "<<<TOKEN_COUPON_DONE:abc123>>>" }, {
      signal: abort.signal,
      onStarted() {},
      onOutput(output) { if (output.agentText) outputs.push(output.agentText); if (output.stream === "stderr") outputs.push(output.text); },
      async recordEvent(event) { events.push(event); },
      async requestInteraction(request) {
        requests.push(request);
        if (request.kind === "question") return { kind: "question", answers: [{ questionId: "language", optionIds: ["TypeScript"] }], interactionId: "broker-question" };
        return { kind: "approval", decision: "allow-once", interactionId: "broker-approval" };
      },
    });

    expect(result, JSON.stringify({ result, requests, events, outputs })).toMatchObject({ started: true, transport: "app-server", nativeOutcome: "completed", cleanupStatus: "completed", exitCode: 0 });
    expect(requests.map(({ kind }) => kind)).toEqual(["question", "approval"]);
    expect(requests[0]).toMatchObject({ nativeRequestId: "question-1", questions: [{ id: "language", options: expect.arrayContaining([{ id: "TypeScript", label: "TypeScript" }]) }] });
    expect(requests[1]).toMatchObject({ nativeRequestId: "approval-1", operation: { kind: "command", command: "node --test" } });
    expect(outputs.join("")).toContain("<<<TOKEN_COUPON_DONE:abc123>>>");
    expect(events).toContainEqual({ type: "interaction.forwarded", requestId: "broker-question", evidence: "codex-app-server-user-input" });
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: "broker-approval", evidence: "tool_exit_0" });
    expect(events).toContainEqual(expect.objectContaining({ type: "command.completed", command: "node --test", cwd: process.cwd(), exitCode: 0, status: "succeeded", evidenceSource: "codex-app-server-item" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "command.completed", outputSummary: "2 tests passed" }));
    expect(events).toContainEqual({ type: "runner.native.finished", outcome: "completed" });
  });

  it("delivers denial guidance in a follow-up turn within the same Codex Attempt", async () => {
    const guidance = "Use the dependency already present in package.json; do not install another package.";
    const events: RunnerEvent[] = [];
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", codexGuidanceScript()] });
    const result = await runner.run({ attemptId: "attempt-guidance", cwd: process.cwd(), task, execution: task.execution, prompt: "Complete the task and report marker", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async recordEvent(event) { events.push(event); },
      async requestInteraction(request) {
        expect(request.kind).toBe("approval");
        return { kind: "approval", decision: "deny", guidance, interactionId: "approval-guidance" };
      },
    });
    expect(result).toMatchObject({ started: true, nativeOutcome: "completed", exitCode: 0, cleanupStatus: "completed" });
    expect(events).toContainEqual({ type: "interaction.forwarded", requestId: "approval-guidance", evidence: "codex-app-server-follow-up-turn" });
  });

  it("rejects permission expansion instead of asking the user to grant a broader scope", async () => {
    const script = fakeServerScript("broad");
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", script] });
    const events: RunnerEvent[] = [];
    const requests: RunnerInteractionRequest[] = [];
    const result = await runner.run({ attemptId: "attempt", cwd: process.cwd(), task, execution: task.execution, prompt: "run <<<TOKEN_COUPON_DONE:abc123>>>" , completionMarker: "<<<TOKEN_COUPON_DONE:abc123>>>" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, async recordEvent(event) { events.push(event); },
      async requestInteraction(request) { requests.push(request); return request.kind === "question"
        ? { kind: "question", answers: [{ questionId: "language", optionIds: ["TypeScript"] }], interactionId: "question-only" }
        : { kind: "approval", decision: "allow-once", interactionId: "must-not-be-used" }; },
    });
    expect(result, JSON.stringify({ result, requests, events })).toMatchObject({ nativeOutcome: "completed" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.kind).toBe("question");
    expect(events).toContainEqual(expect.objectContaining({ type: "runner.diagnostic", code: "approval_scope_unsupported" }));
  });

  it("persists the real routing failure, object error details and native identity despite exit code zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-failed-turn-"));
    try {
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", lifecycleServer("failed")] });
      const result = await executeTask({ task, cwd, runner, onInteraction: async () => ({ kind: "approval", decision: "deny" }) });
      expect(result.attempt).toMatchObject({ status: "failed", exitCode: 0, nativeOutcome: "failed", cleanupStatus: "completed",
        nativeThreadId: "real-thread", nativeTurnId: "real-turn", reportedModel: "reported-model",
        nativeError: { message: "workspace routing discovery failed", code: "httpConnectionFailed", httpStatus: 502 } });
      expect(result.attempt.reason).toBe("workspace routing discovery failed");
      const events = (await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({ type: "runner.diagnostic", payload: expect.objectContaining({ willRetry: true, nativeError: expect.objectContaining({ code: "httpConnectionFailed" }) }) }));
      expect(JSON.stringify(events)).not.toContain("credential-value");
      expect(await readFile(join(result.artifactDir, "attempt.json"), "utf8")).not.toContain("credential-value");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("allows a recoverable error to end in a completed turn", async () => {
    const events: RunnerEvent[] = [];
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", lifecycleServer("retry")] });
    const result = await runner.run({ attemptId: "attempt", cwd: process.cwd(), task, execution: task.execution, prompt: "probe", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, requestInteraction: async () => { throw new Error("unexpected interaction"); },
      recordEvent: async (event) => { events.push(event); },
    });
    expect(result).toMatchObject({ nativeOutcome: "completed", cleanupStatus: "completed" });
    expect(result.executionError).toBeUndefined();
    expect(result.nativeError).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: "runner.diagnostic", willRetry: true }));
  });

  it.each(["completed", "active"] as const)("routes native async questions when the original turn is %s", async (mode) => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-async-question-"));
    try {
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", asyncQuestionServer(mode)] });
      const result = await executeTask({ task, cwd, runner, onInteraction: async (_id, request) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(request.questions?.[0]).toMatchObject({ text: "Allow empty names?", options: [{ id: "Allow", label: "Allow" }, { id: "Reject", label: "Reject" }] });
        return { kind: "question", answers: [{ questionId: request.questions![0]!.id, optionIds: ["Allow"] }] };
      } });
      expect(result.attempt).toMatchObject({ status: "succeeded", nativeOutcome: "completed", cleanupStatus: "completed" });
      const events = await readFile(join(result.artifactDir, "events.jsonl"), "utf8");
      expect(events).toContain(mode === "active" ? "codex-app-server-turn-steer" : "codex-app-server-follow-up-turn");
      expect(result.attempt.nativeTurnId).toBe(mode === "active" ? "turn-1" : "turn-2");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("uses the answered follow-up turn's outcome without carrying over the original waiting marker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-biz01-followup-"));
    try {
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", asyncQuestionServer("completed", true)] });
      const result = await executeTask({ task, cwd, runner, onInteraction: async (_id, request) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return { kind: "question", answers: [{ questionId: request.questions![0]!.id, optionIds: ["Allow"] }] };
      } });
      expect(result.attempt).toMatchObject({ status: "succeeded", markerSeen: true, needsInputSeen: false, nativeTurnId: "turn-2" });
      const events = await readFile(join(result.artifactDir, "events.jsonl"), "utf8");
      expect(events).toContain("<<<TOKEN_COUPON_NEEDS_INPUT:");
      expect(events).toContain("<<<TOKEN_COUPON_DONE:");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("accepts a one-call decision without applying a proposed persistent exec policy", async () => {
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", fakeServerScript("suggestion")] });
    const requests: RunnerInteractionRequest[] = [];
    const result = await runner.run({ attemptId: "attempt", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, requestInteraction: async (request) => {
        requests.push(request);
        return request.kind === "question" ? { kind: "question", answers: [{ questionId: "language", optionIds: ["TypeScript"] }], interactionId: "q" }
          : { kind: "approval", decision: "allow-once", interactionId: "a" };
      },
    });
    expect(result).toMatchObject({ nativeOutcome: "completed", exitCode: 0 });
    expect(requests.map((request) => request.kind)).toEqual(["question", "approval"]);
  });

  it("cancels an async question even after the native turn has completed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-async-cancel-"));
    try {
      const controller = new AbortController();
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", asyncQuestionServer("completed")] });
      const result = await executeTask({ task, cwd, runner, signal: controller.signal, onInteraction: async () => {
        setTimeout(() => controller.abort(), 30);
        return new Promise(() => undefined);
      } });
      expect(result.attempt).toMatchObject({ status: "cancelled", nativeOutcome: "cancelled", cleanupStatus: "completed" });
      expect(await readFile(join(result.artifactDir, "events.jsonl"), "utf8")).toContain('"reason":"attempt_cancelled"');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("interrupts the native turn while waiting for a question and expires its persisted request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-cancel-turn-"));
    try {
      const controller = new AbortController();
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", lifecycleServer("question")] });
      const result = await executeTask({ task, cwd, runner, signal: controller.signal, onInteraction: async () => {
        controller.abort();
        return new Promise(() => undefined);
      } });
      expect(result.attempt).toMatchObject({ status: "cancelled", reasonCode: "user_cancelled", nativeOutcome: "cancelled", cleanupStatus: "completed" });
      const events = await readFile(join(result.artifactDir, "events.jsonl"), "utf8");
      expect(events).toContain('"reason":"attempt_cancelled"');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("routes a typed MCP form through the local interaction owner and validates the accepted content", async () => {
    const params = { threadId: "thread-1", turnId: "turn-1", serverName: "school-planner", mode: "form", message: "选择项目设置", requestedSchema: {
      type: "object", properties: {
        language: { type: "string", title: "语言", enum: ["java", "node"], enumNames: ["Java", "Node.js"] },
        workers: { type: "integer", title: "并发数", minimum: 1, maximum: 4, default: 2 },
        enabled: { type: "boolean", title: "启用", default: true },
        scopes: { type: "array", title: "权限", items: { anyOf: [{ const: "read", title: "读取" }, { const: "write", title: "写入" }] }, minItems: 1 },
      }, required: ["language", "workers", "enabled", "scopes"],
    } };
    const requests: RunnerInteractionRequest[] = [], events: RunnerEvent[] = [];
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(params, { action: "accept", content: { language: "node", workers: 3, enabled: true, scopes: ["read", "write"] } })] });
    const result = await runner.run({ attemptId: "elicitation-form", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, async recordEvent(event) { events.push(event); },
      async requestInteraction(request) {
        requests.push(request);
        return { kind: "elicitation", action: "accept", content: { language: "node", workers: 3, enabled: true, scopes: ["read", "write"] }, interactionId: "form-interaction" };
      },
    });
    expect(result).toMatchObject({ nativeOutcome: "completed", cleanupStatus: "completed", exitCode: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "elicitation", elicitation: { mode: "form", serverName: "school-planner", requestedSchema: { required: ["language", "workers", "enabled", "scopes"] } } });
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction.resolved", requestId: "form-interaction", evidence: "codex_mcp_elicitation_accept" }));
    expect(() => validateRunnerInteractionReply(requests[0]!, { kind: "elicitation", action: "accept", content: { language: "invalid" } })).toThrow(/未请求的字段|必填字段/);
  });

  it.each(["accept", "decline", "cancel"] as const)("routes URL elicitation user action %s without failing the Codex turn", async (action) => {
    const params = { threadId: "thread-1", serverName: "school-planner", mode: "url", message: "完成网页登录授权", elicitationId: "opaque-flow-id", url: "https://login.example.test/authorize?code=private-code" };
    const requests: RunnerInteractionRequest[] = [];
    const expected = { action, content: action === "accept" ? null : null };
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(params, expected)] });
    const result = await runner.run({ attemptId: "elicitation-url", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {},
      async requestInteraction(request) {
        requests.push(request);
        return { kind: "elicitation", action, interactionId: "url-interaction" };
      },
    });
    expect(result).toMatchObject({ nativeOutcome: "completed", cleanupStatus: "completed", exitCode: 0 });
    expect(requests[0]).toMatchObject({ kind: "elicitation", elicitation: { mode: "url", serverName: "school-planner", elicitationId: "opaque-flow-id", url: params.url } });
  });

  it.each([
    { mode: "openai/form", requestedSchema: { type: "object", properties: {} } },
    { mode: "form", requestedSchema: { type: "object", properties: { nested: { type: "object", properties: {} } } } },
    { mode: "url", url: "http://login.example.test/authorize", elicitationId: "flow" },
  ])("safely declines unsupported elicitation payloads and allows the native turn to continue", async (patch) => {
    const params = { threadId: "thread-1", serverName: "untrusted-mcp", message: "continue", mode: "form", requestedSchema: { type: "object", properties: {} }, ...patch };
    const events: RunnerEvent[] = [];
    const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(params, { action: "decline", content: null })] });
    const result = await runner.run({ attemptId: "elicitation-unsupported", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
      signal: new AbortController().signal, onStarted() {}, onOutput() {}, async recordEvent(event) { events.push(event); },
      async requestInteraction() { throw new Error("unsupported elicitation must not open a UI prompt"); },
    });
    expect(result).toMatchObject({ nativeOutcome: "completed", cleanupStatus: "completed", exitCode: 0 });
    expect(events).toContainEqual(expect.objectContaining({
      type: "runner.diagnostic", severity: "warning", code: "codex_elicitation_unsupported",
      nativeRequestId: "native-elicitation", serverName: "untrusted-mcp",
    }));
  });

  it("does not persist URL query credentials or accepted elicitation form values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-elicitation-private-"));
    try {
      const params = { threadId: "thread-1", serverName: "private-mcp", mode: "form", message: "Enter project token", requestedSchema: {
        type: "object", properties: { token: { type: "string", title: "Token", default: "default-private-token" } }, required: ["token"],
      } };
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(params, { action: "accept", content: { token: "submitted-private-token" } })] });
      const result = await executeTask({ task, cwd, runner, onInteraction: async () => ({ kind: "elicitation", action: "accept", content: { token: "submitted-private-token" } }) });
      expect(result.attempt.status).toBe("succeeded");
      const requestPath = join(result.artifactDir, "interactions");
      const { readdir } = await import("node:fs/promises");
      const requestName = (await readdir(requestPath)).find((name) => name.endsWith(".json") && !name.includes("responses"))!;
      const responseDirectory = join(requestPath, "responses");
      const responseName = (await readdir(responseDirectory))[0]!;
      const stored = (await readFile(join(requestPath, requestName), "utf8")) + (await readFile(join(responseDirectory, responseName), "utf8"));
      expect(stored).not.toContain("default-private-token");
      expect(stored).not.toContain("submitted-private-token");
      expect(stored).toContain("contentSha256");

      const urlParams = { threadId: "thread-1", serverName: "private-mcp", mode: "url", message: "Complete OAuth", elicitationId: "private-flow", url: "https://login.example.test/authorize?code=private-url-code" };
      const urlRunner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(urlParams, { action: "accept", content: null })] });
      const urlResult = await executeTask({ task, cwd, runner: urlRunner, onInteraction: async () => ({ kind: "elicitation", action: "accept", interactionId: "url" }) });
      const urlInteractionDirectory = join(urlResult.artifactDir, "interactions");
      const urlRequestName = (await readdir(urlInteractionDirectory)).find((name) => name.endsWith(".json") && !name.includes("responses"))!;
      const urlStored = await readFile(join(urlInteractionDirectory, urlRequestName), "utf8");
      expect(urlStored).not.toContain("private-url-code");
      expect(urlStored).toContain("?redacted");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("responds cancel to a pending MCP elicitation before interrupting the Codex turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-elicitation-cancel-"));
    try {
      const controller = new AbortController();
      const params = { threadId: "thread-1", serverName: "school-planner", mode: "url", message: "Complete login", elicitationId: "flow", url: "https://login.example.test/" };
      const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer(params, { action: "cancel", content: null }, true)] });
      const result = await executeTask({ task, cwd, runner, signal: controller.signal, onInteraction: async (_id, request) => {
        expect(request.kind).toBe("elicitation");
        setTimeout(() => controller.abort(), 25);
        return new Promise(() => undefined);
      } });
      expect(result.attempt).toMatchObject({ status: "cancelled", reasonCode: "user_cancelled", nativeOutcome: "cancelled" });
      const events = await readFile(join(result.artifactDir, "events.jsonl"), "utf8");
      expect(events).toContain('"reason":"attempt_cancelled"');
      expect(events).toContain('"code":"codex_elicitation_cancelled"');
      expect(JSON.parse(await readFile(join(cwd, "elicitation-reply.json"), "utf8"))).toMatchObject({ action: "cancel", content: null });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

function lifecycleServer(scenario: "failed" | "retry" | "question"): string {
  return String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'real-thread'},model:'reported-model',modelProvider:'test-provider'}});
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'real-turn'}}});
  const error={message:'workspace routing discovery failed',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:502}},additionalDetails:'Authorization: Bearer credential-value'};
  if(${JSON.stringify(scenario)}==='question')send({id:'q',method:'item/tool/requestUserInput',params:{questions:[{id:'choice',question:'Continue?',options:[{label:'Yes'}]}]}});
  else {
   send({method:'error',params:{threadId:'real-thread',turnId:'real-turn',willRetry:true,error}});
   send({method:'turn/completed',params:{turn:{id:'real-turn',status:${JSON.stringify(scenario)}==='failed'?'failed':'completed',error:${JSON.stringify(scenario)}==='failed'?error:null}}});
  }
 }
 if(m.method==='turn/interrupt'){
  send({id:m.id,result:{}});
  send({method:'turn/completed',params:{turn:{id:'real-turn',status:'interrupted'}}});
 }
});rl.on('close',()=>process.exit());`;
}

function fakeServerScript(approvalMode: "once" | "broad" | "suggestion" = "once", expectedQuestionAnswer = "TypeScript"): string {
  return String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\n');
const pending=new Map();
rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}
  if(m.method==='initialize'){send({jsonrpc:'2.0',id:m.id,result:{}});return}
  if(m.method==='thread/start'){send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'thread-1'}}});return}
  if(m.method==='turn/start'){
    send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn-1'}}});
    setTimeout(()=>send({jsonrpc:'2.0',id:'question-1',method:'item/tool/requestUserInput',params:{isBlocking:true,itemId:'question-item',threadId:'thread-1',turnId:'turn-1',questions:[{id:'language',header:'Language',question:'Which language?',options:[{label:'TypeScript',description:'typed'},{label:'JavaScript',description:'plain'}]}]}}),5);
    return;
  }
  if(m.id==='question-1'){
    if(m.result?.answers?.language?.answers?.[0]!==${JSON.stringify(expectedQuestionAnswer)})process.exitCode=31;
    send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',completedAtMs:1,item:{id:'question-item',type:'dynamicToolCall',name:'request_user_input'}}});
    setTimeout(()=>send({jsonrpc:'2.0',id:'approval-1',method:'item/commandExecution/requestApproval',params:{itemId:'command-item',threadId:'thread-1',turnId:'turn-1',startedAtMs:1,command:'node --test',cwd:'${process.cwd()}',reason:'Run tests',additionalPermissions:${approvalMode === "broad" ? "{fileSystem:{write:['/tmp']}}" : "null"},proposedExecpolicyAmendment:${approvalMode === "suggestion" ? "['node','--test']" : "null"},proposedNetworkPolicyAmendments:null}}),5);
    return;
  }
  if(m.id==='approval-1'){
    if(${approvalMode !== "broad"} && m.result?.decision!=='accept')process.exitCode=32;
    if(${approvalMode === "broad"} && m.result?.decision!=='decline')process.exitCode=33;
    send({jsonrpc:'2.0',method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',startedAtMs:2,item:{id:'command-item',type:'commandExecution',command:'node --test'}}});
    send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',completedAtMs:3,item:{id:'command-item',type:'commandExecution',command:'node --test',exitCode:0,aggregatedOutput:'2 tests passed'}}});
    send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'message-1',delta:'<<<TOKEN_COUPON_DONE:abc123>>>'}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    return;
  }
});
rl.on('close',()=>process.exit());
`;
}

function codexGuidanceScript(): string {
  return String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\n'); let turns=0;
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'guidance-thread'}}});
 if(m.method==='turn/start'){
  turns++; send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'guidance-turn-'+turns}}});
  if(turns===1)setTimeout(()=>send({jsonrpc:'2.0',id:'guidance-approval',method:'item/commandExecution/requestApproval',params:{itemId:'command-1',threadId:'guidance-thread',turnId:'guidance-turn-1',command:'npm install example',cwd:process.cwd(),reason:'Install dependency'}}),5);
  else {
   if(!JSON.stringify(m.params.input).includes('Use the dependency already present'))process.exitCode=41;
   setTimeout(()=>{send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'guidance-thread',turnId:'guidance-turn-2',itemId:'message-2',delta:'marker'}});send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'guidance-thread',turn:{id:'guidance-turn-2',status:'completed'}}});},5);
  }
 }
 if(m.id==='guidance-approval'){
  if(m.result?.decision!=='decline')process.exitCode=42;
  setTimeout(()=>send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'guidance-thread',turn:{id:'guidance-turn-1',status:'completed'}}}),5);
 }
});
rl.on('close',()=>process.exit());
`;
}

function elicitationServer(params: Record<string, unknown>, expectedResult: Record<string, unknown>, recordResponse = false, guidance?: string): string {
  return [
    "const rl=require('node:readline').createInterface({input:process.stdin});",
    "const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');",
    "const params=" + JSON.stringify(params) + ";",
    "const expected=" + JSON.stringify(expectedResult) + ";",
    "let marker='marker', turns=0;",
    "rl.on('line',line=>{const m=JSON.parse(line);",
    "if(m.method==='initialize')send({id:m.id,result:{}});",
    "if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'elicitation-thread'}}});",
    "if(m.method==='turn/start'){",
    "send({id:m.id,result:{turn:{id:'elicitation-turn'}}});",
    "const input=(m.params.input||[]).map(x=>x.text||'').join('\\n');",
    "const found=input.match(/<<<TOKEN_COUPON_DONE:[a-f0-9]+>>>/);if(found)marker=found[0];",
    ...(guidance ? ["if(++turns>1){if(!input.includes("+JSON.stringify(guidance)+"))process.exitCode=52;send({method:'item/agentMessage/delta',params:{itemId:'guidance-result',delta:marker+'\\n'}});send({method:'turn/completed',params:{turn:{id:'elicitation-turn',status:'completed'}}});return;}"] : []),
    "setTimeout(()=>send({id:'native-elicitation',method:'mcpServer/elicitation/request',params}),5);return;",
    "}",
    "if(m.id==='native-elicitation'){",
    "if(JSON.stringify(m.result)!==JSON.stringify(expected))process.exitCode=51;",
    ...(recordResponse ? ["require('node:fs').writeFileSync('elicitation-reply.json',JSON.stringify(m.result));"] : []),
    "send({method:'item/agentMessage/delta',params:{itemId:'elicitation-answer',delta:marker+'\\n'}});",
    "send({method:'turn/completed',params:{turn:{id:'elicitation-turn',status:'completed'}}});return;",
    "}",
    "if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{turn:{id:'elicitation-turn',status:'interrupted'}}});}",
    "});rl.on('close',()=>process.exit());",
  ].join("\n");
}

function asyncQuestionServer(mode: "completed" | "active", emitWaitingMarker = false): string {
  return String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');let count=0,marker;
const complete=()=>{
 send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:marker+'\n'}});
 send({method:'turn/completed',params:{turn:{id:'turn-'+count,status:'completed'}}});
};
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start'){
  count++;send({id:m.id,result:{turn:{id:'turn-'+count}}});
  if(count===1){
   marker=m.params.input[0].text.match(/<<<TOKEN_COUPON_DONE:[a-f0-9]+>>>/)[0];
   if(${emitWaitingMarker}){
    const waiting=m.params.input[0].text.match(/<<<TOKEN_COUPON_NEEDS_INPUT:[a-f0-9]+>>>/)[0];
    send({method:'item/agentMessage/delta',params:{itemId:'waiting',delta:'等待回答\n'+waiting+'\n'}});
   }
   send({method:'item/completed',params:{item:{id:'async-q',type:'agentMessage',text:'Choose',questions:[{title:'Allow empty names?',options:['Allow','Reject']}]}}});
   if(${JSON.stringify(mode)}==='completed')send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
  }else {if(!m.params.input[0].text.includes('Allow'))process.exitCode=32;complete();}
 }
 if(m.method==='turn/steer'){
  if(m.params.expectedTurnId!=='turn-1'||!m.params.input[0].text.includes('Allow'))process.exitCode=33;
  send({id:m.id,result:{turnId:'turn-1'}});complete();
 }
});rl.on('close',()=>process.exit());`;
}


it("declines MCP elicitation then forwards NO guidance through a follow-up turn in the same Attempt", async () => {
  const guidance = "不要打开网页；使用已有本地资料继续";
  const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", elicitationServer({ serverName: "docs", mode: "form", message: "填写数据", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }, { action: "decline", content: null }, false, guidance)] });
  let requests = 0;
  const result = await runner.run({ attemptId: "elicitation-no", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
    signal: new AbortController().signal, onStarted() {}, onOutput() {}, async recordEvent() {},
    async requestInteraction() { requests++; return { kind: "elicitation", action: "decline", guidance, interactionId: "no-guidance" }; },
  });
  expect(requests).toBe(1); expect(result.nativeOutcome).toBe("completed"); expect(result.exitCode).toBe(0);
});

it("validates refusal guidance independently of form answers and rejects accidental acceptance", () => {
  const request: any = { kind: "elicitation", title: "form", elicitation: { mode: "form", serverName: "docs", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } };
  expect(validateRunnerInteractionReply(request, { kind: "elicitation", action: "decline", guidance: "使用本地文件" })).toEqual({ kind: "elicitation", action: "decline", guidance: "使用本地文件" });
  expect(() => validateRunnerInteractionReply(request, { kind: "elicitation", action: "accept", content: { name: "yes" }, guidance: "no" })).toThrow(/只有拒绝/);
  expect(() => validateRunnerInteractionReply(request, { kind: "elicitation", action: "decline", guidance: " " })).toThrow(/指导无效/);
  const question: any = { kind: "question", title: "choose", questions: [{ id: "q", text: "选一个", options: [{ id: "a", label: "A" }], allowFreeText: false }] };
  expect(validateRunnerInteractionReply(question, { kind: "question", answers: [], guidance: "以上都不采用" })).toEqual({ kind: "question", answers: [], guidance: "以上都不采用" });
  expect(() => validateRunnerInteractionReply(question, { kind: "question", answers: [{ questionId: "q", optionIds: ["a"] }], guidance: "no" })).toThrow(/不能同时/);
});


it("routes NO guidance for a native question as user instructions rather than a selected option", async () => {
  const guidance = "不要创建新接口；先修复现有实现";
  const runner = new CodexRunner({}, { executable: process.execPath, args: ["-e", fakeServerScript("once", `用户拒绝当前方案，请调整：${guidance}`)] });
  const result = await runner.run({ attemptId: "native-question-no", cwd: process.cwd(), task, execution: task.execution, prompt: "run", completionMarker: "marker" }, {
    signal: new AbortController().signal, onStarted() {}, onOutput() {}, async recordEvent() {},
    async requestInteraction(request) { return request.kind === "question" ? { kind: "question", answers: [], guidance, interactionId: "question-no" } : { kind: "approval", decision: "allow-once", interactionId: "next-tool" }; },
  });
  expect(result).toMatchObject({ nativeOutcome: "completed", exitCode: 0, cleanupStatus: "completed" });
});
