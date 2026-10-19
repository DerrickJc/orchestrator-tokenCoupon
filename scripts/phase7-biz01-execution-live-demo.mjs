import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDefaultRunnerRegistry, executeTask, parseTask } from '../packages/core/dist/index.js';

const exec = promisify(execFile);
async function verifyArtifacts(report) {
  const { repository, worktree, baseline, artifactDir } = report;
  const attempt = JSON.parse(await readFile(join(artifactDir, 'attempt.json'), 'utf8'));
  report.attemptStatus = attempt.status; report.reportedModel = attempt.reportedModel || null;
  const events = (await readFile(join(artifactDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  report.mcpCalls = events.filter(event => event.type === 'tool.started' && event.payload.name === 'mcpToolCall').map(event => ({ serverName: event.payload.serverName, toolName: event.payload.toolName }));
  const original = (await exec('git', ['show', `${baseline}:verify.design.test.mjs`], { cwd: repository, encoding: 'utf8' })).stdout;
  const trustedVerificationUnchanged = createHash('sha256').update(await readFile(join(worktree, 'verify.design.test.mjs'))).digest('hex') === createHash('sha256').update(original).digest('hex');
  assert.ok(trustedVerificationUnchanged, 'Do not execute an acceptance script changed by the Runner');
  const tests = await exec(process.execPath, ['--test', '--test-reporter=tap', '--test-isolation=none', 'verify.design.test.mjs'], { cwd: worktree, encoding: 'utf8' });
  report.verification = { command: 'node --test --test-reporter=tap --test-isolation=none verify.design.test.mjs', stdout: tests.stdout, stderr: tests.stderr };
  // NUL-delimited porcelain preserves non-ASCII names and avoids Git display quoting.
  const changes = (await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' })).stdout.split('\0').filter(Boolean);
  report.changes = changes;
  report.checks = {
    attemptSucceeded: attempt.status === 'succeeded',
    noRepeatedApprovalQuestion: report.interactions.every(item => item.kind === 'approval'),
    noMcpCalls: report.mcpCalls.length === 0,
    onlyDesignFilesChanged: changes.length >= 2 && changes.every(line => line.startsWith('?? ') && line.endsWith('.md')),
    trustedVerificationUnchanged,
    baselineUnchanged: (await exec('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' })).stdout.trim() === baseline,
    originalWorkspaceClean: (await exec('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' })).stdout.trim() === '',
    actualVerificationPassed: /# pass 3\b/.test(tests.stdout) && /# fail 0\b/.test(tests.stdout),
  };
  report.status = Object.values(report.checks).every(Boolean) ? 'succeeded' : 'failed';
}
if (process.argv[2] === '--recheck') {
  assert.ok(process.argv[3], 'Provide the previous isolated output directory');
  const output = resolve(process.argv[3]), reportPath = join(output, 'report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.recheck = { previousStatus: report.status, previousError: report.error, modelInvoked: false, at: new Date().toISOString() };
  delete report.error;
  await verifyArtifacts(report);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, status: report.status, reportedModel: report.reportedModel, checks: report.checks }, null, 2));
  assert.equal(report.status, 'succeeded');
  process.exit(0);
}

// Real Codex regression for the BIZ-01 execution/approval confusion; no webpage impersonation.
// All repositories and outputs stay in this new demo directory; the active user's Session is untouched.
const output = resolve('demo-workspace', `phase7-biz01-execution-live-${new Date().toISOString().replaceAll(':', '-')}`);
const repository = join(output, 'repository'), worktree = join(output, 'attempt-worktree');
await mkdir(repository, { recursive: true });
const git = async (...args) => (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
const verification = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
async function docs(path='.') {
 const result=[];
 for(const entry of await readdir(path,{withFileTypes:true})) {
  if(entry.name.startsWith('.') || entry.name==='node_modules') continue;
  const p=join(path,entry.name);
  if(entry.isDirectory())result.push(...await docs(p));
  else if(entry.name.endsWith('.md'))result.push(p);
 }
 return result;
}
const paths=await docs();
const text=(await Promise.all(paths.map(p=>readFile(p,'utf8')))).join('\n');
test('two design documents exist',()=>assert.ok(paths.length>=2));
test('course and teacher HTTP contracts exist',()=>{for(const value of ['/courses','/teachers','GET','POST','PUT','DELETE'])assert.ok(text.includes(value),value)});
test('error responses and memory lifecycle are documented',()=>{for(const value of ['400','404','405'])assert.ok(text.includes(value),value);assert.match(text,/内存|memory/i);assert.match(text,/重启|restart/i)});
`;
await writeFile(join(repository, '.gitignore'), '.token-coupon/\n');
await writeFile(join(repository, 'verify.design.test.mjs'), verification);
await git('init', '-b', 'main');
await git('add', '.gitignore', 'verify.design.test.mjs');
await git('-c', 'user.name=Token Coupon Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'test: seed protected design acceptance');
const baseline = await git('rev-parse', 'HEAD');
await git('worktree', 'add', '-b', 'biz01-design', worktree, baseline);
const task = parseTask(JSON.parse(await readFile(new URL('../packages/core/test/fixtures/biz01-design-task.json', import.meta.url), 'utf8')));
task.execution.modelId = process.env.PHASE7_BIZ01_MODEL || task.execution.modelId;
task.prompt += `\n\nGit worktree 执行约定：\n- 当前工作目录：${worktree}\n- 本任务基线：${baseline}\n- 只在当前 worktree 写本任务所需 Markdown 文档；不要创建提交、切换分支或启动另一个 Runner。\n- verify.design.test.mjs 是测试方固定验收脚本，不能修改。\n`;
const runner = createDefaultRunnerRegistry().resolve(task).runner;
const report = { status: 'running', scope: 'isolated BIZ-01 design execution regression, not the complete webpage business test', sourceAttemptId: 'b2a281dc-a39a-4b11-9150-49ad862d826b', realRunner: true, realWebClients: false, configuredModel: task.execution.modelId, output, repository, worktree, baseline, interactions: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const controller = new AbortController();
// Test-harness deadline, independent of production execution policy.
const deadline = setTimeout(() => controller.abort(new Error('live regression test deadline')), 240_000);
deadline.unref();
try {
  await runner.checkAvailable();
  const result = await executeTask({ task, cwd: worktree, artifactWorkspace: repository, runner, signal: controller.signal, onInteraction: async (requestId, request) => {
    report.interactions.push({ requestId, kind: request.kind, title: request.title }); await save();
    if (request.kind !== 'approval') throw new Error('Unexpected question or elicitation in the fully specified design task');
    return { kind: 'approval', decision: 'deny', guidance: '只在当前 worktree 读取固定验收脚本并编写 Markdown 设计文档；不要联网、安装依赖或调用 4177 核验计划。' };
  } });
  report.attemptId = result.attempt.attemptId; report.artifactDir = result.artifactDir;
  report.attemptStatus = result.attempt.status; report.reason = result.attempt.reason; report.reportedModel = result.attempt.reportedModel || null;
  await verifyArtifacts(report); await save();
  assert.equal(report.status, 'succeeded', 'See isolated report for regression evidence');
  console.log(JSON.stringify({ output, status: report.status, reportedModel: report.reportedModel, checks: report.checks }, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = error.message; if (typeof error.stdout === 'string') report.verificationOutput = error.stdout;
  await save(); throw error;
} finally { clearTimeout(deadline); }
