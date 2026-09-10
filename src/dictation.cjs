const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {chooseBackend}=require('./dictation-backends.cjs');

// Every platform's recogniser is reached the same way: a process that writes one JSON
// object per line and winds up when a stop file appears. What differs is which process,
// and that is the backend's business rather than this file's. See docs/VOICE.md.

// The helper emits one line per recognised phrase, so a long dictation arrives as
// several. Everything spoken belongs in the draft, not only the first phrase, which is
// all a single-shot recogniser could return.
function transcriptFrom(rows){
  const error=rows.find(r=>r.type==='error');
  if(error)throw Error(error.message);
  return rows.filter(r=>r.type==='text'&&r.text).map(r=>String(r.text).trim()).filter(Boolean).join(' ');
}

class Dictation {
 // Re-probed rather than settled at startup. When a backend is unavailable it tells the
 // user to install something, and having to restart Hush after doing so would be the
 // exact friction this is meant to remove. Cached briefly so a Linux PATH scan does not
 // run on every state broadcast.
 static PROBE_TTL=10000;

 get backend(){
  const now=Date.now();
  if(!this.chosen||now-this.chosenAt>Dictation.PROBE_TTL){this.chosen=chooseBackend();this.chosenAt=now;}
  return this.chosen;
 }
 /** Look again now, without waiting for the cache to lapse. */
 refresh(){this.chosen=null;return this.backend;}

 /** Whether this machine has anything to dictate with. */
 get available(){return this.backend.available;}
 /** Why not, when it is unavailable. Shown to the user rather than an ENOENT. */
 get unavailableReason(){return this.backend.reason;}

 start(){
  if(!this.available)return Promise.reject(Error(this.backend.reason));
  if(this.child)throw Error('Dictation is already listening.');
  // The helper stops when this file appears, which lets it finalise the phrase being
  // spoken. Killing it would drop that phrase, which is usually the one that matters.
  const stopFile=this.stopFile=path.join(os.tmpdir(),`hush-dictation-${crypto.randomUUID()}.stop`);
  return new Promise((resolve,reject)=>{
   let launch;
   try{launch=this.backend.command(stopFile);}catch(e){return reject(e);}
   const child=this.child=spawn(launch.command,launch.args,
    {windowsHide:true,stdio:['ignore','pipe','pipe'],...launch.options});
   let output='',failure='';
   child.stdout.on('data',b=>output+=b);
   child.stderr.on('data',b=>failure=(failure+b).slice(-2000));
   const finish=()=>{
    if(this.child===child)this.child=null;
    clearTimeout(this.giveUp);this.giveUp=null;
    try{fs.unlinkSync(stopFile);}catch{}
    try{launch.cleanup?.();}catch{}
   };
   child.on('error',error=>{finish();reject(error);});
   child.on('close',()=>{
    finish();
    try{
     const rows=output.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
     if(failure&&!rows.length)throw Error(failure);
     resolve(transcriptFrom(rows));
    }catch(e){reject(e);}
   });
  });
 }

 stop(){
  const child=this.child;
  if(!child)return;
  // Ask first, and only insist if the helper does not wind up on its own.
  try{fs.writeFileSync(this.stopFile,'');}catch{child.kill();return;}
  clearTimeout(this.giveUp);
  this.giveUp=setTimeout(()=>{if(this.child===child)child.kill();},8000);
  this.giveUp.unref?.();
 }
}
module.exports={Dictation,transcriptFrom};
