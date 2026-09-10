const {spawn}=require('node:child_process');
const {Rpc}=require('./rpc.cjs');
const {executable}=require('./providers.cjs');

function codexMessages(thread){
  const messages=[];
  for(const turn of thread.turns||[])for(const item of turn.items||[]){
    const role=item.type==='userMessage'?'you':item.type==='agentMessage'?'agent':null;
    const text=item.type==='agentMessage'?item.text:(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(role&&text)messages.push({id:item.id,role,text:String(text).slice(-60000)});
  }
  return messages.slice(-80);
}
function claudeMessages(messages){return messages.filter(m=>!m.parent_tool_use_id&&['user','assistant'].includes(m.type)).flatMap(m=>{
  const content=m.message?.content;const text=typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
  return text?[{id:m.uuid,role:m.type==='user'?'you':'agent',text:text.slice(-60000)}]:[];
}).slice(-80);}

class History {
  constructor(cwd){this.cwd=cwd;this.catalog=new Map();this.catalogLimit=400;this.child=null;this.ready=null;this.closed=false;}
  // Keep the most recent listings. Map preserves insertion order, so the oldest
  // key is the first one.
  remember(item){const key=item.provider+':'+item.sourceId;this.catalog.delete(key);this.catalog.set(key,item);
    while(this.catalog.size>this.catalogLimit)this.catalog.delete(this.catalog.keys().next().value);}
  async codex(){
    if(this.closed)throw Error('Hush is closing.');
    if(!this.ready)this.ready=(async()=>{
      const child=spawn(executable('codex'),['app-server','--stdio'],{cwd:this.cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
      const rpc=new Rpc(child.stdout,child.stdin);this.rpc=rpc;child.stderr.resume();child.on('error',e=>rpc.close(e));child.on('exit',()=>rpc.close());
      rpc.once('closed',()=>{if(this.rpc===rpc){this.ready=null;this.child=null;}child.kill();});
      await rpc.call('initialize',{clientInfo:{name:'hush_history',title:'Hush',version:'0.2.0'},capabilities:{experimentalApi:true}});rpc.send({method:'initialized'});return rpc;
    })().catch(e=>{this.child?.kill();this.ready=null;throw e;});
    return this.ready;
  }
  async list({provider='all',query='',cursor=null}={}){
    if(!['all','codex','claude'].includes(provider))throw Error('Unknown provider.');
    const jobs=[];
    if(provider!=='claude')jobs.push((async()=>{const rpc=await this.codex();const r=await rpc.call('thread/list',{limit:40,sortKey:'updated_at',sourceKinds:['cli','vscode','appServer','exec'],...(query?{searchTerm:query}:{}),...(cursor?{cursor}:{}),useStateDbOnly:true});return {provider:'codex',nextCursor:r.nextCursor,items:r.data.map(t=>({provider:'codex',sourceId:t.id,title:t.name||t.preview?.slice(0,100)||'Untitled task',cwd:t.cwd||'',updatedAt:t.updatedAt*1000}))};})());
    if(provider!=='codex')jobs.push((async()=>{const sdk=await import('@anthropic-ai/claude-agent-sdk');const rows=await sdk.listSessions({limit:200});return {provider:'claude',items:rows.filter(t=>!query||[t.customTitle,t.summary,t.firstPrompt].some(s=>s?.toLowerCase().includes(query.toLowerCase()))).map(t=>({provider:'claude',sourceId:t.sessionId,title:t.customTitle||t.summary||t.firstPrompt||'Untitled conversation',cwd:t.cwd||'',updatedAt:t.lastModified}))};})());
    const results=await Promise.allSettled(jobs),items=[],errors=[];let nextCursor=null;
    for(let i=0;i<results.length;i++){const r=results[i];if(r.status==='fulfilled'){items.push(...r.value.items);nextCursor=r.value.nextCursor||nextCursor;}else errors.push({provider:provider==='claude'?'Claude Code':i===0?'Codex':'Claude Code',message:r.reason.message});}
    for(const item of items)this.remember(item);
    return {items:items.sort((a,b)=>b.updatedAt-a.updatedAt),errors,nextCursor};
  }
  async read(provider,sourceId){
    if(!this.catalog.has(provider+':'+sourceId))throw Error('Refresh Tasks and choose a listed conversation.');
    if(provider==='codex'){
      const rpc=await this.codex();const {thread}=await rpc.call('thread/read',{threadId:sourceId,includeTurns:false});
      const turns=await rpc.call('thread/turns/list',{threadId:sourceId,limit:10,sortDirection:'desc',itemsView:'summary'});
      thread.turns=turns.data.slice().reverse();
      const turn=thread.turns?.at(-1);const busy=thread.status?.type==='active'||turn?.status==='inProgress';
      return {...this.catalog.get(provider+':'+sourceId),cwd:thread.cwd||'',messages:codexMessages(thread),status:busy?'working':'idle',busy};
    }
    const sdk=await import('@anthropic-ai/claude-agent-sdk');const info=await sdk.getSessionInfo(sourceId);if(!info)throw Error('This conversation is no longer available.');
    const messages=claudeMessages(await sdk.getSessionMessages(sourceId));
    return {...this.catalog.get(provider+':'+sourceId),cwd:info.cwd||'',messages,status:'idle',busy:false};
  }
  close(){this.closed=true;this.rpc?.close();this.child?.kill();}
}
module.exports={History,codexMessages,claudeMessages};
