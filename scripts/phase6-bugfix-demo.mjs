import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  startPlannerConversation, DeepSeekPlanner, PlannerStore, SessionStore,
  diagnoseSession, recoverSession, CodexRunner, parsePlan, runPlan, retrySession, resumeSession,
  reviewPlannerDraft, replacePlannerDraft, approvePlannerDraft,
} from '../packages/core/dist/index.js';
import { createRunnerInteractionHandler } from '../packages/cli/dist/interaction-cli.js';
import { TerminalInput } from '../packages/cli/dist/terminal-input.js';
import { PassThrough } from 'node:stream';

const root = resolve('demo-workspace', 'phase6-bugfix', new Date().toISOString().replaceAll(':','-'));
await mkdir(root,{recursive:true});
const cli=resolve('packages/cli/dist/main.js');
const execution={runnerId:'mock',mode:'non_interactive'};
const history=JSON.parse(await readFile('packages/core/test/fixtures/phase6-invalid-decisions.json','utf8'));
const closedReview=JSON.parse(await readFile('packages/core/test/fixtures/phase6-closed-review.json','utf8'));
const calls=[]; let initialMessageId, initialQuote, historyCalls=0, planningCalls=0, reviews=0, closedReviewCalls=0;
function plan(revised=false) { return {schemaVersion:1,id:'http-greeting',title:'HTTP greeting',tasks:[
  {task:{schemaVersion:1,id:'implement',title:'Implement greeting API',prompt:'Create HTTP greeting using Node.js builtin modules',execution},dependsOn:[],status:'planned'},
  {task:{schemaVersion:1,id:'verify',title:'Verify HTTP API',prompt:revised?'Run HTTP regression tests for normal and empty names; check unknown route':'Run basic verification',execution},dependsOn:['implement'],status:'planned'},
]}; }
const firstFindings=[
  {findingId:'F1',severity:'error',category:'testing',taskIds:['verify'],description:'Missing HTTP regression coverage',basis:'Requested HTTP verification',suggestion:'补充对应的 HTTP 回归测试'},
  {findingId:'F2',severity:'warning',category:'testing',taskIds:['verify'],description:'Specify boundary expectations',basis:'Empty names need a defined expectation',suggestion:'Explicitly cover empty names'},
  {findingId:'F3',severity:'info',category:'contract',taskIds:['verify'],description:'Optional richer examples',basis:'Optional documentation improvement',suggestion:'Add further examples'},
];
const api=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const b of req)chunks.push(b);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    calls.push({path:req.url,body}); const system=body.messages[0].content;
    let reply;
    if(req.url.startsWith('/closed-review/')){
      closedReviewCalls++;
      const input=JSON.parse(body.messages[1].content);
      assert.deepEqual(input.previousReview.findings,[]);
      assert.equal(input.previousReview.resolutions,undefined);
      assert.match(system,/本轮 resolutions 必须恰好覆盖的 findingId：\[\]/);
      if(closedReviewCalls>1){assert.match(JSON.stringify(body.messages),/resolutions\[0\].findingId/);assert.equal(body.tools,undefined);}
      reply=closedReviewCalls===1?closedReview.reply:{summary:'Current draft reviewed; previous report has no open issues',findings:[],resolutions:[]};
    }else if(req.url.startsWith('/history/')){
      historyCalls++;
      const id=JSON.parse(/待整理输入：([^\n]+)/.exec(system)[1])[0].messageId;
      reply=JSON.parse(JSON.stringify(history.replies[0]).replaceAll('79bcfc03-8f98-44de-80aa-597f7c0d39f8',id));
      if(historyCalls>1){delete reply.questionBindings;reply.planningAssessment.decisions=[];}
    }else if(system.startsWith('你是代码计划审查员')){
      reviews++; const input=JSON.parse(body.messages[1].content);
      reply=input.previousReview?{summary:'Re-review: mandatory repairs addressed',findings:[{...firstFindings[2],priorFindingId:'F3'}],resolutions:firstFindings.map(f=>({findingId:f.findingId,status:f.findingId==='F3'?'unresolved':'resolved',basis:f.findingId==='F3'?'User kept optional item':'Revised HTTP verification task includes requested cases'}))}:{summary:'Three choices for review',findings:firstFindings};
    }else{
      planningCalls++;const pending=JSON.parse(/待整理输入：([^\n]+)/.exec(system)[1]);
      if(!initialMessageId){initialMessageId=pending[0].messageId;initialQuote=pending[0].content;}
      const revised=planningCalls>1;
      reply={kind:'draft',message:revised?'Applied one combined revision':'Initial HTTP draft',plan:plan(revised),
        requirementsUpdate:{messageDecisions:pending.map(m=>({messageId:m.messageId,kind:revised?'operation':'requirement',reason:revised?'Review repair':'Business request'})),changes:revised?[]:[{requirementId:'R-http',text:initialQuote,status:'active',sourceMessageIds:[initialMessageId]}]},
        planningAssessment:{profile:'general',classification:{rationale:'Tiny builtin HTTP example',sourceMessageId:initialMessageId,quote:initialQuote},decisions:[]}};
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(reply)}}]}));
  }catch(e){res.writeHead(500);res.end(JSON.stringify({error:String(e)}));}
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${api.address().port}`;
async function processRun(command,args,options={}){
  const p=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  const status=await new Promise((r,j)=>{p.once('error',j);p.once('close',r);});
  assert.equal(status,0,`${command} failed: ${stderr}\n${stdout}`);return {stdout,stderr};
}
const scenarios=[];
try{
  const historyRoot=join(root,'history');await mkdir(historyRoot);
  const replay=await startPlannerConversation({workspace:historyRoot,request:history.request,config:{provider:'deepseek',model:'simulated',baseUrl:base+'/history'},executionDefaults:execution,
    planner:new DeepSeekPlanner({model:'simulated',baseUrl:base+'/history',apiKey:'simulated'})});
  assert.equal(replay.error,undefined);assert.equal(historyCalls,2);assert.equal(replay.snapshot.draftRevision,null);assert.equal(replay.snapshot.requirements.items.length,2);
  scenarios.push({name:'recorded-invalid-decision-local-http',status:'passed',planningId:replay.snapshot.planningId,calls:historyCalls});

  const closedRoot=join(root,'closed-review');await mkdir(closedRoot);
  const closedStart=await startPlannerConversation({workspace:closedRoot,request:'Create a tiny HTTP greeting and tests',config:{provider:'mock',model:'mock',baseUrl:'mock://local'},executionDefaults:execution});
  const closedOptions={workspace:closedRoot,planningId:closedStart.snapshot.planningId};
  const taskIds=closedStart.draft.plan.tasks.map(({task})=>task.id);
  await reviewPlannerDraft({...closedOptions,reviewer:{review:async()=>({summary:'Optional F1',findings:[{...firstFindings[2],findingId:'F1',taskIds:[taskIds[1]]}]})}});
  await reviewPlannerDraft({...closedOptions,reviewer:{review:async()=>({...closedReview.previous,resolutions:closedReview.previous.resolutions.map(({findingId,status,basis})=>({findingId,status,basis}))})}});
  const changed=structuredClone(closedStart.draft.plan);changed.tasks[1].task.prompt+=' Record actual command output.';
  const changedResult=await replacePlannerDraft({...closedOptions,value:changed});
  await assert.rejects(approvePlannerDraft({...closedOptions,draftRevision:changedResult.snapshot.draftRevision}),/审查/);
  const repairedReview=await reviewPlannerDraft({...closedOptions,reviewer:new DeepSeekPlanner({model:'simulated',baseUrl:base+'/closed-review',apiKey:'simulated'})});
  assert.equal(repairedReview.review.status,'succeeded');assert.deepEqual(repairedReview.review.resolutions,[]);assert.equal(closedReviewCalls,2);
  const closedApproval=await approvePlannerDraft({...closedOptions,draftRevision:changedResult.snapshot.draftRevision});assert.equal(closedApproval.snapshot.status,'approved');
  scenarios.push({name:'recorded-closed-F1-local-http-review-repair-approve',status:'passed',planningId:closedOptions.planningId,reviewId:repairedReview.review.reviewId,calls:closedReviewCalls});

  const chatRoot=join(root,'chat');await mkdir(chatRoot);
  const started=await startPlannerConversation({workspace:chatRoot,request:'Create a tiny Node.js HTTP greeting and HTTP tests',config:{provider:'deepseek',model:'simulated',baseUrl:base+'/chat'},executionDefaults:execution,
    planner:new DeepSeekPlanner({model:'simulated',baseUrl:base+'/chat',apiKey:'simulated'})});
  assert.equal(started.error,undefined);
  const chat=await processRun('python3',['packages/cli/test/fixtures/chat-bugfix-pty.py',process.execPath,cli,chatRoot,started.snapshot.planningId],{env:{...process.env,TOKEN_COUPON_PLANNER_API_KEY:'simulated'}});
  const snapshot=await new PlannerStore(chatRoot).load(started.snapshot.planningId);
  assert.equal(snapshot.draftRevision,2);assert.equal(planningCalls,2);assert.equal(reviews,2);
  assert.equal((await new SessionStore(chatRoot).load(snapshot.execution.sessionId)).snapshot.status,'succeeded');
  const actions=await readdir(join(chatRoot,'.token-coupon','planners',snapshot.planningId,'review-actions'));assert.equal(actions.length,1);
  scenarios.push({name:'real-cli-pty-review-diff-reapprove-run-logs',status:'passed',...JSON.parse(chat.stdout),planningId:snapshot.planningId,sessionId:snapshot.execution.sessionId,oneCombinedRevision:true});

  const pasteRoot=join(root,'paste');await mkdir(pasteRoot);
  const paste=await processRun('python3',['packages/cli/test/fixtures/paste-bugfix-pty.py',process.execPath,cli,pasteRoot]);
  scenarios.push({name:'real-pty-complete-multiline-paste',status:'passed',...JSON.parse(paste.stdout)});

  const cancelCases=[];
  for(const mode of ['prompt','review','question','approval']){
    const cancelRoot=join(root,'cancel-'+mode);await mkdir(cancelRoot);
    let id='-';
    if(mode!=='prompt'){
      const started=await startPlannerConversation({workspace:cancelRoot,request:'Create a greeting',config:{provider:'mock',model:'mock',baseUrl:'mock://local'},executionDefaults:mode==='review'?execution:{runnerId:'codex',mode:'managed'}});
      assert.equal(started.error,undefined);id=started.snapshot.planningId;
      if(mode==='review'){
        const bad=structuredClone(started.draft.plan);bad.tasks[1].dependsOn=[];
        await replacePlannerDraft({workspace:cancelRoot,planningId:id,value:bad});
      }else{
        await reviewPlannerDraft({workspace:cancelRoot,planningId:id});
        await approvePlannerDraft({workspace:cancelRoot,planningId:id,draftRevision:started.snapshot.draftRevision});
      }
    }
    const bin=join(cancelRoot,'bin');await mkdir(bin);
    await writeFile(join(bin,'codex'),`#!${process.execPath}\nimport ${JSON.stringify(new URL('../packages/core/test/fixtures/phase6-bugfix-app-server.mjs',import.meta.url).href)};\n`,{mode:0o755});
    const child=await processRun('python3',['packages/cli/test/fixtures/cancel-chat-pty.py',process.execPath,cli,cancelRoot,id,mode],{env:{...process.env,PATH:bin+':'+process.env.PATH}});
    if(mode==='question'||mode==='approval'){
      const planning=await new PlannerStore(cancelRoot).load(id);
      const session=(await new SessionStore(cancelRoot).load(planning.execution.sessionId)).snapshot;
      assert.equal(session.status,'cancelled');assert.equal(session.tasks[0].status,'cancelled');assert.deepEqual(session.activeAttemptIds,[]);
      const attemptId=session.tasks[0].attempts.at(-1).attemptId;
      const attempt=JSON.parse(await readFile(join(cancelRoot,'.token-coupon','runs',attemptId,'attempt.json'),'utf8'));
      assert.equal(attempt.status,'cancelled');assert.equal(attempt.cleanupStatus,'completed');
      assert.equal((await readdir(join(cancelRoot,'.token-coupon'))).includes('workspace.lock'),false);
      const interactions=join(cancelRoot,'.token-coupon','runs',attemptId,'interactions');
      for(const file of (await readdir(interactions)).filter(f=>f.endsWith('.json'))){
        const request=JSON.parse(await readFile(join(interactions,file),'utf8'));assert.notEqual(request.status,'pending');
      }
    }else if(mode==='prompt') assert.equal((await readdir(cancelRoot)).includes('.token-coupon'),false);
    else assert.equal((await new PlannerStore(cancelRoot).load(id)).execution,null);
    cancelCases.push({...JSON.parse(child.stdout),status:'passed'});
  }
  scenarios.push({name:'real-cli-ctrl-c-prompt-review-native-question-approval',status:'passed',cases:cancelCases});

  const nativeRoot=join(root,'native-http');await mkdir(nativeRoot);
  const input=new PassThrough();input.isRaw=false;input.setRawMode=v=>{input.isRaw=v;};const output=new PassThrough();const logs=[];
  const terminal=new TerminalInput(input,output);let waiting='';
  output.on('data',b=>{logs.push(b.toString());waiting+=b.toString();
    if(waiting.includes('Ctrl-C 退出会话')){waiting='';setImmediate(()=>input.write('2\x1b[A\r'));}
    else if(waiting.includes('输入选项编号/ID：')){waiting='';setImmediate(()=>input.write('1\r'));}
  });
  const handler=createRunnerInteractionHandler({workspace:nativeRoot,isTTY:true,ask:terminal.ask,choose:(p,c,s)=>terminal.choose(p,c,s),output:s=>terminal.write(s)});
  const nativePlan=parsePlan({schemaVersion:1,id:'native-http',title:'Real HTTP using simulated Codex transport',tasks:[{task:{schemaVersion:1,id:'implement',title:'Implement and test',prompt:'Create HTTP greeting and real port tests',execution:{runnerId:'codex',mode:'managed'}},dependsOn:[],status:'planned'}]});
  const factory=()=>new CodexRunner({},{executable:process.execPath,args:[resolve('packages/core/test/fixtures/phase6-bugfix-app-server.mjs')]});
  let native;
  try{native=await runPlan({plan:nativePlan,workspace:nativeRoot,createRunner:factory,onInteraction:handler});}finally{terminal.close();input.destroy();output.destroy();}
  assert.equal(native.snapshot.status,'succeeded');const attemptId=native.snapshot.tasks[0].attempts[0].attemptId;
  const events=await readFile(join(nativeRoot,'.token-coupon','runs',attemptId,'events.jsonl'),'utf8');assert.match(events,/command.completed/);assert.match(events,/interaction.resolved/);
  const testOutput=await readFile(join(nativeRoot,'http-test-output.txt'),'utf8');assert.match(testOutput,/pass 3/);assert.match(testOutput,/fail 0/);
  await writeFile(join(nativeRoot,'interaction-transcript.txt'),logs.join(''));
  scenarios.push({name:'actual-codex-adapter-simulated-app-server-real-http-tests',status:'passed',sessionId:native.snapshot.sessionId,attemptId,httpTests:3});

  const recoveryRoot=join(root,'recovery');await mkdir(recoveryRoot);
  const recoveryPlan=structuredClone(nativePlan);recoveryPlan.tasks.push({task:{...recoveryPlan.tasks[0].task,id:'verify',title:'Final verify'},dependsOn:['implement'],status:'planned'});
  const store=new SessionStore(recoveryRoot);const record=await store.create(recoveryPlan);const abandoned=randomUUID();
  const moduleUrl=new URL('../packages/core/dist/index.js',import.meta.url).href;
  const script=`import {SessionStore,currentOwner} from ${JSON.stringify(moduleUrl)};import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';const store=new SessionStore(${JSON.stringify(recoveryRoot)});const record=await store.load(${JSON.stringify(record.snapshot.sessionId)});const id=${JSON.stringify(abandoned)};const dir=join(store.workspace,'.token-coupon','runs',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'attempt.json'),JSON.stringify({attemptId:id,taskId:'implement',status:'running',owner:await currentOwner()}));await writeFile(join(dir,'events.jsonl'),JSON.stringify({sequence:1,attemptId:id,type:'attempt.started'})+'\\n');await store.save({...record.snapshot,revision:2,status:'running',schedulerState:'dispatching',activeAttemptIds:[id],tasks:record.snapshot.tasks.map(t=>t.taskId==='implement'?{...t,status:'running',activeAttemptId:id,attempts:[{attemptId:id,artifactDir:dir,outcome:'pending'}]}:t)});await store.acquireLock(record.snapshot.sessionId);process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  const ended=new Promise(r=>child.once('close',r));
  await new Promise((r,j)=>{child.stdout.once('data',r);child.once('error',j);child.once('exit',c=>j(new Error('Owner fixture exited '+c)));});
  try{assert.equal((await diagnoseSession(recoveryRoot,record.snapshot.sessionId)).state,'active');await assert.rejects(recoverSession({workspace:recoveryRoot,sessionId:record.snapshot.sessionId,confirmedStopped:true}),/refused/);}finally{child.kill('SIGKILL');await ended;}
  assert.equal((await diagnoseSession(recoveryRoot,record.snapshot.sessionId)).state,'owner_exited');
  const dry=await processRun(process.execPath,[cli,'session','recover','--id',record.snapshot.sessionId,'--workspace',recoveryRoot]);assert.match(dry.stdout,/owner_exited/);
  await processRun(process.execPath,[cli,'session','recover','--id',record.snapshot.sessionId,'--workspace',recoveryRoot,'--confirm-stopped']);
  assert.deepEqual((await store.load(record.snapshot.sessionId)).snapshot.tasks.map(t=>t.status),['failed','blocked']);
  const interact=async(_id,request)=>request.kind==='approval'?{kind:'approval',decision:'allow-once'}:{kind:'question',answers:[{questionId:'empty-name',optionIds:['Allow']}]};
  const retry=await retrySession({workspace:recoveryRoot,sessionId:record.snapshot.sessionId,taskId:'implement',createRunner:factory,onInteraction:interact});assert.equal(retry.snapshot.tasks[0].attempts.length,2);
  const resumed=await resumeSession({workspace:recoveryRoot,sessionId:record.snapshot.sessionId,createRunner:factory,onInteraction:interact});assert.equal(resumed.snapshot.status,'succeeded');
  assert.equal((await recoverSession({workspace:recoveryRoot,sessionId:record.snapshot.sessionId,confirmedStopped:true})).recovered,false);
  scenarios.push({name:'real-owner-crash-explicit-recover-retry-resume',status:'passed',sessionId:record.snapshot.sessionId,abandonedAttempt:abandoned,finalAttempts:resumed.snapshot.tasks.map(t=>t.attempts.length),httpTests:6});

  await writeFile(join(root,'simulated-api-calls.json'),JSON.stringify(calls,null,2)+'\n');
  const report={schemaVersion:1,status:'passed',workspace:root,simulation:'Planner replies and native agent server simulated; HTTP transport, CLI PTYs, subprocesses, filesystem, owner crash and HTTP tests actually executed',scenarios};
  const reportPath=join(root,'bugfix-report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));console.log('Report: '+reportPath);
}finally{await new Promise(r=>api.close(r));}
