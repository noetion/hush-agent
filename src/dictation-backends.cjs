// Which process does the listening, per platform. Each backend answers three things:
// whether it can run here, why not if it cannot, and what to spawn. The line protocol
// they all speak is in docs/VOICE.md.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {buildMacHelper}=require('./mac-helper-build.cjs');

/** First of these that exists on PATH, or null. */
function onPath(names){
  const dirs=(process.env.PATH||'').split(path.delimiter).filter(Boolean);
  const suffixes=process.platform==='win32'?['.exe','.cmd','']:[''];
  for(const name of names)
    for(const dir of dirs)
      for(const suffix of suffixes){
        const full=path.join(dir,name+suffix);
        try{if(fs.existsSync(full))return full;}catch{}
      }
  return null;
}

// Runtime files have to be read from outside the archive; electron-builder unpacks them.
const beside=name=>path.join(__dirname,name).replace('app.asar','app.asar.unpacked');

// Windows has had a recogniser in the box since Vista and it needs nothing installed.
function windowsBackend(){
  return {
    name:'windows',
    available:true,
    reason:'',
    command(stopFile){
      return {
        command:'powershell.exe',
        // A wave file is how this is checked without a microphone. Keeping it in the
        // environment rather than the call signature leaves the app's own call plain.
        args:['-NoProfile','-File',beside('dictation.ps1'),'-StopFile',stopFile,
          ...(process.env.HUSH_DICTATION_WAV?['-WavePath',process.env.HUSH_DICTATION_WAV]:[])],
      };
    },
  };
}

// macOS needs a compiled helper: there is no speech recogniser on the command line, and
// the API is Swift. The binary is built during packaging; in a source checkout it is
// compiled once and cached, which costs a second or two the first time.
function macBackend(){
  const source=beside('dictation-macos.swift');
  const built=beside('dictation-macos');
  const swiftc=onPath(['swiftc']);
  if(!fs.existsSync(built)&&!swiftc)
    return {name:'macos',available:false,
      reason:'Dictation needs the Xcode command line tools to build its speech helper. Run xcode-select --install, or type your reply instead.'};
  return {
    name:'macos',
    available:true,
    reason:'',
    async command(stopFile){
      return {command:await compileMacHelper(source,built,swiftc),args:['--stop-file',stopFile,
        ...(process.env.HUSH_DICTATION_WAV?['--wave',process.env.HUSH_DICTATION_WAV]:[])]};
    },
  };
}

/** Return the helper binary, building it first if the build did not ship one. */
async function compileMacHelper(source,built,swiftc){
  // Packaged helpers are already built and validated; archive timestamps are not
  // compilation inputs, and an installed app must never need a compiler.
  if(built.includes('app.asar.unpacked')&&fs.existsSync(built))return built;
  // A packaged app cannot write beside itself, so build into the user's cache instead.
  const target=canWrite(path.dirname(built))?built
    :path.join(os.tmpdir(),`hush-dictation-macos-${process.getuid?.()??0}`);
  if(!swiftc)throw Error('Dictation needs the Xcode command line tools to build its speech helper.');
  return buildMacHelper(source,target,swiftc);
}

function canWrite(directory){
  try{fs.accessSync(directory,fs.constants.W_OK);return true;}catch{return false;}
}

// Linux has no system recogniser, so it is two separate pieces: something to record
// with, and something to transcribe with. Both have to be present, and saying which one
// is missing is more use than a generic refusal.
const LINUX_RECORDERS=['arecord','parecord','ffmpeg'];

// 16 kHz mono 16-bit is what every speech model wants, so record it that way rather than
// resampling afterwards. {} is where the destination file goes.
function recorderArgs(recorder){
  const name=path.basename(recorder).replace(/\.exe$/,'');
  if(name==='arecord')return ['-q','-f','S16_LE','-r','16000','-c','1','{}'];
  if(name==='parecord')return ['--format=s16le','--rate=16000','--channels=1','--file-format=wav','{}'];
  if(name==='ffmpeg')return ['-loglevel','error','-f','alsa','-i','default','-ar','16000','-ac','1','-y','{}'];
  // Something the user named themselves: give it the destination and let it decide.
  return ['{}'];
}
const LINUX_TRANSCRIBERS=['whisper-cli','whisper-cpp','whisper'];

function linuxTranscriber(){
  // Anything the user names wins outright: they know what they installed.
  if(process.env.HUSH_DICTATION_CMD){
    const [command,...args]=process.env.HUSH_DICTATION_CMD.split(/\s+/).filter(Boolean);
    return command?{command,args}:null;
  }
  const found=onPath(LINUX_TRANSCRIBERS);
  if(!found)return null;
  // A whisper.cpp CLI cannot do anything without a model, and there is no sensible
  // default path to guess, so treat a missing model as missing the transcriber.
  const model=process.env.HUSH_DICTATION_MODEL;
  if(!model||!fs.existsSync(model))return {command:found,args:null,needsModel:true};
  return {command:found,args:['-m',model,'-nt','-f','{}']};
}

function linuxBackend(){
  const recorder=process.env.HUSH_DICTATION_RECORDER||onPath(LINUX_RECORDERS);
  const transcriber=linuxTranscriber();
  const unavailable=reason=>({name:'linux',available:false,reason});
  if(!recorder&&!transcriber)
    return unavailable(`Dictation needs something to record with (${LINUX_RECORDERS.join(', ')}) and something to transcribe with (a whisper.cpp CLI, or set HUSH_DICTATION_CMD). Neither is installed.`);
  if(!recorder)
    return unavailable(`Dictation needs one of ${LINUX_RECORDERS.join(', ')} to record with. Install one, or set HUSH_DICTATION_RECORDER.`);
  if(!transcriber)
    return unavailable(`Dictation found ${path.basename(recorder)} to record with but nothing to transcribe with. Install a whisper.cpp CLI, or set HUSH_DICTATION_CMD.`);
  if(transcriber.needsModel)
    return unavailable(`${path.basename(transcriber.command)} needs a model. Point HUSH_DICTATION_MODEL at a .bin, or set HUSH_DICTATION_CMD to the full command.`);
  return {
    name:'linux',
    available:true,
    reason:'',
    command(stopFile){
      return {command:process.execPath,
        args:[beside('dictation-linux.cjs'),'--stop-file',stopFile,
          '--recorder',recorder,'--recorder-args',JSON.stringify(recorderArgs(recorder)),
          '--transcriber',transcriber.command,
          '--transcriber-args',JSON.stringify(transcriber.args||[])],
        // The runner is this same Electron binary told to behave as Node, which is what
        // a packaged build has instead of a separate node.
        options:{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}};
    },
  };
}

function chooseBackend(platform=process.platform){
  if(platform==='win32')return windowsBackend();
  if(platform==='darwin')return macBackend();
  if(platform==='linux')return linuxBackend();
  return {name:platform,available:false,reason:`Dictation is not available on ${platform}. Type your reply instead.`};
}

module.exports={chooseBackend,onPath,windowsBackend,macBackend,linuxBackend,linuxTranscriber,recorderArgs,LINUX_RECORDERS,LINUX_TRANSCRIBERS};
