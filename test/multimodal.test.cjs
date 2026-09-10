const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{importImages}=require('../src/media.cjs'),{queueCodex}=require('../src/codex-queue.cjs');
test('Cursor pre-accept rejection preserves the draft delivery state',async()=>{
 const {Cursor}=require('../src/cursor.cjs');const store=new Store(),cursor=new Cursor(store);cursor.ready=async()=>{};cursor.rpc={call:async(method)=>{if(method==='session/new')return {sessionId:'fixture',models:{availableModels:[]}};if(method==='session/prompt')throw Error('Prompt rejected');}};
 const s=await cursor.connect({cwd:process.cwd(),title:'Fixture'});await assert.rejects(store.reply(s.id,'Keep this draft'),/Prompt rejected/);assert.equal(s.messages.some(m=>m.role==='you'),false);assert.equal(s.sending,false);assert.equal(s.status,'error');assert.equal(cursor.acceptances.size,0);
});
test('image import validates the whole selection before copying and preserves the source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hush-media-'));
 try{const image=path.join(root,'valid.png'),bad=path.join(root,'bad.png'),out=path.join(root,'copies');fs.writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10]));fs.writeFileSync(bad,'not an image');assert.throws(()=>importImages([image,bad],out),/supported image/);assert.equal(fs.existsSync(out),false);const [copy]=importImages([image],out);assert.equal(copy.mimeType,'image/png');assert.notEqual(copy.path,image);assert.deepEqual(fs.readFileSync(copy.path),fs.readFileSync(image));assert.throws(()=>importImages(Array(5).fill(image),out),/four/);fs.writeFileSync(bad,Buffer.alloc(5*1024*1024+1));assert.throws(()=>importImages([bad],out),/5 MB/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('image queue uses typed input and receipt without acquiring a thread writer',async()=>{
 let method,params;const id='00000000-0000-0000-0000-000000000001';const options={attachments:[{path:'C:/test/image.png'}],rpc:{call:async(m,p)=>{method=m;params=p;return {queuedSubmission:{id:'receipt'}};}}};assert.deepEqual(await queueCodex(id,'look',process.cwd(),options),{id:'receipt'});assert.equal(method,'thread/queue/add');assert.equal(params.threadId,id);assert.equal(params.input[1].type,'localImage');assert.equal(params.input[1].path,options.attachments[0].path);await assert.rejects(queueCodex(id,'look',process.cwd(),{attachments:options.attachments}),/unavailable/);
});
test('failed multimodal delivery retains attachments and does not mark a message sent',async()=>{
 const store=new Store();let received;const s=store.add({provider:'Fixture',title:'Fixture',canReply:true},{reply:async(_text,options)=>{received=options;throw Error('provider rejected');}});const attachments=[{path:'image.png'}];store.update(s.id,{attachments});await assert.rejects(store.reply(s.id,'',{attachments,model:'chosen'}),/provider rejected/);assert.equal(received.model,'chosen');assert.deepEqual(s.attachments,attachments);assert.equal(s.messages.length,0);assert.equal(s.sending,false);
});
