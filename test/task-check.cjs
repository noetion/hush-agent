const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
module.exports=async({app,store,action,panel})=>{
 const dir=process.env.HUSH_ARTIFACTS||'artifacts/tasks';fs.mkdirSync(dir,{recursive:true});const report={};
 const wait=async s=>{const end=Date.now()+90000;while(Date.now()<end){if(['done','error','offline'].includes(s.status)){assert.equal(s.status,'done',s.messages.at(-1)?.text);return;}await new Promise(r=>setTimeout(r,300));}throw Error('Model turn timed out');};
 try{
   const first=await action('connect',{provider:'codex',title:'Hush folder-free acceptance'});const s=store.get(first.id);
   assert.ok(s.cwd.startsWith(path.join(app.getPath('userData'),'conversations')));report.folderFree=true;
   await store.reply(s.id,'Remember the code HUSH_CONTEXT_314 for this conversation. Reply with READY. Do not use tools or edit files.');await wait(s);const sourceId=s.sourceId;
   await action('remove',{id:s.id});
   const list=await action('list-tasks',{provider:'codex'});assert.ok(list.items.some(t=>t.sourceId===sourceId));report.discovered=true;
   const preview=await action('preview-task',{provider:'codex',sourceId});const p=store.get(preview.id);assert.ok(p.external);assert.ok(p.messages.some(m=>m.text.includes('HUSH_CONTEXT_314')));assert.equal(p.canReply,true);report.history=true;
   const resumed=await action('connect',{provider:'codex',resumeId:sourceId});const r=store.get(resumed.id);assert.equal(r.sourceId,sourceId);
   await store.reply(r.id,'What code did I ask you to remember? Reply with only that code. Do not use tools.');await wait(r);assert.ok(r.messages.at(-1).text.includes('HUSH_CONTEXT_314'));report.contextRetained=true;
   report.passed=true;
 }catch(e){report.error=e.stack;}finally{fs.writeFileSync(path.join(dir,'task-check.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);}
};
