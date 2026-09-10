const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const {Rpc}=require('./rpc.cjs');
const {refuseIfOwnedConfirmed}=require('./claude-session.cjs');

// The Codex npm package ships a prebuilt binary per platform and architecture, under a
// Rust target triple rather than Node's names for the same thing.
const CODEX_TARGETS={
  'win32-x64':'x86_64-pc-windows-msvc',
  'darwin-arm64':'aarch64-apple-darwin',
  'darwin-x64':'x86_64-apple-darwin',
  'linux-x64':'x86_64-unknown-linux-musl',
  'linux-arm64':'aarch64-unknown-linux-musl',
};

// Where a provider CLI ends up when it is not on PATH. This matters most on macOS: an
// app opened from the Dock inherits a bare PATH rather than the shell's, so a CLI the
// user installed and can run in a terminal is invisible to us unless we look for it.
function installDirectories() {
  const home=require('node:os').homedir();
  if(process.platform==='win32')
    return [path.join(process.env.LOCALAPPDATA||'','Programs','OpenAI','Codex','bin'),
            path.join(process.env.USERPROFILE||home,'.local','bin')];
  return [path.join(home,'.local','bin'),'/usr/local/bin','/opt/homebrew/bin',
          path.join(home,'.bun','bin'),path.join(home,'.npm-global','bin'),
          path.join(home,'.volta','bin'),'/usr/bin'];
}

function executable(name) {
  if(process.env[`HUSH_${name.toUpperCase()}_BIN`])return process.env[`HUSH_${name.toUpperCase()}_BIN`];
  const windows=process.platform==='win32',file=windows?`${name}.exe`:name;
  if(name==='codex')try{
    const root=path.dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
    const target=CODEX_TARGETS[`${process.platform}-${process.arch}`];
    const bundled=target&&path.join(root,'vendor',target,'bin',windows?'codex.exe':'codex').replace('app.asar','app.asar.unpacked');
    if(bundled&&fs.existsSync(bundled))return bundled;
  }catch{}
  const searched=[...(process.env.PATH||'').split(path.delimiter).filter(Boolean),...installDirectories()];
  return searched.map(dir=>path.join(dir,file)).find(p=>fs.existsSync(p)) || name;
}
function checkDirectory(cwd) {if(!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory())throw Error('Choose an existing project folder.');}
async function codex(store,{cwd,title,resumeId},openSource) {
  checkDirectory(cwd);
  const child=spawn(executable('codex'),['app-server','--stdio'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const rpc=new Rpc(child.stdout,child.stdin); let session, disposed=false; let tail='';
  child.stderr.on('data',c=>{tail=(tail+c).slice(-2000);});
  child.on('error',e=>rpc.close(Error(`Codex could not start: ${e.message}`))); child.on('exit',()=>rpc.close());
  const pending=new Map();
  rpc.on('closed',()=>{if(session&&!disposed){store.message(session.id,'system','Codex disconnected. Reconnect from Connections.');store.update(session.id,{status:'offline',request:null,requests:[],canReply:false});}});
  rpc.on('event',msg=>{
    if(!session) return; const p=msg.params||{};
    if(p.threadId && p.threadId!==session.sourceId)return;
    if(msg.id!==undefined) {
      if(msg.method==='item/commandExecution/requestApproval'||msg.method==='item/fileChange/requestApproval') {
        const id=String(msg.id); pending.set(id,{id:msg.id,type:'approval'});
        store.enqueueRequest(session.id,{id,kind:'approval',title:p.command||p.reason||'Allow this file change?',detail:JSON.stringify(p,null,2)});
      } else if(msg.method==='item/tool/requestUserInput') {
        const id=String(msg.id);pending.set(id,{id:msg.id,type:'question',questions:p.questions});
        store.enqueueRequest(session.id,{id,kind:'question',title:'Your input is needed',questions:p.questions});
      } else { rpc.send({id:msg.id,error:{code:-32601,message:'This request needs a supported source client.'}}); store.message(session.id,'system',`Unsupported request: ${msg.method}. Open Codex to handle it.`); }
    } else if(msg.method==='item/completed' && p.item?.type==='agentMessage') store.message(session.id,'agent',p.item.text);
    else if(msg.method==='turn/started')store.update(session.id,{status:'working'});
    else if(msg.method==='turn/completed') { pending.clear();store.update(session.id,{status:p.turn?.status==='failed'?'error':'done',request:null,requests:[]}); if(p.turn?.error?.message)store.message(session.id,'system',p.turn.error.message); }
    else if(msg.method==='serverRequest/resolved') {pending.delete(String(p.requestId));if(session.requests.some(r=>r.id===String(p.requestId)))store.resolveRequest(session.id,String(p.requestId));}
  });
  try {
    await rpc.call('initialize',{clientInfo:{name:'hush_agent',title:'Hush',version:'0.1.0'}});rpc.send({method:'initialized'});
    const result=await rpc.call(resumeId?'thread/resume':'thread/start',resumeId?{threadId:resumeId,excludeTurns:true}:{cwd,approvalPolicy:'on-request',sandbox:'workspace-write'});
    cwd=result.cwd||result.thread.cwd||cwd;
    session=store.add({provider:'Codex',title:title||path.basename(cwd),cwd,sourceId:result.thread.id,canReply:true,canOpen:true},{
      reply:async(text,options={})=>{const before=session.status;store.update(session.id,{status:'working'});try{await rpc.call('turn/start',{threadId:session.sourceId,input:[{type:'text',text},...(options.attachments||[]).map(a=>({type:'localImage',path:a.path}))],...(options.model?{model:options.model}:{})});}catch(e){if(session.status==='working')store.update(session.id,{status:before});throw e;}},
      answer:async(id,value)=>{const req=pending.get(id);if(!req)throw Error('The provider has already resolved this request.');let result;
        if(req.type==='approval'){if(!['accept','decline'].includes(value))throw Error('Choose Allow once or Deny.');result={decision:value};}
        else {const answers={};for(const q of req.questions||[]){if(!value?.[q.id]?.trim())throw Error('Answer each question.');answers[q.id]={answers:[value[q.id]]};}result={answers};}
        rpc.send({id:req.id,result});pending.delete(id);
      },open:()=>openSource('codex',session.sourceId,cwd,session.id),dispose:async()=>{disposed=true;rpc.close();if(child.exitCode!=null||child.signalCode!=null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Codex has not released the connection yet. Try again shortly.')),5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();});}
    });
    store.update(session.id,{images:true});return session;
  }catch(e){rpc.close();child.kill();if(/already has an active writer/i.test(e.message)){const conflict=Error('Codex still owns this conversation. You can read it here, but replies must go through Codex until that client releases it.');conflict.code='SESSION_OWNED';throw conflict;}throw Error(`Codex connection failed: ${e.message}${tail.includes('not logged')?' Sign in with codex login.':''}`);}
}

async function claude(store,{cwd,title,resumeId},openSource) {
  checkDirectory(cwd); await refuseIfOwnedConfirmed(resumeId,executable('claude'));
  const {query}=await import('@anthropic-ai/claude-agent-sdk');
  const id=randomUUID();let active=null, disposed=false;let decisions=new Map();
  const session=store.add({id,provider:'Claude Code',title:title||path.basename(cwd),cwd,sourceId:resumeId||'',canReply:true,canOpen:false},{
    reply: async(text,options={})=>{
      await refuseIfOwnedConfirmed(session.sourceId,executable('claude'));
      store.update(id,{status:'working'});
      let accept,rejectDelivery;const accepted=new Promise((resolve,reject)=>{accept=resolve;rejectDelivery=reject;});
      async function* input(){yield {type:'user',message:{role:'user',content:[{type:'text',text},...(options.attachments||[]).map(a=>({type:'image',source:{type:'base64',media_type:a.mimeType,data:fs.readFileSync(a.path).toString('base64')}}))]},parent_tool_use_id:null,session_id:session.sourceId||''};}
      const turnDecisions=new Map();decisions=turnDecisions;let completed=false;
      const turn=query({prompt:options.attachments?.length?input():text,options:{...(options.model?{model:options.model}:{}),cwd,pathToClaudeCodeExecutable:executable('claude'),...(session.sourceId?{resume:session.sourceId}:{}),canUseTool:async(tool,input,options)=>{
        accept();const requestId=randomUUID();
        return new Promise(resolve=>{ const finish=value=>{turnDecisions.delete(requestId);resolve(value);};turnDecisions.set(requestId,{finish,tool,input});
          options.signal.addEventListener('abort',()=>{finish({behavior:'deny',message:'Request cancelled.'});if(session.requests.some(r=>r.id===requestId))store.resolveRequest(id,requestId);},{once:true});
          if(tool==='AskUserQuestion'&&Array.isArray(input.questions))store.enqueueRequest(id,{id:requestId,kind:'question',title:'Claude needs your input',questions:input.questions.map((q,i)=>({id:String(i),question:q.question,options:q.options}))});
          else store.enqueueRequest(id,{id:requestId,kind:'approval',title:`Allow ${tool}?`,detail:JSON.stringify(input,null,2)});
        });
      }}});
      active=turn;
      (async()=>{try {for await(const msg of turn){
        if(disposed||active!==turn)break;
        if(msg.session_id)store.update(id,{sourceId:msg.session_id,canOpen:true});
        if(msg.type==='assistant'&&!msg.error)accept();
        if(msg.type==='assistant')for(const b of msg.message.content||[])if(b.type==='text')store.message(id,'agent',b.text);
        if(msg.type==='result'){if(msg.is_error)throw Error((msg.errors||[session.messages.filter(m=>m.role==='agent').at(-1)?.text||'Claude reported an error.']).join('\n'));accept();completed=true;store.update(id,{status:'done',request:null,requests:[]});break;}
      }if(!completed&&!disposed&&active===turn)throw Error('Claude ended without a completion result. Check the source conversation.');}catch(e){if(!disposed&&active===turn){store.message(id,'system',e.message);store.update(id,{status:'error',request:null,requests:[]});}rejectDelivery(e);}finally{turn.close();if(active===turn)active=null;turnDecisions.clear();}})();
      return accepted;
    },
    answer:async(requestId,value)=>{const d=decisions.get(requestId);if(!d)throw Error('Request expired.');if(d.tool==='AskUserQuestion'){const answers={};for(const [i,q]of d.input.questions.entries()){if(!value?.[String(i)]?.trim())throw Error('Answer each question.');answers[q.question]=value[String(i)];}d.finish({behavior:'allow',updatedInput:{...d.input,answers}});return;}if(!['accept','decline'].includes(value))throw Error('Choose Allow once or Deny.');d.finish(value==='accept'?{behavior:'allow',updatedInput:d.input}:{behavior:'deny',message:'Denied from Hush.'});},
    open:()=>openSource('claude',session.sourceId,cwd,session.id),
    dispose:()=>{disposed=true;for(const d of decisions.values())d.finish({behavior:'deny',message:'Hush closed.'});active?.close();}
  });store.update(id,{images:true});return session;
}
module.exports={codex,claude,executable};
