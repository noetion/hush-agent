// Ownership of a Claude Code conversation has to be established before sending,
// because resuming an owned session fails silently: the message is written to the
// transcript and never reaches the client that owns it.
const test=require('node:test');const assert=require('node:assert');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn}=require('node:child_process');
const {liveOwner,refuseIfOwned}=require('../src/claude-session.cjs');

const SESSION='b64750cc-6ae6-4758-8d42-399441bec874';

function fixture(records){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hush-sessions-'));
  for(const record of records)
    fs.writeFileSync(path.join(dir,`${record.pid}.json`),JSON.stringify(record));
  return dir;
}
// A pid that has certainly exited, so staleness is real rather than assumed.
const deadPid=()=>new Promise(resolve=>{
  const child=spawn(process.execPath,['-e','0'],{windowsHide:true,stdio:'ignore'});
  child.on('exit',()=>setTimeout(()=>resolve(child.pid),50));
});

test('a session owned by a running process is reported', ()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,cwd:'C:/work',kind:'interactive',version:'2.1.260'}]);
  const owner=liveOwner(SESSION,dir);
  assert.ok(owner,'the owner should have been found');
  assert.equal(owner.pid,process.pid);
  assert.equal(owner.kind,'interactive');
});

test('a record for a process that has exited is ignored', async()=>{
  const gone=await deadPid();
  const dir=fixture([{pid:gone,sessionId:SESSION,cwd:'C:/work',kind:'interactive'}]);
  assert.equal(liveOwner(SESSION,dir),null,'a stale record must not block sending');
});

test('records for other sessions are ignored', ()=>{
  const dir=fixture([{pid:process.pid,sessionId:'a-different-session',kind:'interactive'}]);
  assert.equal(liveOwner(SESSION,dir),null);
});

test('a missing sessions directory means no owner', ()=>{
  assert.equal(liveOwner(SESSION,path.join(os.tmpdir(),'hush-not-here-'+Date.now())),null);
});

test('an unreadable record does not hide a valid one', ()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,kind:'interactive'}]);
  fs.writeFileSync(path.join(dir,'99999999.json'),'{ not json');
  assert.ok(liveOwner(SESSION,dir),'a corrupt neighbour must not mask the owner');
});

test('refusing names the owner and carries the code the connect path expects', ()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,kind:'interactive'}]);
  assert.throws(()=>refuseIfOwned(SESSION,dir),error=>{
    assert.equal(error.code,'SESSION_OWNED');
    assert.match(error.message,/open Claude Code window/);
    assert.match(error.message,new RegExp(String(process.pid)));
    return true;
  });
});

test('an unowned session is not refused', ()=>{
  const dir=fixture([]);
  assert.equal(refuseIfOwned(SESSION,dir),null);
});

// The files are the fast path; `claude agents --json` is the authority. A stale
// record must not cost a reply, and an unavailable Claude Code must not turn a
// refusal into a silent send.
const {refuseIfOwnedConfirmed}=require('../src/claude-session.cjs');
test('a file-reported owner that Claude Code does not list is not refused',async()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,kind:'interactive'}]);
  const listsOthers=async()=>[{sessionId:'someone-else',pid:1}];
  assert.equal(await refuseIfOwnedConfirmed(SESSION,'claude',dir,listsOthers),null,
    'a stale record must not cost a reply Claude Code says is free');
});

test('an owner Claude Code also lists is refused',async()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,kind:'interactive'}]);
  const listsIt=async()=>[{sessionId:SESSION,pid:process.pid}];
  await assert.rejects(()=>refuseIfOwnedConfirmed(SESSION,'claude',dir,listsIt),
    error=>{assert.equal(error.code,'SESSION_OWNED');return true;});
});

test('when Claude Code cannot be asked the file evidence stands',async()=>{
  const dir=fixture([{pid:process.pid,sessionId:SESSION,kind:'interactive'}]);
  const unavailable=async()=>null;
  await assert.rejects(()=>refuseIfOwnedConfirmed(SESSION,'claude',dir,unavailable),
    error=>{assert.equal(error.code,'SESSION_OWNED');return true;},
    'refusing is recoverable; losing a message silently is not');
});

test('an unowned session is never refused, whatever Claude Code says',async()=>{
  const dir=fixture([]);
  assert.equal(await refuseIfOwnedConfirmed(SESSION,'definitely-not-a-real-binary-xyz',dir),null);
});
