import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { createSessionDelivery, formatSessionDelivery, parsePlan, runPlan, SessionStore } from "../packages/core/dist/index.js";

const execFile = promisify(execFileCallback);
const stamp = new Date().toISOString().replaceAll(":", "-");
const demoRoot = resolve("demo-workspace", "phase5-demo", stamp);
const repository = join(demoRoot, "repository");
const reportPath = join(demoRoot, "phase5-demo-report.json");
const patchPath = join(demoRoot, "deliveryDiff.patch");
await mkdir(repository, { recursive: true });

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function runNodeTest(cwd) {
  const { stdout, stderr } = await execFile(process.execPath, ["--test", "--test-reporter=tap"], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout + stderr;
}

let releaseWorkers;
let startedWorkers = 0;
let activeWorkers = 0;
let peakWorkers = 0;
const bothStarted = new Promise((resolveBoth) => { releaseWorkers = resolveBoth; });
let testOutput = "";

class Phase5DemoRunner {
  id = "mock";
  supportsModel = false;

  async checkAvailable() {}

  async run(input, context) {
    context.onStarted();
    const send = (text) => context.onOutput({ stream: "stdout", text: `${text}\n${input.completionMarker}\n`, agentText: `${text}\n${input.completionMarker}\n` });
    if (input.task.id === "verify") {
      testOutput = await runNodeTest(input.cwd);
      send(testOutput);
      return { started: true, exitCode: 0, signal: null };
    }

    activeWorkers += 1;
    startedWorkers += 1;
    peakWorkers = Math.max(peakWorkers, activeWorkers);
    if (startedWorkers === 2) releaseWorkers();
    const timeout = setTimeout(() => releaseWorkers(), 10_000);
    try {
      await bothStarted;
      if (input.task.id === "greeting") {
        await writeFile(join(input.cwd, "greet.mjs"), "export function greet(name) { return `Hello, ${name}!`; }\n", "utf8");
        await writeFile(join(input.cwd, "greet.test.mjs"), [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { greet } from './greet.mjs';",
          "test('greets a name', () => assert.equal(greet('World'), 'Hello, World!'));",
          "test('accepts an empty name', () => assert.equal(greet(''), 'Hello, !'));",
          "",
        ].join("\n"), "utf8");
      } else {
        assert.equal(input.task.id, "normalizer");
        await writeFile(join(input.cwd, "normalize.mjs"), "export function normalize(value) { return value.trim().toLowerCase(); }\n", "utf8");
        await writeFile(join(input.cwd, "normalize.test.mjs"), [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { normalize } from './normalize.mjs';",
          "test('trims and lowercases text', () => assert.equal(normalize('  TokenCoupon  '), 'tokencoupon'));",
          "",
        ].join("\n"), "utf8");
      }
      send(`Created files for ${input.task.id}.`);
      return { started: true, exitCode: 0, signal: null };
    } finally {
      clearTimeout(timeout);
      activeWorkers -= 1;
    }
  }
}

const plan = parsePlan({
  schemaVersion: 1,
  id: "phase5-parallel-demo",
  title: "Phase 5 bounded parallelism demonstration",
  tasks: [
    { task: { schemaVersion: 1, id: "greeting", title: "Implement greeting", prompt: "Implement a greeting helper and its tests.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
    { task: { schemaVersion: 1, id: "normalizer", title: "Implement text normalizer", prompt: "Implement a text normalizer and its tests.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
    { task: { schemaVersion: 1, id: "verify", title: "Run integrated test suite", prompt: "Run node --test over all integrated tests without modifying source files.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: ["greeting", "normalizer"], status: "planned" },
  ],
});

const report = { schemaVersion: 1, status: "running", demoRoot, checks: [] };
try {
  await git(repository, ["init", "--initial-branch=main", "--quiet"]);
  await git(repository, ["config", "user.name", "Token Coupon Phase 5 Demo"]);
  await git(repository, ["config", "user.email", "token-coupon-phase5@example.invalid"]);
  await writeFile(join(repository, ".gitignore"), ".token-coupon/\n", "utf8");
  await writeFile(join(repository, "README.md"), "Phase 5 parallel worktree demo.\n", "utf8");
  await git(repository, ["add", ".gitignore", "README.md"]);
  await git(repository, ["commit", "--quiet", "-m", "initial phase 5 demo repository"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);

  const demoRunner = new Phase5DemoRunner();
  const result = await runPlan({
    plan, workspace: repository, createRunner: () => demoRunner,
    isolation: "git-worktree", verificationTaskId: "verify", maxParallel: 2,
  });
  assert.equal(result.snapshot.status, "succeeded");
  assert.equal(result.snapshot.maxParallel, 2);
  assert.equal(peakWorkers, 2, "both independent Runner tasks must overlap");
  assert.match(testOutput, /# pass 3/);
  assert.match(testOutput, /# fail 0/);
  assert.deepEqual(result.snapshot.tasks.map(({ status }) => status), ["succeeded", "succeeded", "succeeded"]);
  const sourceHead = await git(repository, ["rev-parse", "HEAD"]);
  assert.equal(sourceHead, baseCommit, "the caller checkout stays on its original commit");
  assert.equal(await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const store = new SessionStore(repository);
  const record = await store.load(result.snapshot.sessionId);
  const siblingAttempts = record.isolationJournal.attempts.filter(({ taskId }) => taskId === "greeting" || taskId === "normalizer");
  assert.equal(siblingAttempts.length, 2);
  assert.ok(siblingAttempts.every((attempt) => attempt.baseCommit === baseCommit && attempt.status === "landed" && attempt.mergeParents.length === 2));
  const delivery = await createSessionDelivery(record, store);
  const diff = await execFile("git", ["diff", "--binary", "--no-ext-diff", delivery.baseCommit, delivery.integrationHead], { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  await writeFile(patchPath, diff.stdout, "utf8");
  const deliveryInstructions = join(demoRoot, "delivery-instructions.txt");
  await writeFile(deliveryInstructions, `${formatSessionDelivery(delivery, repository)}\n`, "utf8");

  report.status = "succeeded";
  report.repository = repository;
  report.sessionId = result.snapshot.sessionId;
  report.baseCommit = baseCommit;
  report.integrationHead = delivery.integrationHead;
  report.maxParallel = result.snapshot.maxParallel;
  report.peakConcurrency = peakWorkers;
  report.taskStatuses = result.snapshot.tasks.map(({ taskId, status }) => ({ taskId, status }));
  report.changedFiles = delivery.changedFiles;
  report.testOutput = testOutput;
  report.deliveryDiff = patchPath;
  report.deliveryInstructions = deliveryInstructions;
  report.checks.push(
    "two independent Runner tasks overlapped in isolated Attempt worktrees",
    "sibling commits share the batch base and are preserved by ordered two-parent merges",
    "fan-in verification ran node --test against the integrated worktree (3 passed)",
    "the caller checkout stayed clean and at the original commit",
    "delivery diff is bound to the verified integration head",
  );
  console.log(JSON.stringify({ status: report.status, sessionId: report.sessionId, peakConcurrency: report.peakConcurrency,
    taskStatuses: report.taskStatuses, changedFiles: report.changedFiles, testOutput, deliveryDiff: patchPath,
    deliveryInstructions, checks: report.checks }, null, 2));
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report: ${reportPath}`);
}
