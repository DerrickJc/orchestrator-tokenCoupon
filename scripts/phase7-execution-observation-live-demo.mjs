import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDefaultRunnerRegistry, executeTask } from '../packages/core/dist/index.js';
import { readAttemptEvents, readAttemptInfo } from '../packages/daemon/dist/attempt-observation.js';

// Explicit real inference and real tool execution, isolated from the user's project and daemon.
const output = resolve('demo-workspace', `phase7-observation-live-${new Date().toISOString().replaceAll(':', '-')}`);
const workspace = join(output, 'workspace'); await mkdir(workspace, { recursive: true });
const fixture = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ordinary name',()=>assert.equal(`Hello, ${'World'}!`,'Hello, World!'));\ntest('empty name',()=>assert.equal(`Hello, ${''}!`,'Hello, !'));\n";
await writeFile(join(workspace, 'verify.test.mjs'), fixture);
const runnerId = process.env.PHASE7_OBSERVATION_RUNNER || 'codex';
const task = { schemaVersion: 1, id: 'observe-real-output', title: '真实执行输出与测试证据', prompt: 'This is a tiny execution-observation acceptance test. Do not change any files, install dependencies, delegate, inspect other directories or run Git. Emit a brief Chinese progress message. Run exactly node --test --test-isolation=none verify.test.mjs once in the task cwd. Report the real pass/fail count in a concise Chinese final response, with a fenced code block showing the command. Follow the completion protocol below exactly. Do not ask questions.', execution: { runnerId, mode: 'managed', ...(process.env.PHASE7_OBSERVATION_MODEL ? { modelId: process.env.PHASE7_OBSERVATION_MODEL } : {}) } };
const runner = createDefaultRunnerRegistry().resolve(task).runner;
const abort = new AbortController(), deadline = setTimeout(() => abort.abort(new Error('live demo deadline')), 180000); deadline.unref();
const report = { status: 'running', realRunnerExecution: true, realWebClients: false, runnerId, output, interactions: [], outputChunks: 0 };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
try {
  await runner.checkAvailable();
  const result = await executeTask({ task, cwd: workspace, runner, signal: abort.signal, onOutput: () => report.outputChunks++, onInteraction: async (requestId, request) => {
    const command = request.operation?.command || '';
    const allowed = request.kind === 'approval' && (command === 'node --test --test-isolation=none verify.test.mjs' || /^\/(?:usr\/)?bin\/(?:ba)?sh -lc ['"]?node --test --test-isolation=none verify\.test\.mjs['"]?$/.test(command));
    report.interactions.push({ requestId, kind: request.kind, allowed });
    if (request.kind === 'question') throw new Error('Unexpected question in fixed acceptance scenario');
    return { kind: 'approval', decision: allowed ? 'allow-once' : 'deny' };
  } });
  report.attemptId = result.attempt.attemptId; report.artifactDir = result.artifactDir; report.attemptStatus = result.attempt.status;
  const records = []; let offset = 0, fileId;
  for (;;) { const page = await readAttemptEvents(workspace, report.attemptId, offset, fileId); records.push(...page.events); offset = page.cursor; fileId = page.fileId; if (!page.hasMore) break; }
  const info = await readAttemptInfo(workspace, report.attemptId);
  report.reportedModel = info.reportedModel || null;
  report.commandEvidence = records.filter(event => event.type === 'command.completed').map(event => event.payload);
  report.completedMessages = records.filter(event => event.type === 'message.completed').length;
  report.finalTextPersisted = records.some(event => typeof event.payload?.finalText === 'string' && event.payload.finalText.length > 0);
  report.checks = { attemptSucceeded: result.attempt.status === 'succeeded', fixtureUnchanged: await readFile(join(workspace, 'verify.test.mjs'), 'utf8') === fixture, semanticMessagePersisted: report.completedMessages > 0, finalTextPersisted: report.finalTextPersisted, actualCommandPassed: report.commandEvidence.some(event => event.exitCode === 0 && event.command.includes('node --test --test-isolation=none verify.test.mjs') && /pass\s+2/.test(event.outputSummary || '')) };
  report.status = Object.values(report.checks).every(Boolean) ? 'succeeded' : 'failed'; await save();
  assert.equal(report.status, 'succeeded', 'See the isolated report for actual Runner evidence');
  console.log(JSON.stringify({ output, status: report.status, reportedModel: report.reportedModel, checks: report.checks }));
} catch (error) { report.status = 'failed'; report.error = error.message; await save(); throw error; }
finally { clearTimeout(deadline); }
