import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DeepSeekPlanner, loadPlannerConversation, replyToPlanner, startPlannerConversation } from "../packages/core/dist/index.js";

const real = process.argv.includes("--real");
if (real && (!process.env.TOKEN_COUPON_PLANNER_API_KEY || !process.env.TOKEN_COUPON_PLANNER_MODEL)) throw new Error("真实冒烟需要 Planner key 和 model");
const workspace = resolve("demo-workspace/phase3.5-bugfix-3", `${real ? "real" : "offline"}-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(workspace, { recursive: true });
const report = { mode: real ? "real-planner" : "offline-fake", workspace, status: "running", checks: [] };
const config = { provider: "deepseek", model: real ? process.env.TOKEN_COUPON_PLANNER_MODEL : "offline-fake", baseUrl: process.env.TOKEN_COUPON_PLANNER_BASE_URL ?? "https://api.deepseek.com" };
const executionDefaults = { runnerId: "mock", mode: "non_interactive" };
const values = { language_runtime: "Java 21", web_framework: "Spring Boot", database: "SQLite", documentation: "Markdown", testing: "JUnit", business_rules: "课程、教师、班级基础 CRUD，不做冲突校验" };

function planner() {
  if (real) return new DeepSeekPlanner(config);
  return new DeepSeekPlanner({ ...config, apiKey: "offline-fake", fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const inputs = JSON.parse(/待整理输入：([^\n]+)/.exec(body.messages[0].content)[1]);
    const source = inputs.at(-1);
    const ready = /全部由你|^同意/.test(source.content);
    const planningAssessment = {
      profile: "backend_crud", classification: { rationale: "排课后端", sourceMessageId: source.messageId, quote: source.content },
      decisions: Object.entries(values).map(([decisionId, value]) => ready
        ? { decisionId, value, status: "defaulted", rationale: "用户授权", sourceMessageId: source.messageId, authorizationQuote: source.content }
        : { decisionId, value, status: "pending", rationale: "默认提案待确认", question: `是否授权采用${value}作为默认方案？` }),
    };
    const requirementsUpdate = {
      messageDecisions: inputs.map(({ messageId }) => ({ messageId, kind: "requirement", reason: "业务及决策确认" })),
      changes: [{ requirementId: "R-course", text: ready ? Object.values(values).join("；") : source.content, status: "active", sourceMessageIds: inputs.map(({ messageId }) => messageId) }],
    };
    const reply = ready ? { kind: "draft", message: "采用列出的默认值", plan: { schemaVersion: 1, id: "course", title: "排课系统", tasks: [
      { task: { schemaVersion: 1, id: "implement", title: "实现", prompt: Object.values(values).join("；"), execution: executionDefaults }, dependsOn: [], status: "planned" },
      { task: { schemaVersion: 1, id: "verify", title: "验证", prompt: "运行测试", execution: executionDefaults }, dependsOn: ["implement"], status: "planned" },
    ] }, planningAssessment, requirementsUpdate } : { kind: "clarification", message: "请确认这些默认方案", questions: ["是否授权采用当前列出的默认方案？"],
      questionBindings: [{ questionId: "default-proposals", displayIndex: 1, decisionIds: Object.keys(values), answerMode: "accept_proposal" }], planningAssessment, requirementsUpdate };
    const json = JSON.stringify(reply);
    const content = ready ? json.replace(',"requirementsUpdate":', '},"requirementsUpdate":') : json;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  } });
}

try {
  for (const [name, answer] of [["delegation", "全部由你完成模拟，技术栈和细节我暂时不关注；采用 Spring Boot 和 SQLite，其余普通实现细节由你决定。"], ["contextual-consent", "同意该默认方案"]]) {
    const root = join(workspace, name);
    await mkdir(root, { recursive: true });
    const adapter = planner();
    const request = "设计简单的计算机专业排课后端，给学生教师使用，无前端。仅课程、教师、班级的基础 CRUD，不做冲突检测。先写接口及数据库设计文档，再实现和测试，测试通过交付。" +
      (name === "contextual-consent" ? "先提出具体默认方案供我确认，覆盖各项必需决策；不要直接生成草案。" : "");
    const initial = await startPlannerConversation({ workspace: root, request, config, executionDefaults, planner: adapter });
    assert.equal(initial.error, undefined, initial.error);
    assert.equal(initial.snapshot.status, "collecting");
    const result = await replyToPlanner({ workspace: root, planningId: initial.snapshot.planningId, message: answer, planner: adapter });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.snapshot.status, "draft_ready");
    const loaded = await loadPlannerConversation(result.snapshot.planningId, root);
    assert.equal(loaded.snapshot.status, "draft_ready");
    assert.equal(loaded.snapshot.planningAssessment.decisions.some(({ status }) => status === "pending"), false);
    const turnDir = result.snapshot.turns.at(-1).artifactDir;
    const turn = JSON.parse(await readFile(join(turnDir, "turn.json"), "utf8"));
    if (!real) {
      assert.equal(turn.apiRequests, 1);
      assert.ok(turn.events.some(({ type }) => type === "planner.json_repaired"));
    }
    const check = { name, planningId: result.snapshot.planningId, status: loaded.snapshot.status, requirementsRevision: loaded.snapshot.requirements.revision,
      apiRequests: turn.apiRequests, toolCalls: turn.toolCalls, repairs: turn.events.filter(({ type }) => type === "planner.json_repaired").length, turnDir };
    report.checks.push(check);
    console.log(JSON.stringify(check));
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  const message = error instanceof Error ? error.message : String(error);
  report.error = process.env.TOKEN_COUPON_PLANNER_API_KEY ? message.replaceAll(process.env.TOKEN_COUPON_PLANNER_API_KEY, "[已隐藏]") : message;
  process.exitCode = 1;
} finally {
  await writeFile(join(workspace, "bugfix-3-demo-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: join(workspace, "bugfix-3-demo-report.json"), ...(report.error ? { error: report.error } : {}) }));
}
