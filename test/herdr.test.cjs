// The Herdr adapter talks to a CLI, so every derived identity costs a process spawn.
// Polling reuses the last answer while the agent's state sequence is unchanged, but
// sending and focusing must always probe live: a reply must never reach a pane whose
// occupant has been replaced. These tests hold both halves of that in place.
//
// execFile is replaced before herdr.cjs is loaded, because the module promisifies it
// once at load time.
const test=require('node:test');const assert=require('node:assert');
const util=require('node:util');const cp=require('node:child_process');

const calls=[];
let agentStatus='working',stateSeq=1,foregroundName='codex.exe',foregroundPid=123;

function respond(args){
  const line=args.join(' ');
  calls.push(line);
  if(line.includes('agent list'))
    return JSON.stringify({agents:[{pane_id:'p1',terminal_id:'t1',agent:'codex',name:'Test agent',
      cwd:'C:\\work',state_change_seq:stateSeq,status:agentStatus}]});
  if(line.includes('pane process-info'))
    return JSON.stringify({process_info:{foreground_processes:[{pid:foregroundPid,name:foregroundName}]}});
  if(line.includes('agent get'))
    return JSON.stringify({agent:{pane_id:'p1',terminal_id:'t1',agent:'codex',
      state_change_seq:stateSeq,status:agentStatus}});
  if(line.includes('agent read'))return 'agent output line';
  if(line.includes('agent prompt'))return JSON.stringify({ok:true});
  if(line.includes('agent focus'))return JSON.stringify({ok:true});
  return JSON.stringify({});
}
const fake=(file,args,options,callback)=>{const cb=callback||options;setImmediate(()=>cb(null,respond(args),''));};
fake[util.promisify.custom]=(file,args)=>Promise.resolve({stdout:respond(args),stderr:''});
cp.execFile=fake;

const {Store}=require('../src/store.cjs');
const {herdr}=require('../src/herdr.cjs');

const probes=()=>calls.filter(c=>c.includes('pane process-info')).length;
const pause=ms=>new Promise(r=>setTimeout(r,ms));

test('polling reuses the identity while the state sequence is unchanged',async()=>{
  calls.length=0;
  const store=new Store();
  const connection=await herdr(store,{binary:'herdr'},async()=>{});
  try{
    assert.equal(probes(),1,'connecting should derive the identity once');
    // The agent reports as working, so the adapter polls on its busy interval.
    await pause(4400);
    assert.ok(calls.filter(c=>c.includes('agent list')).length>=2,'a second poll should have run');
    assert.equal(probes(),1,'an unchanged state sequence must not cost another spawn');
  }finally{connection.close();await store.close();}
});

test('a changed state sequence re-derives the identity',async()=>{
  calls.length=0;stateSeq=1;
  const store=new Store();
  const connection=await herdr(store,{binary:'herdr'},async()=>{});
  try{
    assert.equal(probes(),1);
    stateSeq=2;
    await pause(4400);
    assert.equal(probes(),2,'a new state sequence must be re-checked');
  }finally{connection.close();await store.close();stateSeq=1;}
});

test('replying always probes live rather than trusting the cache',async()=>{
  calls.length=0;agentStatus='idle';
  const store=new Store();
  const connection=await herdr(store,{binary:'herdr'},async()=>{});
  try{
    const session=store.list()[0];
    assert.ok(session,'the fake agent should have produced a session');
    const before=probes();
    await store.reply(session.id,'hello');
    assert.equal(probes(),before+1,'sending must re-derive the identity, not reuse it');
    assert.ok(calls.some(c=>c.includes('agent prompt')),'the prompt should have been sent');
  }finally{agentStatus='working';connection.close();await store.close();}
});

test('a replaced pane occupant is refused at send time',async()=>{
  calls.length=0;agentStatus='idle';
  const store=new Store();
  const connection=await herdr(store,{binary:'herdr'},async()=>{});
  try{
    const session=store.list()[0];
    // The pane is now running a different process than the one Hush connected to.
    foregroundPid=999;
    await assert.rejects(()=>store.reply(session.id,'hello'),/changed/i);
    assert.ok(!calls.some(c=>c.includes('agent prompt')),'nothing may be sent to a replacement');
  }finally{foregroundPid=123;agentStatus='working';connection.close();await store.close();}
});
