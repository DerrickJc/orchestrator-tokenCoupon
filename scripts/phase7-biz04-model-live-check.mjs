import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ClaudeManagedRunner, executeTask } from '../packages/core/dist/index.js';

// One isolated native call; never repairs or rewrites a historical BIZ-04 Attempt.
const root = resolve('demo-workspace', `phase7-biz04-model-check-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(root, { recursive: true });
const task = {
  schemaVersion: 1, id: 'native-model-evidence', title: 'Claude SDK 模型证据实机回归',
  prompt: '仅验证宿主的模型元信息采集。不调用工具、不读取文件、不修改文件、不执行命令、不进行规划。回复“模型采集验证完成”，并按完成协议输出本次完成标记。',
  execution: { runnerId: 'claude-code', mode: 'managed', modelId: 'deepseek-flash' },
};
const runner = new ClaudeManagedRunner({ permissionMode: 'plan', strictMcpConfig: true, settingSources: ['user'], disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task'] });
const controller = new AbortController();
let deadlineExceeded = false;
const timer = setTimeout(() => { deadlineExceeded = true; controller.abort(new Error('Live regression exceeded 90 seconds')); }, 90_000);
let deniedInteractions = 0;
console.log(`独立模型证据回归：${root}`);
try {
  const { attempt, artifactDir } = await executeTask({ task, cwd: root, runner, signal: controller.signal,
    onInteraction: async (_id, request) => {
      deniedInteractions++;
      if (request.kind === 'approval') return { kind: 'approval', decision: 'deny' };
      if (request.kind === 'question') return { kind: 'question', answers: [], guidance: 'Only return the requested text. No tools or further questions.' };
      return { kind: 'elicitation', action: 'decline' };
    },
  });
  const passed = attempt.status === 'succeeded' && !!attempt.reportedModel && ['claude-sdk-assistant', 'claude-sdk-model-usage'].includes(attempt.reportedModelSource);
  const report = { scope: 'One new model telemetry call; does not certify historical BIZ-04 tasks', status: passed ? 'PASS' : deadlineExceeded ? 'BLOCKED_EXTERNAL' : 'NOT_PASSED', stopCause: deadlineExceeded ? 'regression_deadline' : null, taskStatus: attempt.status, configuredModel: task.execution.modelId, reportedModel: attempt.reportedModel ?? null, reportedModelSource: attempt.reportedModelSource ?? null, deniedInteractions, attemptId: attempt.attemptId, artifactDir, reasonCode: attempt.reasonCode };
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally { clearTimeout(timer); }
