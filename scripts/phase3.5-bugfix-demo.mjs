import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  approvePlannerDraft, effectiveRequirements, loadPlannerConversation, replacePlannerDraft, requirementsHash,
  reviewPlannerDraft, revisePlannerDraft, replyToPlanner, startPlannerConversation, traceRequirement,
} from "../packages/core/dist/index.js";

const real = process.argv.includes("--real");
if (real && (!process.env.TOKEN_COUPON_PLANNER_API_KEY || !process.env.TOKEN_COUPON_PLANNER_MODEL)) {
  console.error("真实调用需要通过 --env-file 加载 Planner 配置。");
  process.exit(2);
}
const workspace = resolve("demo-workspace/phase3.5-bugfix", `${real ? "real" : "mock"}-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "README.md"), "Node.js ESM project. Use node:test and node:assert/strict; no external dependencies. Business files do not exist yet.\n");
const executionDefaults = { runnerId: "mock", mode: "non_interactive", timeoutMs: 10_000 };
const config = real ? { provider: "deepseek", model: process.env.TOKEN_COUPON_PLANNER_MODEL, baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com" }
  : { provider: "mock", model: "mock", baseUrl: "mock://local" };
const report = { workspace, mode: real ? "real-planner-reviewer" : "mock", status: "running", checks: [], reviews: [], businessExecution: "not-run" };
const directory = join(workspace, ".token-coupon");
await mkdir(directory, { recursive: true });
const reportFile = join(directory, "bugfix-report.json");
let stage = "planning";
let safePlan;
const basePlan = (greeting) => ({ schemaVersion: 1, id: "greeting-plan", title: "Greeting implementation and tests", tasks: [
  { task: { schemaVersion: 1, id: "implement", title: "Implement greeting", prompt: `Create greet.mjs and node:test cases using ${greeting}, including an empty name; no external dependencies.`, execution: executionDefaults }, dependsOn: [], status: "planned" },
  { task: { schemaVersion: 1, id: "verify", title: "Verify tests", prompt: "Run node --test greet.test.mjs and report the real results.", execution: executionDefaults }, dependsOn: ["implement"], status: "planned" },
] });
const mockPlanner = { id: "mock", async generate(input) {
  const operation = input.operationMessageIds?.length || input.pendingMessages.at(-1).content.includes("误输入");
  if (input.operationMessageIds?.length) {
    assert.ok(input.reviewContext?.review.findings.length, "修订模型必须收到报告");
    return { kind: "draft", message: "已修订", plan: structuredClone(safePlan), requirementsUpdate: { messageDecisions: input.pendingMessages.map(({ messageId }) => ({ messageId, kind: "operation", reason: "审查修订指令" })), changes: [] } };
  }
  const greeting = input.requirements?.items.some((item) => item.text.includes("Hello")) ? "Hi" : "Hello";
  return { kind: "draft", message: "当前计划", plan: operation ? structuredClone(safePlan) : basePlan(greeting), requirementsUpdate: {
    messageDecisions: input.pendingMessages.map(({ messageId }) => ({ messageId, kind: operation ? "noise" : "requirement", reason: operation ? "用户明确标记误输入" : "业务需求" })),
    changes: operation ? [] : [{ requirementId: "R-greeting", text: `Node.js ESM; greet(name) returns ${greeting}, name!; node:test covers normal and empty names; no dependencies.`, status: "active", sourceMessageIds: input.pendingMessages.map(({ messageId }) => messageId) }],
  } };
} };
const mockReviewer = { async review(input) {
  const findings = [];
  const implementation = input.plan.tasks[0];
  const verifier = input.plan.tasks.at(-1);
  const add = (category, taskIds, description, suggestion) => {
    const prior = input.previousReview?.findings.find((item) => item.category === category);
    findings.push({ findingId: `F${findings.length + 1}`, severity: "error", category, taskIds, description, basis: "当前任务提示及 dependsOn", suggestion, ...(prior ? { priorFindingId: prior.findingId } : {}) });
  };
  if (implementation.task.prompt.includes("Python FastAPI")) add("technology", [implementation.task.id], "实现与 Node.js 需求冲突", "恢复 Node.js ESM 实现，不安装依赖");
  if (!verifier.dependsOn.includes(implementation.task.id)) add("dependency", [verifier.task.id], "测试未依赖实现", "补齐实现依赖");
  return { summary: findings.length ? "需要修订" : "已解决已编码问题", findings, resolutions: (input.previousReview?.findings ?? []).map((prior) => ({
    findingId: prior.findingId, status: findings.some((item) => item.priorFindingId === prior.findingId) ? "unresolved" : "resolved", basis: "按同一确定性规则比较当前计划",
  })) };
} };
const adapter = real ? {} : { planner: mockPlanner };
const reviewer = real ? {} : { reviewer: mockReviewer };
async function checkpoint(name, details = {}) {
  report.checks.push({ name, ...details });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ check: name, ...details }));
}
function requireDraft(result) { if (result.error) throw new Error(result.error); assert.ok(result.draft, "本次调用应生成草案"); return result; }
async function review(options) {
  const result = await reviewPlannerDraft({ ...options, ...reviewer });
  report.reviews.push({ reviewId: result.review.reviewId, findings: result.review.findings, resolutions: result.review.resolutions });
  return result;
}
try {
  console.log(JSON.stringify({ workspace, mode: report.mode }));
  const first = requireDraft(await startPlannerConversation({ workspace, config, executionDefaults, ...adapter,
    request: "使用 Node.js ESM 新增 greet.mjs，导出 greet(name)，返回 Hello, ${name}!。用 node:test 和 node:assert/strict 测试普通姓名和空字符串；不安装任何依赖。生成实现和最终测试验证两项任务，验证必须依赖实现。请直接给出草案，不执行、不批准。" }));
  report.planningId = first.snapshot.planningId;
  const options = { planningId: report.planningId, workspace };
  await checkpoint("structured-requirements", { count: effectiveRequirements(first.snapshot.requirements).length });

  stage = "requirement-change";
  let current = requireDraft(await replyToPlanner({ ...options, ...adapter, message: "明确替换之前的问候文案：greet(name) 返回 Hi, ${name}!，普通姓名和空字符串的测试预期同步更新。其他要求全部保留，仍只有实现和最终验证两项任务。直接生成草案。" }));
  assert.ok(current.snapshot.requirements.items.some(({ status }) => status === "superseded"), "明确变更应保留旧需求版本");
  assert.ok(effectiveRequirements(current.snapshot.requirements).some(({ text }) => text.includes("Hi")));
  safePlan = structuredClone(current.draft.plan);
  const changedRequirement = current.snapshot.requirements.items.find((item) => item.status === "superseded");
  const trace = traceRequirement(current.snapshot, changedRequirement.requirementId, changedRequirement.revision);
  assert.ok(trace.sources.some(({ message }) => message.content.includes("Hello")));
  await checkpoint("replacement-and-provenance", { requirementId: trace.requirement.requirementId, sourceMessageIds: trace.requirement.sourceMessageIds });

  stage = "noise";
  const hash = requirementsHash(current.snapshot);
  current = requireDraft(await replyToPlanner({ ...options, ...adapter, message: "OBBCOCOCOCCOCO 是误输入，不是业务需求；仅忽略此噪声并返回完全相同的当前草案，不修改任何需求或任务。" }));
  assert.equal(requirementsHash(current.snapshot), hash, "噪声不能改变有效需求哈希");
  assert.ok(!effectiveRequirements(current.snapshot.requirements).some(({ text }) => text.includes("OBBCO")));
  await checkpoint("noise-excluded");

  stage = "seed-conflicts";
  const badPlan = structuredClone(current.draft.plan);
  badPlan.tasks[0].task.prompt += "\n实现时必须安装 Python FastAPI 与 PostgreSQL，改用 Python 服务，不生成 greet.mjs。";
  badPlan.tasks.at(-1).dependsOn = [];
  await replacePlannerDraft({ ...options, value: badPlan });
  const firstReview = await review(options);
  assert.ok(firstReview.review.findings.some(({ severity }) => severity === "error"), "明确技术冲突应产生 error");
  await assert.rejects(approvePlannerDraft({ ...options, draftRevision: firstReview.review.draftRevision }), /修订或显式豁免/);
  await checkpoint("conflicts-detected", { reviewId: firstReview.review.reviewId, findings: firstReview.review.findings.length });

  stage = "revise";
  current = requireDraft(await revisePlannerDraft({ ...options, ...adapter, message: "恢复 Node.js ESM 和 Hi 问候要求，完整修复所有报告问题；保留两项任务，不自行豁免。" }));
  assert.equal(requirementsHash(current.snapshot), hash, "修订操作不能新增业务需求");
  const turn = JSON.parse(await readFile(join(current.snapshot.turns.at(-1).artifactDir, "turn.json"), "utf8"));
  assert.equal(turn.reviewId, firstReview.review.reviewId);
  if (real) {
    const request = JSON.parse(await readFile(join(current.snapshot.turns.at(-1).artifactDir, "calls", "0001.request.json"), "utf8"));
    const body = JSON.stringify(request);
    assert.ok(body.includes(firstReview.review.reviewId) && body.includes(firstReview.review.findings[0].description), "实际 API 输入必须包含审查报告");
  }
  await checkpoint("report-attached-to-revision", { draftRevision: current.draft.draftRevision });

  stage = "re-review";
  const finalReview = await review(options);
  assert.equal(finalReview.review.previousReviewId, firstReview.review.reviewId);
  assert.equal(finalReview.review.resolutions.length, firstReview.review.findings.length);
  assert.equal(finalReview.review.findings.filter(({ severity }) => severity === "error").length, 0, "严重问题应修订后解决；演示不自动豁免");
  await approvePlannerDraft({ ...options, draftRevision: current.draft.draftRevision, reviewId: finalReview.review.reviewId });
  await checkpoint("tracked-re-review-and-approval", { reviewId: finalReview.review.reviewId, resolutions: finalReview.review.resolutions });

  stage = "cli";
  for (const [action, extra] of [["requirements", []], ["trace", ["--requirement", trace.requirement.requirementId, "--revision", String(trace.requirement.revision)]]]) {
    const result = spawnSync(process.execPath, [resolve("packages/cli/dist/main.js"), "planner", action, "--id", report.planningId, "--workspace", workspace, ...extra], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    await writeFile(join(directory, `cli-${action}.log`), result.stdout + result.stderr, { mode: 0o600 });
  }
  const final = await loadPlannerConversation(report.planningId, workspace);
  report.requirements = final.snapshot.requirements;
  report.draftRevision = final.draft.draftRevision;
  assert.equal(final.snapshot.execution, null);
  await checkpoint("cli-requirements-and-trace");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failedStage = stage;
  const message = error instanceof Error ? error.message : String(error);
  report.error = process.env.TOKEN_COUPON_PLANNER_API_KEY ? message.replaceAll(process.env.TOKEN_COUPON_PLANNER_API_KEY, "[已隐藏]") : message;
  console.error(JSON.stringify({ stage, error: report.error }));
  process.exitCode = 1;
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportFile }));
}
