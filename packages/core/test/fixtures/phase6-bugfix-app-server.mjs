// Simulated native protocol; file writes and HTTP tests below really execute.
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const rl = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let cwd, marker;
const command = 'node --test api.test.mjs';
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start') { cwd = m.params.cwd; send({ id: m.id, result: { thread: { id: 'demo-thread' } } }); }
  else if (m.method === 'turn/start') {
    marker = m.params.input[0].text.match(/<<<TOKEN_COUPON_DONE:[a-f0-9]+>>>/)[0];
    send({ id: m.id, result: { turn: { id: 'demo-turn' } } });
    send({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'demo-thread', turnId: 'demo-turn', itemId: 'question-item', isBlocking: true,
      questions: [{ id: 'empty-name', question: 'Should empty names be allowed?', options: [{ label: 'Allow', description: 'Empty string greeting' }, { label: 'Reject', description: 'Validation error' }] }] } });
  } else if (m.id === 'question') {
    if (m.result?.answers?.['empty-name']?.answers?.[0] !== 'Allow') throw new Error('Incorrect question mapping');
    send({ method: 'item/completed', params: { item: { id: 'question-item', type: 'dynamicToolCall' } } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { itemId: 'http-tests', threadId: 'demo-thread', turnId: 'demo-turn', command, cwd, reason: 'Execute actual HTTP regression tests', additionalPermissions: null } });
  } else if (m.id === 'approval') {
    if (m.result?.decision !== 'accept') throw new Error('Expected one-call approval');
    await writeFile(join(cwd, 'api.mjs'), "import {createServer} from 'node:http';\nexport const server=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname!='/greet'){res.writeHead(404);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({message:`Hello, ${url.searchParams.get('name')??''}!`}));});\n");
    await writeFile(join(cwd, 'api.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {server} from './api.mjs';\nawait new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;\ntry{await test('normal greeting',async()=>{assert.deepEqual(await(await fetch(base+'/greet?name=World')).json(),{message:'Hello, World!'});});await test('empty name',async()=>{assert.deepEqual(await(await fetch(base+'/greet?name=')).json(),{message:'Hello, !'});});await test('unknown route',async()=>assert.equal((await fetch(base+'/missing')).status,404));}finally{await new Promise(r=>server.close(r));}\n");
    send({ method: 'item/started', params: { item: { id: 'http-tests', type: 'commandExecution', command, cwd } } });
    const child = spawn(process.execPath, ['--test', 'api.test.mjs'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
    child.on('close', async (code) => {
      await writeFile(join(cwd, 'http-test-output.txt'), output);
      send({ method: 'item/completed', params: { item: { id: 'http-tests', type: 'commandExecution', command, cwd, exitCode: code } } });
      if(code===0){send({ method:'item/agentMessage/delta',params:{itemId:'answer',delta:'Real HTTP tests passed.\n'+marker+'\n'}});send({method:'turn/completed',params:{turn:{id:'demo-turn',status:'completed'}}});}
      else send({method:'turn/completed',params:{turn:{id:'demo-turn',status:'failed',error:{message:'HTTP regression failed'}}}});
    });
  }
});
rl.on('close',()=>process.exit());
