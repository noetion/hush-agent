const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Rpc}=require('../src/rpc.cjs'),{PassThrough}=require('node:stream'),{EventEmitter}=require('node:events');
test('removal cannot race an accepted but unconfirmed delivery',async()=>{
 const store=new Store();let finish;const s=store.add({provider:'Codex',title:'Shared',canReply:true},{reply:()=>new Promise(resolve=>finish=resolve)});store.update(s.id,{shared:true});const delivery=store.reply(s.id,'pending');await assert.rejects(store.remove(s.id),/queued replies/);finish();await delivery;store.update(s.id,{queuePending:{id:'receipt'}});await assert.rejects(store.remove(s.id),/queued replies/);store.update(s.id,{queuePending:null});await store.remove(s.id);assert.equal(store.sessions.size,0);
});
test('marking an already-read session does not trigger another render',()=>{const store=new Store(),s=store.add({provider:'Fixture',title:'Read'});let updates=0;store.on('change',()=>updates++);store.seen(s.id);assert.equal(updates,0);});
test('a completed reply cannot close or change the next active turn',async()=>{
 const providerFile=path.join(__dirname,'../src/providers.cjs'),providerModule={exports:{}},closed=[];let finishOld,finishNext,count=0;
 const oldCleanup=new Promise(resolve=>finishOld=resolve),nextResult=new Promise(resolve=>finishNext=resolve);
 const query=()=>{const turn=++count;return {close(){closed.push(turn);},async *[Symbol.asyncIterator](){yield {type:'assistant',session_id:'fixture',message:{content:[{type:'text',text:'accepted'}]}};if(turn===1){try{yield {type:'result',is_error:false};}finally{await oldCleanup;}}else{await nextResult;yield {type:'result',is_error:false};}}};};
 const source=fs.readFileSync(providerFile,'utf8').replace("await import('@anthropic-ai/claude-agent-sdk')",'({query:fakeQuery})');
 new Function('require','module','fakeQuery',source)(require('node:module').createRequire(providerFile),providerModule,query);
 const store=new Store(),s=await providerModule.exports.claude(store,{cwd:process.cwd()},()=>{}),tick=()=>new Promise(resolve=>setImmediate(resolve));
 try{await store.reply(s.id,'first');await tick();assert.equal(s.status,'done');await store.reply(s.id,'second');assert.equal(s.status,'working');finishOld();await tick();assert.deepEqual(closed,[1]);assert.equal(s.status,'working');assert.equal(s.sending,false);assert.equal(s.messages.some(m=>m.role==='system'),false);finishNext();await tick();assert.equal(s.status,'done');assert.deepEqual(closed,[1,2]);}
 finally{finishOld();finishNext();await tick();await store.close();}
});
test('RPC accepts image queue receipts above the old 8 MB cap',async()=>{const input=new PassThrough(),output=new PassThrough(),rpc=new Rpc(input,output);try{const pending=rpc.call('image-result');input.write(JSON.stringify({id:1,result:{image:'x'.repeat(9e6)}})+'\n');assert.equal((await pending).image.length,9e6);}finally{rpc.close();}});
test('Cursor disconnect clears approvals and permits removing the dead connection',async()=>{
 // Point discovery at a fixture instead of a real install. Each platform reads a
 // different variable for where the Cursor CLI unpacks itself, and only Windows ships
 // its bundled Node as node.exe, so the fixture has to match the platform it runs on.
 const cp=require('node:child_process'),original=cp.spawn;
 const windows=process.platform==='win32',key=windows?'LOCALAPPDATA':'XDG_DATA_HOME',previous=process.env[key];
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hush-cursor-'));const runtime=path.join(root,'cursor-agent','versions','test');fs.mkdirSync(runtime,{recursive:true});for(const file of [windows?'node.exe':'node','index.js'])fs.writeFileSync(path.join(runtime,file),'');process.env[key]=root;
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const request=JSON.parse(line);if(request.id!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result:request.method==='session/new'?{sessionId:'fixture',models:{availableModels:[]}}:{}})+'\n'));}});cp.spawn=()=>child;
 try{delete require.cache[require.resolve('../src/cursor.cjs')];const {Cursor}=require('../src/cursor.cjs');const store=new Store(),cursor=new Cursor(store),s=await cursor.connect({cwd:process.cwd(),title:'Fixture'});cursor.event({id:50,method:'session/request_permission',params:{sessionId:'fixture',toolCall:{title:'Allow?'},options:[]}});assert.ok(s.request);cursor.rpc.close();assert.equal(s.status,'offline');assert.equal(s.request,null);assert.deepEqual(s.requests,[]);assert.equal(cursor.requests.size,0);await store.remove(s.id);assert.equal(store.sessions.size,0);
 }finally{cp.spawn=original;if(previous===undefined)delete process.env[key];else process.env[key]=previous;delete require.cache[require.resolve('../src/cursor.cjs')];fs.rmSync(root,{recursive:true,force:true});}
});
