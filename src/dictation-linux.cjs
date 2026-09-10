// Linux has no system speech recogniser, so dictation there is two programs: one to
// record and one to transcribe. This runner joins them and speaks the same line protocol
// as the Windows and macOS helpers, so nothing above it knows the difference.
//
// The transcript arrives at the end rather than phrase by phrase, because a file
// transcriber has nothing to say until the recording stops. That is a real difference
// from the other two and docs/VOICE.md says so.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');

const say=row=>{process.stdout.write(JSON.stringify(row)+'\n');};
const fail=message=>{say({type:'error',message});process.exit(1);};

function argOf(name){
  const at=process.argv.indexOf(name);
  return at===-1?null:process.argv[at+1];
}

// Both halves are called the same way: a list of arguments in which {} is the wave file.
// Which recorder and which transcriber, and how each wants to be invoked, is the
// backend's decision in dictation-backends.cjs; this runner only joins them.
function withWave(template,wave){
  if(!template.length)return [wave];
  return template.includes('{}')
    ? template.map(part=>part==='{}'?wave:part.split('{}').join(wave))
    : [...template,wave];
}

const listOf=name=>{
  const at=process.argv.indexOf(name);
  return at===-1?[]:JSON.parse(process.argv[at+1]);
};

const stopFile=argOf('--stop-file');
const recorder=argOf('--recorder');
const transcriber=argOf('--transcriber');
const recorderTemplate=listOf('--recorder-args');
const transcriberTemplate=listOf('--transcriber-args');
if(!stopFile||!recorder||!transcriber)fail('Dictation was started without a recorder and a transcriber.');

const room=fs.mkdtempSync(path.join(os.tmpdir(),'hush-dictation-'));
const wave=path.join(room,'speech.wav');
const tidy=()=>{try{fs.rmSync(room,{recursive:true,force:true});}catch{}};

const recording=spawn(recorder,withWave(recorderTemplate,wave),{stdio:['ignore','ignore','pipe']});
let recorderNoise='';
recording.stderr.on('data',b=>{recorderNoise=(recorderNoise+b).slice(-2000);});
recording.on('error',e=>{tidy();fail(`Could not start ${path.basename(recorder)}: ${e.message}`);});

say({type:'ready'});

// Watch for the stop file rather than waiting on a signal, so the recording is closed
// properly and the file is complete before anything reads it.
const watching=setInterval(()=>{
  if(!fs.existsSync(stopFile))return;
  clearInterval(watching);
  // SIGINT lets a recorder finalise its wave header; SIGKILL would leave it truncated.
  recording.kill('SIGINT');
  setTimeout(()=>{if(recording.exitCode===null)recording.kill();},3000).unref?.();
},200);

// A microphone left open should not record forever.
const cap=setTimeout(()=>{clearInterval(watching);recording.kill('SIGINT');},30*60*1000);
cap.unref?.();

recording.on('close',()=>{
  clearInterval(watching);clearTimeout(cap);
  let size=0;
  try{size=fs.statSync(wave).size;}catch{}
  // A wave header with no audio behind it is silence, not a failure.
  if(size<=4096){tidy();say({type:'empty'});process.exit(0);}

  const run=spawn(transcriber,withWave(transcriberTemplate,wave),{stdio:['ignore','pipe','pipe']});
  let text='',noise='';
  run.stdout.on('data',b=>text+=b);
  run.stderr.on('data',b=>{noise=(noise+b).slice(-2000);});
  run.on('error',e=>{tidy();fail(`Could not run ${path.basename(transcriber)}: ${e.message}`);});
  run.on('close',code=>{
    tidy();
    if(code!==0)fail(`${path.basename(transcriber)} failed: ${(noise||'no output').trim().slice(-400)}`);
    // whisper.cpp prints timestamped lines unless told not to; keep only what was said.
    const spoken=text.split(/\r?\n/)
      .map(line=>line.replace(/^\s*\[[0-9:.\s>-]+\]\s*/,'').trim())
      .filter(Boolean).join(' ').trim();
    if(spoken)say({type:'text',text:spoken});else say({type:'empty'});
    process.exit(0);
  });
});
