const test=require('node:test');const assert=require('node:assert/strict');const {PassThrough}=require('node:stream');const {EventEmitter}=require('node:events');const cp=require('node:child_process');
test('Codex writer conflict closes the attempted connection and creates no writable session',async()=>{
 const original=cp.spawn;let killed=false;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{killed=true;};
 child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const request=JSON.parse(line);if(request.id!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify(request.method==='initialize'?{id:request.id,result:{}}:{id:request.id,error:{code:-1,message:'thread example already has an active writer'}})+'\n'));}});
 cp.spawn=()=>child;
 try{delete require.cache[require.resolve('../src/providers.cjs')];const {codex}=require('../src/providers.cjs');const {Store}=require('../src/store.cjs');const store=new Store();await assert.rejects(codex(store,{cwd:process.cwd(),resumeId:'example'},()=>{}),e=>e.code==='SESSION_OWNED');assert.equal(killed,true);assert.equal(store.list().length,0);}finally{cp.spawn=original;delete require.cache[require.resolve('../src/providers.cjs')];}
});
