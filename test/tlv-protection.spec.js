const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Writable, PassThrough } = require('node:stream');
const { once } = require('node:events');
const statusPath = require.resolve('../lib/Mirakurun/status');
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
 exports: { __esModule: true, default: { streamCount: { decoder: 0 }, errorCount: {} } } };
const Decoder = require('../lib/Mirakurun/TLVDecoder').default;
const { StreamByteBudget, streamProtection, streamFailures, StreamStageError, redactStreamText } = require('../lib/Mirakurun/StreamFailure');
const BoundedOutput = require('../lib/Mirakurun/BoundedStreamOutput').default;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a blocked consumer has a bounded queue and cannot stall another request', {timeout: 4000}, async t => {
 const slow = new Writable({write(_b,_e,_cb) {}});
 const errors = [];
 const policy = streamProtection({maxBufferBytes: 4096, outputTimeoutMs: 100});
 const budget = new StreamByteBudget(policy.maxBufferBytes);
 const blocked = new BoundedOutput(slow, budget, policy, error => errors.push(error));
 const fast = new PassThrough(); const chunks=[];fast.on('data', b=>chunks.push(b));
 const ready = new BoundedOutput(fast, new StreamByteBudget(4096), policy, error => {throw error});
 t.after(()=>{blocked.destroy();slow.destroy();ready.destroy();fast.destroy()});
 for(let i=0;i<8;i++) {blocked.write(Buffer.alloc(1024));ready.write(Buffer.alloc(1024,i));await delay(1);}
 const ended=once(fast,'end');ready.end();await ended;
 assert.equal(errors.length,1);assert.equal(errors[0].detail.code,'BUFFER_LIMIT');
 assert.equal(budget.pending,0);assert.equal(Buffer.concat(chunks).length,8192);
});

for(const mode of ['stall','eof','output','source']) {
 test(`watchdog classifies ${mode} and releases its converter`, {timeout:4000}, async t=>{
  const output = mode==='output'?new Writable({highWaterMark:1,write(_b,_e,_cb){}}):new Writable({write(_b,_e,cb){cb()}});
  const code = mode==='stall'?"let n=0;process.stdin.on('data',b=>{if(n++===0)process.stdout.write(b)})":mode==='eof'?"process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000))":"process.stdin.pipe(process.stdout)";
  let failure;const failed=new Promise(resolve=>failure=resolve);
  const input=new Decoder({output,command:`${process.execPath} -e "${code}"`,onError:failure,
   protection:{startupTimeoutMs:1000,stallTimeoutMs:120,drainTimeoutMs:120,outputTimeoutMs:120,sourceTimeoutMs:mode==='source'?200:2000}});
  const child=input._process,exited=once(child,'close');
  const timer=setInterval(()=>input.write(Buffer.alloc(100)),20);
  t.after(()=>{clearInterval(timer);input.destroy();output.destroy();child.kill('SIGKILL')});
  input.write(Buffer.alloc(100));if(mode==='eof'){clearInterval(timer);input.end()}if(mode==='source'){clearInterval(timer)}
  const error=await failed;await exited;
  assert.equal(error.detail.code,{stall:'DECODER_STALLED',eof:'DRAIN_TIMEOUT',output:'OUTPUT_STALLED',source:'SOURCE_STALLED'}[mode]);
  assert.equal(input.destroyed,true);
 });
}

test('failure store retains bounded redacted context without exposing child commands',()=>{
 const redacted=redactStreamText('AWS_SECRET_ACCESS_KEY=aws-value client_secret="quoted secret" access_token=token-value password=pass-value');
 for(const value of ['aws-value','quoted secret','token-value','pass-value'])assert(!redacted.includes(value));
 for(let i=0;i<55;i++)streamFailures.add({requestId:'request-'+i,channel:'BS4K/BS17_0'},new StreamStageError({stage:'conversion',code:'DECODER_EXIT',reason:'Converter failed.',inputBytes:42,outputBytes:12,stderr:'token=topsecret\n'+'a'.repeat(8000)}));
 const rows=streamFailures.list();assert.equal(rows.length,50);assert.equal(rows[0].requestId,'request-54');assert.equal(rows[0].inputBytes,42);assert(rows.every(r=>r.stderr.length<=4096&&!r.stderr.includes('topsecret')));
 rows[0].reason='mutated';assert.notEqual(streamFailures.list()[0].reason,'mutated');
});
