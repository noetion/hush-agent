// Claude Code records the session each of its processes owns in
// ~/.claude/sessions/<pid>.json. Resuming a session that a live client already owns
// does not reach that client: the message lands in the transcript and is never
// delivered, with nothing to catch, so ownership has to be checked before sending
// rather than inferred from a failure.
//
// The same data is exposed officially by `claude agents --json`, which lists only
// live sessions. Reading the files is the fast path, used before every send; the
// command is the authority, and is only spawned when the files say we are about to
// refuse, so a stale record cannot silently cost the user a reply.
const fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');

const sessionsDir=()=>path.join(os.homedir(),'.claude','sessions');

function running(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  // Signal 0 tests for existence. EPERM means it exists and is not ours to signal.
  try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}

/** The live process owning `sessionId` according to the session files, or null. */
function liveOwner(sessionId,directory=sessionsDir()){
  if(!sessionId)return null;
  let names;
  try{names=fs.readdirSync(directory);}catch{return null;}
  for(const name of names){
    if(!name.endsWith('.json'))continue;
    let record;
    try{record=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));}catch{continue;}
    if(record?.sessionId!==sessionId)continue;
    if(!running(record.pid))continue;
    return {pid:record.pid,kind:record.kind||'unknown',cwd:record.cwd||'',
            version:record.version||'',name:record.name||''};
  }
  return null;
}

/** Sessions Claude Code itself reports as live. Null when it cannot be asked. */
function reportedSessions(binary,timeout=6000){
  return new Promise(resolve=>{
    execFile(binary,['agents','--json'],{windowsHide:true,timeout,maxBuffer:1024*1024},(error,stdout)=>{
      if(error)return resolve(null);
      try{
        const rows=JSON.parse(stdout);
        resolve(Array.isArray(rows)?rows:null);
      }catch{resolve(null);}
    });
  });
}

/** The peer token a session accepts on its inbox socket, or null. */
function peerCredentials(pid,directory=sessionsDir()){
  let names;
  try{names=fs.readdirSync(directory);}catch{return null;}
  const keyFile=names.find(name=>name.startsWith(pid+'.')&&name.endsWith('.key'));
  if(!keyFile)return null;
  try{
    const key=JSON.parse(fs.readFileSync(path.join(directory,keyFile),'utf8'));
    return key?.peerToken?{token:key.peerToken}:null;
  }catch{return null;}
}

/**
 * Post one message to a live session's inbox socket.
 *
 * Claude Code documents the auth line, `{"type":"auth","token":...}`, and requires it
 * on native Windows. The message envelope below is not documented; it was established
 * by observing a delivery arrive. Resolving means the bytes were written and the socket
 * closed cleanly: Claude Code sends no acknowledgement, so this is never proof the
 * message was accepted, and the caller must not report it as one.
 *
 * The message arrives with peer authority rather than the user's. It reaches the
 * conversation, but it cannot answer a pending permission prompt.
 */
function postToOwner(sessionId,text,directory=sessionsDir(),timeout=5000){
  return new Promise((resolve,reject)=>{
    const owner=liveOwner(sessionId,directory);
    if(!owner)return reject(Error('That Claude Code conversation is no longer running.'));
    const record=(()=>{
      try{return JSON.parse(fs.readFileSync(path.join(directory,`${owner.pid}.json`),'utf8'));}catch{return null;}
    })();
    const socketPath=record?.messagingSocketPath;
    if(!socketPath)return reject(Error('That Claude Code session exposes no inbox to deliver to.'));
    const credentials=peerCredentials(String(owner.pid),directory);
    if(!credentials&&process.platform==='win32')
      return reject(Error('That Claude Code session requires a key Hush could not read.'));

    const socket=net.connect(socketPath);
    let settled=false;
    const fail=error=>{if(settled)return;settled=true;socket.destroy();reject(error);};
    socket.setTimeout(timeout,()=>fail(Error('That Claude Code session did not accept the message in time.')));
    socket.on('error',error=>fail(Error(`Could not reach that Claude Code session: ${error.message}`)));
    socket.on('connect',()=>{
      if(credentials)socket.write(JSON.stringify({type:'auth',token:credentials.token})+'\n');
      socket.write(JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n',error=>{
        if(error)return fail(error);
        socket.end(()=>{if(!settled){settled=true;resolve({pid:owner.pid,acknowledged:false});}});
      });
    });
  });
}

function ownedError(owner){
  const where=owner.kind==='interactive'?'an open Claude Code window':'another Claude Code process';
  const which=owner.name?` "${owner.name}"`:'';
  const error=Error(`Claude Code still owns this conversation in ${where}${which} (process ${owner.pid}). `
    +`A reply sent from here would be written to its transcript without ever reaching it, so it is refused `
    +`rather than lost. Reply in that window, or close it and reconnect.`);
  error.code='SESSION_OWNED';
  error.owner=owner;
  return error;
}

/** Throws SESSION_OWNED when another live client holds the conversation. */
function refuseIfOwned(sessionId,directory){
  const owner=liveOwner(sessionId,directory);
  if(!owner)return null;
  throw ownedError(owner);
}

/**
 * As refuseIfOwned, but confirms against `claude agents --json` before refusing, so a
 * stale file cannot block a reply that would have worked. Only reached when the files
 * already indicate an owner, so the command runs on the rare path rather than on every
 * send. If Claude Code cannot be asked, the file evidence stands: refusing a reply is
 * recoverable, losing one silently is not.
 */
async function refuseIfOwnedConfirmed(sessionId,binary,directory,list=reportedSessions){
  const owner=liveOwner(sessionId,directory);
  if(!owner)return null;
  const reported=await list(binary);
  if(reported&&!reported.some(row=>row.sessionId===sessionId))return null;
  throw ownedError(owner);
}

module.exports={liveOwner,refuseIfOwned,refuseIfOwnedConfirmed,reportedSessions,
                postToOwner,peerCredentials,sessionsDir};
