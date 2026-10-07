import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cleanupSessionWorktrees, createSessionDelivery, formatSessionDelivery,
  parsePlan, resumeSession, retrySession, runPlan, SessionStore,
} from "../packages/core/dist/index.js";

const execFile = promisify(execFileCallback);
const stamp = new Date().toISOString().replaceAll(":", "-");
const demoRoot = resolve("demo-workspace", "phase4-demo", stamp);
const repository = join(demoRoot, "repository");
const hooksDirectory = join(demoRoot, "empty-hooks");
const reportPath = join(demoRoot, "phase4-demo-report.json");
const patchPath = join(demoRoot, "deliveryDiff.patch");
await mkdir(repository, { recursive: true });
await mkdir(hooksDirectory, { recursive: true });

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function runNode(cwd, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`node ${args.join(" ")} stopped by ${signal}`));
      else resolveResult({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

class DemoRunner {
  id = "mock";
  supportsModel = false;
  implementationRuns = 0;
  testOutput = "";
  failedAttemptPath = null;

  async checkAvailable() {}

  async run(input, context) {
    context.onStarted();
    assert.equal(await readFile(join(input.cwd, ".phase4-setup-cache"), "utf8"), "ready\n");
    const send = (text, withMarker = true) => {
      const finalText = withMarker ? `${text}\n${input.completionMarker}\n` : text;
      context.onOutput({ stream: "stdout", text: finalText, agentText: finalText });
    };

    if (input.task.id === "implement") {
      this.implementationRuns += 1;
      if (this.implementationRuns === 1) {
        this.failedAttemptPath = input.cwd;
        await writeFile(join(input.cwd, "failed-attempt-only.txt"), "preserve this failed attempt\n", "utf8");
        send("Simulated Runner failure before the completion marker.", false);
        return { started: true, exitCode: 1, signal: null };
      }
      await writeFile(join(input.cwd, "greet.mjs"), "export function greet(name) { return `Hello, ${name}!`; }\n", "utf8");
      send("Created greet.mjs.");
      return { started: true, exitCode: 0, signal: null };
    }

    if (input.task.id === "tests") {
      assert.equal(await readFile(join(input.cwd, "greet.mjs"), "utf8").then((text) => text.includes("export function greet")), true);
      await writeFile(join(input.cwd, "greet.test.mjs"), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { greet } from './greet.mjs';",
        "test('greets a name', () => assert.equal(greet('World'), 'Hello, World!'));",
        "test('accepts an empty name', () => assert.equal(greet(''), 'Hello, !'));",
        "",
      ].join("\n"), "utf8");
      send("Created greet.test.mjs.");
      return { started: true, exitCode: 0, signal: null };
    }

    assert.equal(input.task.id, "verify");
    const test = await runNode(input.cwd, ["--test", "--test-reporter=tap", "greet.test.mjs"]);
    this.testOutput = test.output;
    send(test.output, test.code === 0);
    return { started: true, exitCode: test.code, signal: null };
  }
}

const runner = new DemoRunner();
const createRunner = () => runner;
const executionPlan = parsePlan({
  schemaVersion: 1,
  id: "phase4-worktree-demo",
  title: "Phase 4 worktree delivery demonstration",
  tasks: [
    { task: { schemaVersion: 1, id: "implement", title: "Implement greeting", prompt: "Implement a greeting function.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: [], status: "planned" },
    { task: { schemaVersion: 1, id: "tests", title: "Add tests", prompt: "Add tests for the greeting function.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: ["implement"], status: "planned" },
    { task: { schemaVersion: 1, id: "verify", title: "Run final verification", prompt: "Run the complete test suite without modifying source files.", execution: { runnerId: "mock", mode: "non_interactive" } }, dependsOn: ["tests"], status: "planned" },
  ],
});
const setupProfile = {
  schemaVersion: 1,
  commands: [{ executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('.phase4-setup-cache', 'ready\\n')"] }],
};
const report = { schemaVersion: 1, status: "running", demoRoot, checks: [] };

try {
  await git(repository, ["init", "--initial-branch=main", "--quiet"]);
  await git(repository, ["config", "user.name", "Token Coupon Phase 4 Demo"]);
  await git(repository, ["config", "user.email", "token-coupon-phase4@example.invalid"]);
  await git(repository, ["config", "core.hooksPath", hooksDirectory]);
  await writeFile(join(repository, ".gitignore"), ".token-coupon/\n.env\n.phase4-setup-cache\n", "utf8");
  await writeFile(join(repository, "README.md"), "Isolated worktree demonstration repository.\n", "utf8");
  await git(repository, ["add", ".gitignore", "README.md"]);
  await git(repository, ["commit", "--quiet", "-m", "initial demo repository"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);

  const failed = await runPlan({
    plan: executionPlan, workspace: repository, createRunner, isolation: "git-worktree",
    verificationTaskId: "verify", setupProfile,
  });
  assert.equal(failed.snapshot.status, "failed");
  assert.deepEqual(failed.snapshot.tasks.map(({ status }) => status), ["failed", "blocked", "blocked"]);
  const failedAttemptId = failed.snapshot.tasks[0].attempts[0].attemptId;
  const store = new SessionStore(repository);
  const failedRecord = await store.load(failed.snapshot.sessionId);
  const failedJournal = failedRecord.isolationJournal;
  const failedAttempt = failedJournal.attempts.find(({ attemptId }) => attemptId === failedAttemptId);
  assert.equal(failedAttempt.status, "failed");
  assert.equal(await readFile(join(failedAttempt.worktreePath, "failed-attempt-only.txt"), "utf8"), "preserve this failed attempt\n");
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), baseCommit);

  const retried = await retrySession({
    sessionId: failed.snapshot.sessionId, workspace: repository, createRunner, taskId: "implement", setupProfile,
  });
  assert.equal(retried.operationStatus, "succeeded");
  const implementAttempts = retried.snapshot.tasks[0].attempts;
  assert.equal(implementAttempts.length, 2);
  const retryRecord = await store.readAttempt(implementAttempts[1].attemptId);
  assert.notEqual(retryRecord.cwd, runner.failedAttemptPath);
  await assert.rejects(readFile(join(retryRecord.cwd, "failed-attempt-only.txt"), "utf8"), { code: "ENOENT" });

  const resumed = await resumeSession({ sessionId: failed.snapshot.sessionId, workspace: repository, createRunner, setupProfile });
  assert.equal(resumed.snapshot.status, "succeeded");
  assert.deepEqual(resumed.snapshot.tasks.map(({ status }) => status), ["succeeded", "succeeded", "succeeded"]);
  assert.match(runner.testOutput, /# pass 2/);
  assert.match(runner.testOutput, /# fail 0/);
  assert.equal(await git(repository, ["rev-parse", "HEAD"]), baseCommit, "the caller's checkout stays at the original commit");
  assert.equal(await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const completedRecord = await store.load(failed.snapshot.sessionId);
  const delivery = await createSessionDelivery(completedRecord, store);
  assert.deepEqual(delivery.changedFiles, ["greet.mjs", "greet.test.mjs"]);
  const diff = await execFile("git", ["diff", "--binary", "--no-ext-diff", delivery.baseCommit, delivery.integrationHead], {
    cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(patchPath, diff.stdout, "utf8");
  await writeFile(join(demoRoot, "delivery-instructions.txt"), `${formatSessionDelivery(delivery, repository)}\n`, "utf8");
  assert.equal((await stat(delivery.integrationWorktree)).isDirectory(), true);

  const cleanup = await cleanupSessionWorktrees({ sessionId: failed.snapshot.sessionId, workspace: repository });
  assert.equal(cleanup.removedWorktrees.length, 3);
  assert.equal(cleanup.retainedWorktrees.some(({ path }) => path === failedAttempt.worktreePath), true);
  assert.equal((await stat(failedAttempt.worktreePath)).isDirectory(), true, "failed Attempt remains available for inspection");
  assert.equal((await stat(delivery.integrationWorktree)).isDirectory(), true, "integration worktree remains available for review");

  const finalRecord = await store.load(failed.snapshot.sessionId);
  const attempts = finalRecord.snapshot.tasks.flatMap(({ attempts: items }) => items.map(({ attemptId }) => attemptId));
  const artifactDirs = await Promise.all(attempts.map(async (attemptId) => {
    const attempt = await store.readAttempt(attemptId);
    assert.equal(attempt.artifactDir, join(repository, ".token-coupon", "runs", attemptId));
    return attempt.artifactDir;
  }));
  report.status = "succeeded";
  report.repository = repository;
  report.sessionId = failed.snapshot.sessionId;
  report.baseCommit = baseCommit;
  report.integrationHead = delivery.integrationHead;
  report.sourceCheckoutHead = await git(repository, ["rev-parse", "HEAD"]);
  report.taskStatuses = resumed.snapshot.tasks.map(({ taskId, status }) => ({ taskId, status }));
  report.testOutput = runner.testOutput;
  report.changedFiles = delivery.changedFiles;
  report.diffSha256 = delivery.diffSha256;
  report.deliveryDiff = patchPath;
  report.deliveryInstructions = join(demoRoot, "delivery-instructions.txt");
  report.centralArtifactDirs = artifactDirs;
  report.cleanup = cleanup;
  report.checks.push(
    "failed Runner Attempt stayed isolated and inspectable",
    "retry used a fresh worktree without failed-attempt files",
    "dependent tasks ran only after commits were integrated",
    "Node test runner reported 2 passing tests",
    "source checkout stayed clean at the original HEAD",
    "delivery diff is tied to the final verification commit",
    "cleanup removed successful Attempt worktrees and retained the failed Attempt and integration worktree",
  );
  console.log(JSON.stringify({ status: report.status, sessionId: report.sessionId, taskStatuses: report.taskStatuses,
    changedFiles: report.changedFiles, testOutput: report.testOutput, deliveryDiff: report.deliveryDiff,
    deliveryInstructions: report.deliveryInstructions, checks: report.checks }, null, 2));
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report: ${reportPath}`);
}
