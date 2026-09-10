const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
async function herdr(store,{binary='herdr',sessionName=''},openTerminal) {
  const prefix=sessionName?['--session',sessionName]:[];
  const command=async(args,json=true)=>{const {stdout}=await run(binary,[...prefix,...args],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});if(!json)return stdout;const data=JSON.parse(stdout);if(data.error||data.ok===false)throw Error(data.error?.message||'Herdr request failed.');return data.result||data;};
  // Deriving an identity costs a process spawn, which polling pays for every agent
  // every few seconds. Reuse the last answer while the agent's state sequence is
  // unchanged. Sending and focusing always pass fresh, so the guarantee that a reply
  // never reaches a replacement occupant is still enforced by a live probe.
  const identities=new Map();
  async function identityOf(a,{fresh=false}={}){
    if(a.agent_session?.value)return `${a.terminal_id}:${a.agent_session.kind}:${a.agent_session.value}`;
    const cached=identities.get(a.pane_id);
    if(!fresh&&cached&&cached.seq===a.state_change_seq)return cached.identity;
    const result=await command(['pane','process-info','--pane',a.pane_id]);const info=result.process_info||result;
    const process=info.foreground_processes?.find(p=>p.name?.toLowerCase().includes(String(a.agent).toLowerCase()));
    const identity=process?`${a.terminal_id}:${process.pid}:${process.name}`:null;
    identities.set(a.pane_id,{seq:a.state_change_seq,identity});
    return identity;
  }
  const linked=new Map();let stopped=false,timer;
  async function refresh() {
    const response=await command(['agent','list']);const agents=Array.isArray(response)?response:response.agents;
    if(!Array.isArray(agents))throw Error('Unsupported Herdr agent list. Update Herdr and reconnect.');
    const live=new Set();
    for(const a of agents){
      const target=a.pane_id;if(!target)continue;live.add(target);let s=linked.get(target);
      // Pin a native session identity when available. Never silently send to a replacement occupant.
      const identity=await identityOf(a);
      if(!identity)continue;
      if(s&&s.herdrIdentity!==identity){store.update(s.id,{status:'offline',canReply:false});linked.delete(target);s=null;}
      if(!s){s=store.add({provider:'Herdr',title:a.name||a.title||`${a.agent||'Agent'} · ${target}`,cwd:a.cwd||'',sourceId:target,canReply:true,canOpen:true},{
        reply:async text=>{const current=await command(['agent','get',target]);const liveAgent=current.agent||current;const now=await identityOf(liveAgent,{fresh:true});if(now!==identity)throw Error('The agent in this pane has changed. Reconnect before replying.');await command(['agent','prompt',target,text]);store.update(s.id,{status:'working'});clearTimeout(timer);if(!stopped)timer=setTimeout(poll,600);},
        open:async()=>{const current=await command(['agent','get',target]);if(await identityOf(current.agent||current,{fresh:true})!==identity)throw Error('The agent in this pane has changed. Reconnect first.');await command(['agent','focus',target]);await openTerminal(binary,[...prefix],s.cwd);},dispose:()=>{linked.delete(target);identities.delete(target);}
      });s.herdrIdentity=identity;s.herdrSeq=a.state_change_seq;linked.set(target,s);store.message(s.id,'agent',await command(['agent','read',target,'--lines','35'],false));}
      const raw=a.status||a.agent_status;let status=({blocked:'waiting',unknown:'idle'})[raw]||raw||'idle';
      if(status==='idle'&&(s.status==='working'||s.herdrSeq!==a.state_change_seq))status='done';s.herdrSeq=a.state_change_seq;
      if(['idle','working','waiting','done','error'].includes(status)&&s.status!==status){
        if(['done','waiting','error'].includes(status)){const output=await command(['agent','read',target,'--lines','35'],false);store.message(s.id,'agent',output);}
        store.update(s.id,{status,canReply:status!=='waiting'});
      }
    }
    for(const [target,s]of linked)if(!live.has(target))store.update(s.id,{status:'offline',canReply:false});
  }
  await refresh();
  // Poll quickly while an agent is mid-turn, slowly when every agent is settled and
  // nothing is expected to change. Any change snaps the interval back down.
  const BUSY=4000,QUIET=12000;
  const interval=()=>[...linked.values()].some(s=>['working','waiting'].includes(s.status))?BUSY:QUIET;
  // The post-reply re-check can land while a poll is already running, so keep one
  // in flight at a time; the running poll reschedules for both.
  let polling=false;
  const poll=async()=>{if(polling)return;polling=true;try{await refresh();}catch(e){for(const s of linked.values())if(s.status!=='offline'){store.message(s.id,'system',e.message);store.update(s.id,{status:'offline',canReply:false});}}finally{polling=false;}if(!stopped)timer=setTimeout(poll,interval());};timer=setTimeout(poll,BUSY);
  return {count:linked.size,close:()=>{stopped=true;clearTimeout(timer);}};
}
module.exports={herdr};
