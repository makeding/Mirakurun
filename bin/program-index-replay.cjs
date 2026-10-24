/*
   Copyright 2026 huggy
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
// Usage: node bin/program-index-replay.cjs <EPG JSON path or URL> <baseline git revision>
// Replays a single immutable JSON snapshot in memory; no tuner or disk database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { Program } = require('../lib/Mirakurun/Program');
const { ProgramHistory } = require('../lib/Mirakurun/ProgramHistory');
const shared = require('../lib/Mirakurun/_').default;
const Event = require('../lib/Mirakurun/Event').default;
shared.event = new Event();
async function main() {
    const [input, revision] = process.argv.slice(2);
    assert.ok(input && /^[a-f0-9]{7,40}$/.test(revision), 'JSON input and baseline commit required');
    let text;
    if (/^https?:/.test(input)) {
        const response = await fetch(input, { signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 200);
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
            bytes += chunk.length; assert.ok(bytes <= 64 * 1024 * 1024, '64 MiB input limit'); chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString();
    } else { text = fs.readFileSync(input, 'utf8'); }
    const programs = JSON.parse(text);
    const source = execFileSync('git', ['show', `${revision}:src/Mirakurun/Program.ts`], { encoding: 'utf8' });
    const filename = path.resolve(__dirname, '../lib/Mirakurun/Program.baseline.js');
    const baseline = new Module(filename, module);
    baseline.filename = filename; baseline.paths = Module._nodeModulePaths(path.dirname(filename));
    baseline._compile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
    const now = Date.now(); Date.now = () => now;
    const grouped = new Map();
    for (const p of programs) { if (!grouped.has(p.networkId)) grouped.set(p.networkId, []); grouped.get(p.networkId).push(p); }
    console.log(JSON.stringify({ input, revision, programs: programs.length, networks: grouped.size,
        sha256: require('node:crypto').createHash('sha256').update(text).digest('hex'), now }));
    const results = [];
    for (let round = 0; round < 3; round++) {
        const states = [];
        for (const [name, Type] of [['baseline', baseline.exports.Program], ['indexed', Program]]) {
            const store = new Type({ memoryOnly: true });
            const batches = structuredClone([...grouped]);
            const measure = fn => { const begin = performance.now(); fn(); return performance.now() - begin; };
            const cold = measure(() => { for (const [nid, batch] of batches) store.findByNetworkIdAndReplace(nid, batch); });
            const unchanged = measure(() => { for (const [nid, batch] of batches) store.findByNetworkIdAndReplace(nid, batch); });
            const updated = structuredClone(batches).map(([nid, batch]) => [nid, batch.filter((_, i) => i % 11 !== 0)
                .map((p, i) => i % 7 ? p : { ...p, name: p.name + ' 更新', startAt: p.startAt + 60000 })]);
            const changed = measure(() => { for (const [nid, batch] of updated) store.findByNetworkIdAndReplace(nid, batch); });
            const query = () => [...grouped].map(([nid, batch]) => {
                const sid = batch[0].serviceId;
                return [store.findByNetworkId(nid), store.findByNetworkIdServiceId(nid, sid),
                    store.findByNetworkIdAndTime(nid, now), store.findByNetworkIdAndServiceIdAndTime(nid, sid, now)];
            });
            const queries = measure(() => { for (let i = 0; i < 20; i++) query(); });
            states.push(structuredClone({ active: [...store.itemMap], deleted: [...store._itemMapDeleted],
                events: [...store._emitPrograms], queries: query() }));
            results.push({ round, name, cold, unchanged, changed, queries });
            await store.close();
        }
        assert.deepEqual(states[1], states[0]);
    }
    console.log(JSON.stringify({ equivalent: true, milliseconds: results }, null, 2));
    const history = new ProgramHistory({ path: ':memory:', integrity: 'real-json-replay', retentionDays: 365 });
    await history.open();
    const store = new Program({ memoryOnly: true }); store._history = history;
    try {
        for (const [nid, batch] of grouped) store.findByNetworkIdAndReplace(nid, structuredClone(batch));
        // Notifications are compared above; do not drain thousands of delayed
        // events while waiting for the independent SQLite round trip.
        clearTimeout(store._emitTimerId);
        assert.deepEqual(JSON.parse(await history.programs({})), [...store.itemMap.values()]);
        console.log(JSON.stringify({ sqliteRoundTrip: true, active: store.itemMap.size }));
    } finally { await store.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
