import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverRunnerModels, discoverPlannerModels, ModelCatalog } from "../src/model-catalog.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function nativeFixture(kind: "codex" | "dsh") {
  const root = await mkdtemp(join(tmpdir(), "token-coupon-models-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "methods.jsonl"), script = join(root, "catalog.mjs");
  await writeFile(script, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
  const log=${JSON.stringify(log)};const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);appendFileSync(log,JSON.stringify(q)+'\\n');if(q.id===undefined)return;
  if(q.method==='initialize')send(q.id,{protocolVersion:1});
  else if(q.method==='model/list')send(q.id,{data:q.params.cursor?[{id:'fast',model:'fast',displayName:'快速模型',isDefault:true},{model:'hidden',hidden:true}]:[{model:'smart',displayName:'智能模型'}],nextCursor:q.params.cursor?null:'page2'});
  else if(q.method==='session/new')send(q.id,{sessionId:'metadata-only',configOptions:[{configId:'model',currentValue:'provider::fast',options:[{name:'Provider',options:[{value:'provider::fast',name:'Fast'},{value:'provider::smart',name:'Smart'}]}]}]});
  else if(q.method==='session/close')send(q.id,{});else send(q.id,{});});`);
  return { root, log, script, kind };
}

it("reads paginated Codex model metadata without starting a thread or turn", async () => {
  const h = await nativeFixture("codex");
  const catalog = await discoverRunnerModels("codex", h.root, { executable: process.execPath, args: [h.script] });
  expect(catalog.models.map(model=>model.id)).toEqual(["smart", "fast"]);
  expect(catalog.models[1]?.label).toBe("快速模型");
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map(line=>JSON.parse(line));
  expect(calls.map(call=>call.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
});

it("reads grouped ACP options and closes the metadata session without sending a prompt", async () => {
  const h = await nativeFixture("dsh");
  const catalog = await discoverRunnerModels("dsh", h.root, { executable: process.execPath, args: [h.script] });
  expect(catalog.models.map(model=>model.id)).toEqual(["provider::fast", "provider::smart"]); expect(catalog.models[0]?.isDefault).toBe(true);
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map(line=>JSON.parse(line).method);
  expect(calls).toEqual(["initialize", "initialized", "session/new", "session/close"]);
});

it("keeps custom/default input usable on discovery failure and deduplicates concurrent reads", async () => {
  let calls = 0;
  const service = new ModelCatalog(async () => { calls++; throw new Error("secret credential in native error"); });
  const [a,b] = await Promise.all([service.runner("codex", "/project"),service.runner("codex", "/project")]);
  expect(calls).toBe(1); expect(a).toEqual(b); expect(a.customAllowed).toBe(true); expect(a.models).toEqual([]); expect(a.error).not.toContain("secret");
  await service.runner("codex", "/project", true); expect(calls).toBe(2);
});

it("uses the configured Planner models endpoint and preserves its custom model on API failure", async () => {
  const environment = { TOKEN_COUPON_PLANNER_API_KEY: "test-secret", TOKEN_COUPON_PLANNER_MODEL: "configured-alias", TOKEN_COUPON_PLANNER_BASE_URL: "https://planner.example/v1" };
  let requested = "";
  const catalog = await discoverPlannerModels(async (input, init) => {
    requested = String(input); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret");
    return Response.json({ data: [{ id: "fast" }, { id: "smart" }, { id: "fast" }] });
  }, environment);
  expect(requested).toBe("https://planner.example/v1/models"); expect(catalog.models.map(model=>model.id)).toEqual(["configured-alias", "fast", "smart"]);
  const unavailable = await discoverPlannerModels(async () => { throw new Error("test-secret"); }, environment);
  expect(unavailable.models[0]?.id).toBe("configured-alias"); expect(unavailable.error).not.toContain("test-secret");
});
