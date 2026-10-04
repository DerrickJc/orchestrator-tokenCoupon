import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlannerDraft, canonicalHash, DeepSeekPlanner, loadPlannerConversation, MockPlanner, PlannerStore,
  RepositoryReader, replacePlannerDraft, replyToPlanner, runApprovedPlanner, startPlannerConversation,
} from "../src/index.js";
import type { ExecutionConfig, PlannerContext } from "../src/index.js";
import { MockRunner } from "../src/runners/mock-runner.js";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "token-coupon-planner-"));
  roots.push(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function execution(): ExecutionConfig { return { runnerId: "mock", mode: "non_interactive", timeoutMs: 3000 }; }
function plan(prompt = "Implement the requested greeting") {
  return {
    schemaVersion: 1, id: "greeting-plan", title: "Greeting plan",
    tasks: [
      { task: { schemaVersion: 1, id: "implement", title: "Implement greeting", prompt, execution: execution() }, dependsOn: [], status: "planned" },
      { task: { schemaVersion: 1, id: "verify", title: "Verify greeting", prompt: "Run the tests and report their real output.", execution: execution() }, dependsOn: ["implement"], status: "planned" },
    ],
  };
}
function draftReply(prompt?: string) { return { kind: "draft", message: "Review this plan.", plan: plan(prompt) }; }
const factory = () => new MockRunner();
const config = { provider: "mock" as const, model: "mock", baseUrl: "mock://local" };

describe("read-only repository tools", () => {
  it("reads bounded UTF-8 text, hashes evidence, and searches literal text", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "greet.ts"), "export const greet = 'hello';\n", "utf8");
    await writeFile(join(root, ".env"), "TOKEN=private\n", "utf8");
    const reader = new RepositoryReader(root);

    const read = JSON.parse(await reader.invoke("repo_read", { path: "src/greet.ts", startLine: 1, lineCount: 10 })) as Record<string, unknown>;
    expect(read.content).toContain("1: export const greet");
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reader.getEvidence().map((item) => item.path)).toEqual(["src/greet.ts"]);

    const search = JSON.parse(await reader.invoke("repo_search", { path: "src", query: "greet", offset: 0 })) as Record<string, unknown>;
    expect(search.matches).toEqual([{ path: "src/greet.ts", line: 1, text: "export const greet = 'hello';" }]);
    const excluded = JSON.parse(await reader.invoke("repo_read", { path: ".env", startLine: 1, lineCount: 10 })) as Record<string, unknown>;
    expect(excluded.error).toBe("path_excluded");
    const traversal = JSON.parse(await reader.invoke("repo_read", { path: "../secret", startLine: 1, lineCount: 10 })) as Record<string, unknown>;
    expect(traversal.error).toBe("invalid_path");
  });

  it("caps a read result at 16 KiB and marks the returned content as truncated", async () => {
    const root = await workspace();
    await writeFile(join(root, "large.txt"), Array.from({ length: 8 }, () => "x".repeat(4000)).join("\n"), "utf8");
    const reader = new RepositoryReader(root);
    const result = JSON.parse(await reader.invoke("repo_read", { path: "large.txt", startLine: 1, lineCount: 8 })) as {
      content: string; truncated: boolean;
    };
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(result.truncated).toBe(true);
  });

  it("rejects symlinks and refuses a file that changes during evidence approval", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(root, "source.txt"), "before\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "private\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    const reader = new RepositoryReader(root);
    const linked = JSON.parse(await reader.invoke("repo_read", { path: "linked.txt" })) as Record<string, unknown>;
    expect(linked.error).toBe("symlink_not_allowed");

    const original = JSON.parse(await reader.invoke("repo_read", { path: "source.txt" })) as Record<string, unknown>;
    expect(original.sha256).toBeTruthy();
    await writeFile(join(root, "source.txt"), "after\n", "utf8");
    expect(await reader.verifyEvidence([{ path: "source.txt", sha256: original.sha256 as string, sizeBytes: 7 }])).toEqual(["source.txt"]);
  });
});

describe("Planner conversation and approval", () => {
  it("persists a draft, gates execution on approval, and reuses one Session on repeated run", async () => {
    const root = await workspace();
    const planner = new MockPlanner([draftReply()]);
    const started = await startPlannerConversation({
      workspace: root, request: "Implement a greeting function and tests.", config, executionDefaults: execution(), planner,
    });
    expect(started.snapshot.status).toBe("draft_ready");
    expect(started.draft?.draftRevision).toBe(1);
    const planningId = started.snapshot.planningId;
    await expect(runApprovedPlanner({ planningId, workspace: root, createRunner: factory })).rejects.toThrow("必须批准");
    expect(await readdir(join(root, ".token-coupon", "sessions")).catch(() => [])).toHaveLength(0);

    const approved = await approvePlannerDraft({ planningId, workspace: root, draftRevision: 1 });
    expect(approved.snapshot.status).toBe("approved");
    const firstRun = await runApprovedPlanner({ planningId, workspace: root, createRunner: factory });
    expect(firstRun.snapshot.status).toBe("execution_created");
    expect(firstRun.sessionStatus).toBe("succeeded");
    const sessions = await readdir(join(root, ".token-coupon", "sessions"));
    expect(sessions).toHaveLength(1);

    const repeated = await runApprovedPlanner({ planningId, workspace: root, createRunner: factory });
    expect(repeated.snapshot.execution?.sessionId).toBe(firstRun.snapshot.execution?.sessionId);
    expect(await readdir(join(root, ".token-coupon", "sessions"))).toHaveLength(1);
  });

  it("reopening and replying persists history and invalidates the previous approval", async () => {
    const root = await workspace();
    const planner = new MockPlanner([
      { kind: "clarification", message: "I need one detail.", questions: ["Which greeting should an empty name receive?"] },
      draftReply(),
      { kind: "clarification", message: "One more detail.", questions: ["Should the test use node:test?"] },
    ]);
    const started = await startPlannerConversation({ workspace: root, request: "Add a greeting.", config, executionDefaults: execution(), planner });
    expect(started.snapshot.status).toBe("collecting");
    expect(started.reply?.kind).toBe("clarification");
    const reopened = await loadPlannerConversation(started.snapshot.planningId, root);
    expect(reopened.snapshot.messages).toHaveLength(2);
    expect(reopened.reply?.questions).toEqual(["Which greeting should an empty name receive?"]);

    const draft = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "Return Hello, ! for empty input.", planner });
    expect(draft.snapshot.status).toBe("draft_ready");
    await approvePlannerDraft({ planningId: started.snapshot.planningId, workspace: root, draftRevision: 1 });
    const clarification = await replyToPlanner({ planningId: started.snapshot.planningId, workspace: root, message: "Also use the built-in Node test runner.", planner });
    expect(clarification.snapshot.status).toBe("collecting");
    expect(clarification.snapshot.approval).toBeNull();
    await expect(approvePlannerDraft({ planningId: started.snapshot.planningId, workspace: root, draftRevision: 1 })).rejects.toThrow("没有等待批准");
  });

  it("imports edits as a new immutable revision and rejects approval after context changes", async () => {
    const root = await workspace();
    await writeFile(join(root, "README.md"), "Initial notes\n", "utf8");
    const reader = new RepositoryReader(root);
    const evidence = JSON.parse(await reader.invoke("repo_read", { path: "README.md" })) as { sha256: string };
    const draftPlan = plan();
    const draft = {
      schemaVersion: 1 as const, planningId: "56f207ed-6dbf-4ac3-8aee-8bd0f86b3bc6", draftRevision: 1,
      plan: draftPlan, message: "Review.", source: "model" as const,
      context: [{ path: "README.md", sha256: evidence.sha256, sizeBytes: 14 }],
      planHash: canonicalHash(draftPlan), createdAt: new Date().toISOString(),
    };
    const initial = {
      schemaVersion: 1 as const, planningId: draft.planningId, workspace: root, revision: 1, status: "draft_ready" as const,
      config, executionDefaults: execution(), messages: [], turns: [], context: draft.context,
      activeTurnId: null, draftRevision: 1, approval: null, execution: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const store = new PlannerStore(root);
    await store.create(initial);
    await store.writeDraft(draft);

    const changedPlan = plan("Implement a greeting with an explicit empty-name behavior.");
    const replaced = await replacePlannerDraft({ planningId: draft.planningId, workspace: root, value: changedPlan });
    expect(replaced.draft?.draftRevision).toBe(2);
    expect(await store.loadDraft(draft.planningId, 1)).toMatchObject({ draftRevision: 1, planHash: draft.planHash });
    await writeFile(join(root, "README.md"), "Changed notes\n", "utf8");
    await expect(approvePlannerDraft({ planningId: draft.planningId, workspace: root, draftRevision: 2 })).rejects.toThrow("workspace_changed");
  });
});

describe("DeepSeek Planner adapter", () => {
  it("uses read-only function calls, returns JSON, and keeps credentials out of recorded payloads", async () => {
    const root = await workspace();
    await writeFile(join(root, "README.md"), "Project greeting overview\n", "utf8");
    const requestBodies: Array<Record<string, unknown>> = [];
    const replies = [
      { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "repo_read", arguments: JSON.stringify({ path: "README.md", startLine: 1, lineCount: 10 }) } }] } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "I have enough context." } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(draftReply()) } }] },
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "content-type": "application/json" } });
    };
    const events: unknown[] = [];
    let apiRequests = 0;
    let toolCalls = 0;
    const context: PlannerContext = {
      signal: new AbortController().signal, repository: new RepositoryReader(root),
      consumeApiRequest: () => ++apiRequests, consumeToolCall: () => { toolCalls += 1; },
      record: async (event) => { events.push(event); },
    };
    const planner = new DeepSeekPlanner({ model: "deepseek-flash", baseUrl: "https://api.deepseek.com", apiKey: "do-not-record", fetchImpl });
    const result = await planner.generate({
      messages: [{ role: "user", content: "Summarize this project." }], executionDefaults: execution(),
    }, context);

    expect(result).toMatchObject({ kind: "draft" });
    expect(apiRequests).toBe(3);
    expect(toolCalls).toBe(1);
    expect(requestBodies[0]?.model).toBe("deepseek-flash");
    expect(requestBodies[0]?.thinking).toEqual({ type: "disabled" });
    expect(requestBodies[0]?.tools).toHaveLength(3);
    expect(requestBodies[2]?.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(requestBodies)).not.toContain("do-not-record");
    expect(events).toHaveLength(7);
  });

  it("redacts API credentials in provider errors", async () => {
    const root = await workspace();
    const planner = new DeepSeekPlanner({
      model: "deepseek-flash", baseUrl: "https://api.deepseek.com", apiKey: "secret-key",
      fetchImpl: async () => new Response(JSON.stringify({ error: "secret-key rejected" }), { status: 401 }),
    });
    const context: PlannerContext = {
      signal: new AbortController().signal, repository: new RepositoryReader(root),
      consumeApiRequest: () => 1, consumeToolCall: () => undefined, record: async () => undefined,
    };
    await expect(planner.generate({ messages: [], executionDefaults: execution() }, context)).rejects.toThrow("[已隐藏]");
  });
});
