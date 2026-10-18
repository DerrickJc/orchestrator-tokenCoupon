import { readFile, readdir, mkdir, writeFile, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateVerificationStatus, httpAcceptancePassed } from './biz04-verification-status.mjs';

const exec=promisify(execFile);
const argv=process.argv.slice(2);
if(argv.includes('--help')) { console.log('node scripts/phase7-biz04-inspect.mjs --repo p3 [--session UUID] [--root BATCH_DIRECTORY] [--run-http]\nDefault: read-only Git/session checks; --run-http explicitly starts the trusted HTTP test against the integration worktree.'); process.exit(0); }
function arg(name) { const i=argv.indexOf(name); return i<0?undefined:argv[i+1]; }
const root=resolve(arg('--root') || fileURLToPath(new URL('../demo-workspace/phase7-biz04-prepared-20261018/',import.meta.url)));
const repoArg=arg('--repo');
if(!repoArg) throw new Error('Pass --repo p1, p2 or p3.');
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const config=manifest.repositories.find(x=>x.name===`biz-04-cross-dag-${repoArg}` || x.path===resolve(repoArg));
if(!config) throw new Error('Only the three prepared fixture repositories are accepted.');
const cwd=config.path, readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const git=async args=>(await exec('git',args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024})).stdout.trim();
const hash=data=>createHash('sha256').update(data).digest('hex');
const report={ testId:'BIZ-04',checkedAt:new Date().toISOString(),repository:cwd,maxParallel:config.maxParallel,localStatus:'NOT_RUN',webStatus:'NOT_RUN',status:'NOT_RUN',checks:[],attempts:[],notes:['Local evidence cannot prove real webpage planning/review or human approval. Record those separately in manual-verification.json.'] };
const check=(name,pass,detail)=>report.checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
const evidenceDir=join(root,'evidence',`p${config.maxParallel}`); await mkdir(evidenceDir,{recursive:true});
const stamp=report.checkedAt.replaceAll(':','-');
async function save() {
  updateVerificationStatus(report);
  const path=join(evidenceDir,`local-report-${stamp}.json`);
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:path,status:report.status,localStatus:report.localStatus,webStatus:report.webStatus,sessionId:report.sessionId,httpStatus:report.http?.status||'NOT_RUN',error:report.error,peakRunningAttempts:report.peakRunningAttempts,failedChecks:report.checks.filter(x=>!x.pass)},null,2));
}
try {
  check('original main still at preparation baseline',(await git(['rev-parse','main']))===config.baseline);
  check('original workspace clean',(await git(['status','--porcelain=v1'])).length===0);
  for(const [path,sha] of Object.entries(config.protectedFiles)) check(`original fixture unchanged: ${path}`,hash(await readFile(join(cwd,path)))===sha);
  let sessionId=arg('--session');
  const sessionRoot=join(cwd,'.token-coupon/sessions');
  if(!sessionId) {
    let choices=[]; try { choices=(await readdir(sessionRoot,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name); } catch(error) { if(error.code!=='ENOENT') throw error; }
    if(choices.length===0) { report.notes.push('Fixture is ready; no Session has been created. Expected before the user starts BIZ-04.'); await save(); process.exit(report.checks.every(x=>x.pass)?0:1); }
    if(choices.length!==1) throw new Error('Multiple Sessions found; pass --session UUID explicitly.');
    sessionId=choices[0];
  }
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('Invalid Session UUID.');
  report.sessionId=sessionId;
  const sessionDir=join(sessionRoot,sessionId);
  const [session,plan,journal]=await Promise.all(['session.json','plan.json','isolation.json'].map(name=>readJson(join(sessionDir,name))));
  report.sessionStatus=session.status;
  check('Session belongs to selected repository',resolve(session.workspace)===resolve(cwd));
  check('git-worktree isolation',session.isolation?.mode==='git-worktree');
  check('configured parallelism matches fixture',session.maxParallel===config.maxParallel);
  check('V is the final verification task',session.isolation?.verificationTaskId==='V');
  check('exactly nine expected tasks',plan.tasks.length===9 && plan.tasks.every(x=>Object.hasOwn(manifest.dependencies,x.task.id)) && new Set(plan.tasks.map(x=>x.task.id)).size===9);
  for(const [id,deps] of Object.entries(manifest.dependencies)) {
    const entry=plan.tasks.find(x=>x.task.id===id);
    check(`${id} dependency set`,JSON.stringify([...(entry?.dependsOn||[])].sort())===JSON.stringify([...deps].sort()));
    check(`${id} runner/model/mode`,entry?.task.execution?.runnerId===manifest.roles[id][2] && entry?.task.execution?.modelId===manifest.roles[id][3] && entry?.task.execution?.mode==='managed');
  }
  const events=(await readFile(join(sessionDir,'scheduler-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const timeline=[];
  let lastSequence=0;
  for(const e of events) {
    check(`scheduler sequence ${e.sequence}`,Number.isInteger(e.sequence)&&e.sequence>lastSequence); lastSequence=e.sequence;
    timeline.push({at:e.occurredAt,sequence:e.sequence,event:e.event,taskId:e.taskId,attemptId:e.attemptId,waveId:e.waveId,reasonCode:e.reasonCode});
    if(e.event==='attempt.dispatched') for(const dep of manifest.dependencies[e.taskId]||[]) check(`${e.taskId} dispatched after ${dep} landed`,events.some(x=>x.event==='task.landed'&&x.taskId===dep&&x.sequence<e.sequence));
  }
  await writeFile(join(evidenceDir,`timeline-${stamp}.jsonl`),timeline.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const points=[];
  for(const task of session.tasks) for(const ref of task.attempts) {
    const attempt=await readJson(join(cwd,'.token-coupon/runs',ref.attemptId,'attempt.json'));
    const item={taskId:task.taskId,attemptId:attempt.attemptId,status:attempt.status,runnerId:attempt.runnerId,reportedModel:attempt.reportedModel||null,configuredModel:attempt.execution?.modelId,reportedModelSource:attempt.reportedModelSource||null,startedAt:attempt.startedAt,finishedAt:attempt.finishedAt,transport:attempt.transport,reasonCode:attempt.reasonCode};
    report.attempts.push(item);
    const a=Date.parse(attempt.startedAt), b=Date.parse(attempt.finishedAt);
    if(Number.isFinite(a)&&Number.isFinite(b)) points.push([a,1],[b,-1]);
    check(`${ref.attemptId} uses real runner`,['codex','claude-code'].includes(attempt.runnerId) && !String(attempt.transport||'').includes('mock'));
    if(attempt.status==='succeeded') check(`${ref.attemptId} has observed model`,typeof attempt.reportedModel==='string'&&attempt.reportedModel.length>0);
  }
  let active=0,peak=0;
  for(const [,delta] of points.sort((a,b)=>a[0]-b[0]||a[1]-b[1])) { active+=delta; peak=Math.max(peak,active); }
  report.peakRunningAttempts=peak;
  check('observed Attempt intervals respect parallel limit',peak<=config.maxParallel);
  if(session.status==='succeeded') check('parallel overlap was observed',config.maxParallel===1 || peak>=2);
  if(config.maxParallel===3 && peak<3) report.notes.push('Three simultaneous running Attempt intervals were not observed. Review timeline before claiming the three-way fan-out observation passed.');
  const finalHead=await git(['rev-parse',session.isolation.integrationBranch]);
  report.integrationHead=finalHead;
  check('integration journal matches actual branch',journal.integrationHead===finalHead);
  let protectedOK=true;
  for(const [path,sha] of Object.entries(config.protectedFiles)) {
    // Compare raw bytes; Git text trimming would change the protected hash.
    const data=(await exec('git',['show',`${finalHead}:${path}`],{cwd,encoding:'buffer'})).stdout;
    const ok=hash(data)===sha; protectedOK&&=ok; check(`integrated fixture unchanged: ${path}`,ok);
  }
  const matrix=new Map(plan.tasks.map(x=>[x.task.id,x]));
  for(const item of journal.attempts) {
    const owned=manifest.roles[item.taskId]?.[1]||[];
    if(item.taskId!=='V') check(`${item.taskId}/${item.attemptId} only touches owned files`,item.changedFiles.every(path=>owned.includes(path)),item.changedFiles);
    for(const dep of matrix.get(item.taskId)?.dependsOn||[]) {
      const previous=journal.attempts.find(x=>x.taskId===dep&&x.status==='landed'&&x.taskCommit);
      let ancestor=false;
      if(previous) { try { await git(['merge-base','--is-ancestor',previous.taskCommit,item.baseCommit]); ancestor=true; } catch {} }
      check(`${item.taskId}/${item.attemptId} baseline includes ${dep}`,ancestor);
    }
  }
  if(session.status==='succeeded') {
    check('all nine tasks succeeded',session.tasks.length===9&&session.tasks.every(x=>x.status==='succeeded'));
    check('normal path: one Attempt per task',session.tasks.every(x=>x.attempts.length===1));
    for(const id of Object.keys(manifest.dependencies)) check(`${id} exactly one successful landing`,events.filter(x=>x.event==='task.landed'&&x.taskId===id).length===1);
    const integrationPath=session.isolation.integrationWorktree;
    check('integration worktree path matches prepared Session',resolve(integrationPath)===join(cwd,'.token-coupon/worktrees',sessionId,'integration'));
    const real=await stat(integrationPath); check('integration worktree exists',real.isDirectory());
    const status=(await exec('git',['status','--porcelain=v1'],{cwd:integrationPath,encoding:'utf8'})).stdout.trim();
    check('integration worktree is clean',status==='');
    check('integration worktree HEAD matches final branch',(await exec('git',['rev-parse','HEAD'],{cwd:integrationPath,encoding:'utf8'})).stdout.trim()===finalHead);
    for(const [path,sha] of Object.entries(config.protectedFiles)) { const ok=hash(await readFile(join(integrationPath,path)))===sha; protectedOK&&=ok; check(`working fixture unchanged: ${path}`,ok); }
    for(const [id,[,paths]] of Object.entries(manifest.roles)) for(const path of paths) {
      try { await access(join(integrationPath,path)); check(`${id} artifact exists: ${path}`,true); } catch { check(`${id} artifact exists: ${path}`,false); }
    }
    if(argv.includes('--run-http')) {
      if(!protectedOK||!report.checks.every(x=>x.pass)) {
        report.http={status:'NOT_RUN',reason:'preflight_failed'};
        throw new Error('Preflight checks failed; HTTP acceptance was not run. See failedChecks for the preserved failures.');
      }
      const startedAt=new Date().toISOString();
      let stdout='',stderr='',code=0;
      try { const out=await exec(process.execPath,['--test','--test-reporter=tap','tests/acceptance.test.mjs'],{cwd:integrationPath,env:{...process.env,BIZ04_TARGET_ROOT:integrationPath},encoding:'utf8',timeout:40000,maxBuffer:2*1024*1024}); stdout=out.stdout;stderr=out.stderr; }
      catch(error) { stdout=error.stdout||'';stderr=error.stderr||'';code=error.code||1; }
      const log=join(evidenceDir,`http-${stamp}.tap`); await writeFile(log,stdout+'\n'+stderr);
      const passed=httpAcceptancePassed(stdout,code);
      report.http={status:passed?'PASS':'FAIL',command:'node --test --test-reporter=tap tests/acceptance.test.mjs',startedAt,exitCode:code,log,tests:Number(stdout.match(/^# tests (\d+)/m)?.[1]||0),passed:Number(stdout.match(/^# pass (\d+)/m)?.[1]||0)};
      check('fixed real HTTP acceptance passed',passed);
      check('HTTP test did not change integration HEAD',(await exec('git',['rev-parse','HEAD'],{cwd:integrationPath,encoding:'utf8'})).stdout.trim()===finalHead);
      check('HTTP test left integration worktree clean',(await exec('git',['status','--porcelain=v1'],{cwd:integrationPath,encoding:'utf8'})).stdout.trim()==='');
      for(const [path,sha] of Object.entries(config.protectedFiles)) check(`fixture unchanged after HTTP test: ${path}`,hash(await readFile(join(integrationPath,path)))===sha);
      check('HTTP test left original main unchanged',(await git(['rev-parse','main']))===config.baseline);
      check('HTTP test left original workspace clean',(await git(['status','--porcelain=v1'])).length===0);
    } else report.notes.push('Pass --run-http to execute fixed real HTTP acceptance after inspecting these checks.');
    await writeFile(join(evidenceDir,`git-${stamp}.txt`),await git(['log','--graph','--oneline','--decorate',session.isolation.integrationBranch]));
    // save() derives status consistently for normal, early and exception paths.
  } else {
    report.notes.push('Session has not succeeded. Preserve evidence and inspect the actual failure or waiting request before retrying; this script does not change state.');

  }

  await save();
  process.exitCode=report.checks.every(x=>x.pass)?0:1;
} catch(error) { report.error=error.message; await save(); process.exitCode=1; }
