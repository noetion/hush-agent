const {spawn}=require('node:child_process');
const {executable}=require('./providers.cjs');
function queueCodex(sourceId,text,cwd,options={}){
 if(!/^[0-9a-f-]{36}$/i.test(sourceId))return Promise.reject(Error('Invalid Codex task ID.'));
 if(options.attachments?.length)return (async()=>{
  if(!options.rpc)throw Error('The image queue connection is unavailable. Your draft is kept.');
  const result=await options.rpc.call('thread/queue/add',{threadId:sourceId,clientUserMessageId:require('node:crypto').randomUUID(),input:[{type:'text',text},...options.attachments.map(a=>({type:'localImage',path:a.path}))]});
  const id=result.queuedSubmission?.id;if(!id)throw Error('Unknown image queue confirmation. Check Codex before retrying.');return {id};
 })();
 return new Promise((resolve,reject)=>{
  const child=spawn(executable('codex'),['queue','--thread',sourceId,'--message',text,...(options.attachments||[]).flatMap(a=>['--image',a.path])],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(Error('Codex queue confirmation timed out. Delivery is uncertain; check the task in Codex before retrying.'));},15000);
  child.stdout.on('data',b=>{output=(output+b).slice(-8000);});child.stderr.on('data',b=>{output=(output+b).slice(-8000);});
  child.on('error',e=>finish(Error('Could not reach Codex: '+e.message)));
  child.on('close',code=>{if(code!==0)return finish(Error('Codex did not accept the queued reply: '+output.trim()));const match=/Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)/i.exec(output);if(!match||match[2]!==sourceId)return finish(Error('Codex returned an unknown queue confirmation. Check the task before retrying.'));finish(null,{id:match[1]});});
 });
}
module.exports={queueCodex};
