import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Agent, fetch as fetcher } from 'undici';
import { CloudflaredComponent } from '../packages/daemon/dist/cloudflared-component.js';
import { QuickTunnelAdapter } from '../packages/daemon/dist/quick-tunnel.js';
import { createNetworkClient, networkErrorCode } from '../packages/daemon/dist/network-fetch.js';
import { ApplicationService } from '../packages/daemon/dist/application-service.js';
import { RemoteMcpConnection } from '../packages/daemon/dist/oauth-gateway.js';

// Only metadata from a disposable local service is exposed; never uses the user's daemon.
const output = resolve('demo-workspace', `phase7-cold-start-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true });
const component = await new CloudflaredComponent(join(homedir(), '.token-coupon', 'daemon')).get(new AbortController().signal, () => {});
const report = { output, kind: 'real-cloudflare-metadata-cold-start', userDaemonChanged: false, cases: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const paths = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp'];
const verifyReadiness = process.argv.includes('--verify-readiness');
for (const first of verifyReadiness ? [] : ['serial', 'parallel']) {
  const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 90000);
  let origin, runtime;
  const server = createServer((req, res) => {
    const data = req.url === paths[0] ? { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` } : req.url === paths[1] ? { resource: `${origin}/mcp`, authorization_servers: [origin] } : null;
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = createNetworkClient(process.env, fetcher), direct = new Agent();
  const sample = { first, records: [] }; report.cases.push(sample);
  try {
    runtime = await new QuickTunnelAdapter().start(component.executable, server.address().port, join(output, first), abort.signal, () => abort.abort());
    origin = runtime.origin; sample.origin = origin; const started = Date.now();
    async function request(mode, path, client) {
      const at = Date.now() - started, t = Date.now(); let record;
      try { const r = await client(origin + path, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]) }); await r.text(); record = { mode, path, at, ms: Date.now() - t, status: r.status }; }
      catch (error) { record = { mode, path, at, ms: Date.now() - t, error: networkErrorCode(error) || error.name }; }
      sample.records.push(record); console.log(JSON.stringify({ first, ...record })); await save();
    }
    const serial = async label => { for (const path of paths) await request(label, path, proxy.fetch); };
    const parallel = label => Promise.all(paths.map(path => request(label, path, proxy.fetch)));
    if (first === 'serial') { await serial('first-serial-proxy'); await parallel('then-parallel-proxy'); }
    else { await parallel('first-parallel-proxy'); await serial('then-serial-proxy'); }
    await Promise.all(paths.map(path => request('direct-diagnostic', path, (u, i) => fetcher(u, { ...i, dispatcher: direct }))));
    await serial('after-direct-serial-proxy'); await parallel('after-direct-parallel-proxy');
  } finally {
    clearTimeout(deadline); abort.abort(); await runtime?.stop(); server.closeAllConnections();
    await Promise.all([proxy.close(), direct.close(), new Promise(resolve => server.close(resolve))]); await save();
  }
}
if (verifyReadiness) {
  const dataDirectory = join(output, 'verification'), service = new ApplicationService({ dataDirectory }); await service.initialize();
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const remote = new RemoteMcpConnection(service, dataDirectory, port, { component: { async get() { return component; } }, healthIntervalMs: 0 });
  await remote.initialize(); const started = Date.now(), phases = [];
  service.subscribe(event => { if (event.type === 'remote_connection.updated') { phases.push({ at: Date.now() - started, ...event.payload }); console.log(JSON.stringify(phases.at(-1))); } });
  try {
    await remote.startQuick({ consent: true, connectionOnly: true });
    while (Date.now() - started < 165000) {
      const s = remote.status();
      report.readiness = { transport: s.transport, origin: s.publicOrigin, mcpUrl: s.mcpUrl, startupReadiness: s.startupReadiness, probeCheck: s.probeCheck, lastError: s.lastError, elapsedMs: Date.now() - started, phases };
      await save();
      if (['ready', 'error', 'disconnected'].includes(s.transport)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    report.status = report.readiness.transport === 'ready' ? 'succeeded' : 'failed';
    report.noPrematureFailure = !phases.some(p => p.phase === 'error'); await save();
    if (report.status !== 'succeeded') throw new Error('New real tunnel did not pass readiness; see isolated report');
  } finally { await remote.shutdown(); await service.shutdown(); report.temporaryTunnelStopped = true; await save(); }
}
console.log(JSON.stringify({ output, cases: report.cases.length }));
