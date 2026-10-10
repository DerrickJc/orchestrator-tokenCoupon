import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createSessionDelivery, formatSessionDelivery, parsePlan, runPlan, SessionStore } from "../packages/core/dist/index.js";
import { createTaskRunner } from "../packages/cli/dist/runner-factory.js";

// Explicitly invokes real, locally authenticated agents. Replies are scripted scenario
// decisions through the production broker, not simulated Runner/tool results.
const execFile = promisify(execFileCallback);
const demoRoot = resolve("demo-workspace/phase6-demo", `${new Date().toISOString().replaceAll(":", "-")}-mixed-live`);
const repository = join(demoRoot, "repository");
const reportPath = join(demoRoot, "phase6-mixed-live-report.json");
const report = { schemaVersion: 1, status: "running", demoRoot, repository, responseMode: "scripted-scenario-owner", interactions: [], attempts: [], checks: [] };
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
let active = 0;
let peak = 0;

async function git(args) {
  return (await execFile("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}
function within(parent, path) {
  const suffix = relative(parent, resolve(path));
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../");
}
async function checkpoint() {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

const fixtures = {
  ".gitignore": ".token-coupon/\n",
  "README.md": "Mixed live acceptance: implement only the task-owned src module. Baseline tests are immutable. No Git commands, network, dependency installs or other project changes.\n",
  "package.json": JSON.stringify({ name: "phase6-mixed-acceptance", private: true, type: "module", scripts: { test: "node --test --test-reporter=tap test/*.test.mjs" } }, null, 2) + "\n",
  "test/greet.test.mjs": [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { greet } from '../src/greet.mjs';",
    "test('greeting: ordinary name', () => assert.equal(greet('World'), 'Hello, World!'));",
    "test('greeting: empty name', () => assert.equal(greet(''), 'Hello, !'));",
    "test('greeting: unicode name', () => assert.equal(greet('小王'), 'Hello, 小王!'));", "",
  ].join("\n"),
  "test/normalize.test.mjs": [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { normalize } from '../src/normalize.mjs';",
    "test('normalizer: trims outer whitespace', () => assert.equal(normalize('  TokenCoupon  '), 'TokenCoupon'));",
    "test('normalizer: empty input', () => assert.equal(normalize(''), ''));",
    "test('normalizer: preserves case and interior whitespace', () => assert.equal(normalize('  A  b  '), 'A  b'));", "",
  ].join("\n"),
};
const boundary = "Only create your named src module, never change baseline tests/config/docs. Do not run Git, install packages, use network or delegate. Use native file editing. Run the exact requested test command in the task cwd, with the TAP reporter. Do not claim success without the real command succeeding. Follow the completion requirements below exactly, including the closing >>> of the completion marker.";
const execution = (runnerId, modelId, questions) => ({ runnerId, modelId, mode: "managed", requiredCapabilities: questions ? ["userInput", "toolApproval"] : ["toolApproval"] });
const plan = parsePlan({ schemaVersion: 1, id: "phase6-mixed-live", title: "Claude + Codex parallel real acceptance", tasks: [
  { task: { schemaVersion: 1, id: "greeting", title: "Claude implements greeting", prompt: `Before implementing, use AskUserQuestion to ask whether an empty name is allowed, with choices Allow and Reject. Wait for the answer, then implement export function greet(name) in src/greet.mjs; greet('World') must return 'Hello, World!'. Use the answer for empty names. Run node --test --test-reporter=tap test/greet.test.mjs. ${boundary}`, execution: execution("claude-code", process.env.PHASE6_CLAUDE_MODEL ?? "deepseek-flash", true) }, dependsOn: [], status: "planned" },
  { task: { schemaVersion: 1, id: "normalizer", title: "Codex implements normalizer", prompt: `Before implementing, use your native structured question tool (request_user_input_async or request_user_input) to ask whether normalize should preserve letter case, with choices Preserve and Lowercase. Wait for the answer, then implement export function normalize(value) in src/normalize.mjs that trims outer whitespace and uses the answer for letter case. Preserve interior whitespace. Run node --test --test-reporter=tap test/normalize.test.mjs. ${boundary}`, execution: execution("codex", process.env.PHASE6_CODEX_MODEL ?? "gpt-6.1-sol", true) }, dependsOn: [], status: "planned" },
  { task: { schemaVersion: 1, id: "verify", title: "Codex verifies the integrated six tests", prompt: `This is final verification of the integrated versions from both agents. Run exactly node --test --test-reporter=tap test/*.test.mjs in the task cwd. Report its real pass/fail counts. Make NO file changes. Do not ask questions or run Git/network/install/delegate commands. If any test fails report failure. Follow the completion requirements below exactly, including the closing >>> of the completion marker.`, execution: execution("codex", process.env.PHASE6_CODEX_MODEL ?? "gpt-6.1-sol", false) }, dependsOn: ["greeting", "normalizer"], status: "planned" },
] });
const runnerProfile = { schemaVersion: 1, runners: {
  "claude-code": { configVersion: 1, settings: { permissionMode: "default" } },
  codex: { configVersion: 1, settings: { sandbox: "workspace-write", approvalPolicy: "untrusted" } },
} };

async function onInteraction(requestId, request, owner, signal) {
  assert.ok(!signal.aborted);
  assert.ok(within(repository, owner.cwd), "interaction belongs to the isolated demo repository");
  let reply;
  if (request.kind === "question") {
    assert.notEqual(owner.taskId, "verify");
    const expected = owner.taskId === "greeting" ? "Allow" : "Preserve";
    reply = { kind: "question", answers: request.questions.map((question) => {
      const option = question.options?.find(({ label }) => label.toLowerCase().startsWith(expected.toLowerCase()));
      assert.ok(option, `unexpected scenario question: ${question.text}`);
      return { questionId: question.id, optionIds: [option.id] };
    }) };
  } else {
    let allowed = request.cwd === undefined || resolve(request.cwd) === resolve(owner.cwd);
    if (request.operation?.kind === "command") {
      const command = request.operation.command ?? "";
      // Read-only discovery and the prescribed local tests only. Refuse shell writes,
      // chained commands, package installation, Git, network and unrelated executables.
      allowed &&= command.length > 0 && !/[;&|<>`\n]|\$\(/.test(command)
        && /^(?:\/(?:usr\/)?bin\/(?:bash|sh) -[lc]+ ['"]?)?(?:pwd|ls|rg|cat|sed|head|node --test)(?:\s|$)/.test(command);
    } else if (request.operation?.kind === "file-change") {
      allowed &&= owner.taskId !== "verify";
      const module = owner.taskId === "greeting" ? "greet.mjs" : "normalize.mjs";
      allowed &&= (request.operation.paths ?? []).every((path) => resolve(owner.cwd, path) === join(owner.cwd, "src", module));
    } else allowed = false;
    reply = { kind: "approval", decision: allowed ? "allow-once" : "deny" };
  }
  report.interactions.push({ requestId, owner, request, reply, at: new Date().toISOString() });
  console.log(`[${owner.taskId}/${owner.runnerId}] ${request.kind}: ${reply.kind === "approval" ? reply.decision : JSON.stringify(reply.answers)} ${request.operation?.command ?? ""}`);
  // Serial broker event logs are the authoritative durable interaction evidence.
  return reply;
}

await mkdir(join(repository, "test"), { recursive: true });
await mkdir(join(repository, "src"), { recursive: true });
try {
  for (const [path, content] of Object.entries(fixtures)) await writeFile(join(repository, path), content);
  await git(["init", "--initial-branch=main", "--quiet"]);
  await git(["config", "user.name", "Token Coupon Live Acceptance"]);
  await git(["config", "user.email", "token-coupon-demo@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "test: seed six immutable mixed-runner acceptance cases"]);
  report.baseCommit = await git(["rev-parse", "HEAD"]);
  await writeFile(join(demoRoot, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  await writeFile(join(demoRoot, "runner-profile.json"), JSON.stringify(runnerProfile, null, 2) + "\n");
  await checkpoint();
  console.log(`Mixed live acceptance: ${demoRoot}`);
  const result = await runPlan({ plan, workspace: repository, isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2, runnerProfile, signal: abort.signal, onInteraction,
    createRunner: (task, options) => {
      const runner = createTaskRunner(task, options);
      return { ...runner, run: async (input, context) => {
        active += 1; peak = Math.max(peak, active);
        console.log(`[${task.id}/${runner.id}] started ${input.attemptId}`);
        try { return await runner.run(input, context); }
        finally { active -= 1; console.log(`[${task.id}/${runner.id}] returned`); }
      } };
    },
    onIdleState: (taskId) => console.log(`[${taskId}] idle notification; task remains active`),
  });
  report.sessionId = result.snapshot.sessionId;
  report.sessionStatus = result.snapshot.status;
  report.peakConcurrency = peak;
  report.runnerVersions = {};
  for (const executable of ["claude", "codex"]) {
    const version = await execFile(executable, ["--version"], { encoding: "utf8" });
    report.runnerVersions[executable] = version.stdout.trim();
  }
  report.taskStatuses = result.snapshot.tasks.map(({ taskId, status, reasonCode }) => ({ taskId, status, reasonCode }));
  for (const state of result.snapshot.tasks) {
    for (const ref of state.attempts) {
      const attempt = JSON.parse(await readFile(join(ref.artifactDir, "attempt.json"), "utf8"));
      const events = (await readFile(join(ref.artifactDir, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      report.attempts.push({ ...attempt, commands: events.filter((e) => e.type === "command.completed").map((e) => e.payload), interactionEvidence: events.filter((e) => e.type.startsWith("interaction.")).map((e) => ({ type: e.type, payload: e.payload })) });
    }
  }
  await checkpoint();
  assert.equal(result.snapshot.status, "succeeded", JSON.stringify(report.taskStatuses));
  assert.equal(peak, 2);
  assert.ok(report.attempts.every((a) => a.status === "succeeded" && a.markerSeen && a.nativeOutcome === "completed" && a.cleanupStatus === "completed"));
  for (const taskId of ["greeting", "normalizer"]) {
    assert.ok(report.interactions.some((i) => i.owner.taskId === taskId && i.reply.kind === "question"));
    assert.ok(report.interactions.some((i) => i.owner.taskId === taskId && i.reply.kind === "approval" && i.reply.decision === "allow-once"));
    const attempt = report.attempts.find((a) => a.taskId === taskId);
    for (const interaction of report.interactions.filter((i) => i.owner.taskId === taskId)) {
      assert.ok(attempt.interactionEvidence.some((e) => e.type === "interaction.forwarded" && e.payload.requestId === interaction.requestId), "each scenario reply must be forwarded to its original native request");
    }
  }
  const record = await new SessionStore(repository).load(report.sessionId);
  report.isolationJournal = record.isolationJournal;
  const siblings = record.isolationJournal.attempts.filter((a) => a.taskId !== "verify");
  assert.equal(siblings.length, 2);
  assert.ok(siblings.every((a) => a.baseCommit === report.baseCommit && a.status === "landed" && a.mergeParents.length === 2));
  const verify = report.attempts.find((a) => a.taskId === "verify");
  const command = verify.commands.find((c) => c.command?.includes("node --test") && c.command.includes("test/*.test.mjs"));
  assert.ok(command, "final verifier must provide native command evidence");
  assert.equal(command.exitCode, 0);
  assert.equal(command.status, "succeeded");
  assert.equal(command.cwd, verify.cwd);
  for (const [path, content] of Object.entries(fixtures)) assert.equal(await readFile(join(verify.cwd, path), "utf8"), content, `${path} must remain immutable`);
  const delivery = await createSessionDelivery(record, new SessionStore(repository));
  report.delivery = delivery;
  assert.deepEqual([...delivery.changedFiles].sort(), ["src/greet.mjs", "src/normalize.mjs"]);
  assert.equal(delivery.verificationAttemptId, verify.attemptId);
  assert.equal(await git(["rev-parse", "HEAD"]), report.baseCommit);
  assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
  report.deliveryDiff = join(demoRoot, "deliveryDiff.patch");
  await writeFile(report.deliveryDiff, (await execFile("git", ["diff", "--binary", "--no-ext-diff", delivery.baseCommit, delivery.integrationHead], { cwd: repository, encoding: "utf8" })).stdout);
  report.deliveryInstructions = join(demoRoot, "delivery-instructions.txt");
  await writeFile(report.deliveryInstructions, formatSessionDelivery(delivery, repository) + "\n");
  // Supplemental host verification is separate from the agent's native command and
  // cannot convert a failed Attempt/Session into a passed delivery.
  const host = await execFile(process.execPath, ["--test", "--test-reporter=tap", "test/greet.test.mjs", "test/normalize.test.mjs"], { cwd: verify.cwd, encoding: "utf8" });
  report.supplementalHostTest = { cwd: verify.cwd, output: host.stdout + host.stderr, exitCode: 0 };
  assert.match(report.supplementalHostTest.output, /# pass 6\b/);
  assert.match(report.supplementalHostTest.output, /# fail 0\b/);
  report.checks = ["real Claude and Codex overlapped in isolated worktrees", "both real runners answered native questions and received allow-once approval through the broker", "siblings were landed using two-parent Git merges", "native Codex verification exit 0 is bound to the unchanged six baseline tests and delivery integration head", "supplemental host test: six passed, zero failed", "source checkout remains clean at its original commit"];
  report.status = "succeeded";
  console.log(JSON.stringify({ status: report.status, sessionId: report.sessionId, peakConcurrency: peak, taskStatuses: report.taskStatuses, checks: report.checks }, null, 2));
} catch (error) {
  report.status = abort.signal.aborted ? "cancelled" : "failed";
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await checkpoint();
  console.log(`Report: ${reportPath}`);
}
