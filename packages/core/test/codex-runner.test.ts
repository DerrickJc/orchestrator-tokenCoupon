import { describe, expect, it } from "vitest";
import { CodexRunner } from "../src/runners/codex-runner.js";
import type { RunnerEvent, RunnerInteractionRequest } from "../src/runner.js";
import type { TaskDefinition } from "../src/task.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTask } from "../src/execute-task.js";

const task: TaskDefinition = {
  schemaVersion: 1, id: "codex-task", title: "Codex interaction fixture", prompt: "Complete a tiny task",
  execution: { runnerId: "codex", mode: "managed", modelId: "test-model" },
};

describe("CodexRunner app-server transport", () => {
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
    expect(events).toContainEqual({ type: "runner.native.finished", outcome: "completed" });
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

function fakeServerScript(approvalMode: "once" | "broad" | "suggestion" = "once"): string {
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
    if(m.result?.answers?.language?.answers?.[0]!=='TypeScript')process.exitCode=31;
    send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',completedAtMs:1,item:{id:'question-item',type:'dynamicToolCall',name:'request_user_input'}}});
    setTimeout(()=>send({jsonrpc:'2.0',id:'approval-1',method:'item/commandExecution/requestApproval',params:{itemId:'command-item',threadId:'thread-1',turnId:'turn-1',startedAtMs:1,command:'node --test',cwd:'${process.cwd()}',reason:'Run tests',additionalPermissions:${approvalMode === "broad" ? "{fileSystem:{write:['/tmp']}}" : "null"},proposedExecpolicyAmendment:${approvalMode === "suggestion" ? "['node','--test']" : "null"},proposedNetworkPolicyAmendments:null}}),5);
    return;
  }
  if(m.id==='approval-1'){
    if(${approvalMode !== "broad"} && m.result?.decision!=='accept')process.exitCode=32;
    if(${approvalMode === "broad"} && m.result?.decision!=='decline')process.exitCode=33;
    send({jsonrpc:'2.0',method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',startedAtMs:2,item:{id:'command-item',type:'commandExecution',command:'node --test'}}});
    send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',completedAtMs:3,item:{id:'command-item',type:'commandExecution',command:'node --test',exitCode:0}}});
    send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'message-1',delta:'<<<TOKEN_COUPON_DONE:abc123>>>'}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
    return;
  }
});
rl.on('close',()=>process.exit());
`;
}

function asyncQuestionServer(mode: "completed" | "active"): string {
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
