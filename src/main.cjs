const {app,BrowserWindow,Tray,Menu,nativeImage,globalShortcut,ipcMain,screen,dialog,shell}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const {Store}=require('./store.cjs');const providers=require('./providers.cjs');const {herdr}=require('./herdr.cjs');const {createBridge}=require('./bridge.cjs');const {WindowPolicy}=require('./window-policy.cjs');
const store=new Store();let panel,notice,tray,policy,bridge,herdrConnection;let quitting=false,choosingFolder=false;let settings={corner:'top-right',quiet:false,shortcut:'CommandOrControl+Shift+Space',hideOnBlur:true,panelPosition:null,fadeWhenIdle:true,transparent:false};let placing=false;const PANEL_HEIGHTS={full:500,compact:320,collapsed:46};const DIM={faded:0.5,collapsed:0.24};let fadeTimer,settleFade=null,dimmed=false,dimDepth='faded';let settingsFile,metadataFile;let saved=[];let shortcutOk=false;
const {liveOwner,postToOwner}=require('./claude-session.cjs');
const {applyGlass}=require('./glass.cjs');let material='solid';
const {Cursor}=require('./cursor.cjs');const cursor=new Cursor(store);
const {Dictation}=require('./dictation.cjs');const dictation=new Dictation();
const {importImages}=require('./media.cjs');
const {queueCodex}=require('./codex-queue.cjs');
const {History}=require('./history.cjs');let history;
const watched=new Map();const connecting=new Set();
app.setName('Hush');app.setPath('userData',require('./app-data.cjs').dataDirectory());
app.setAppUserModelId('dev.hush.agent');
const launchInfo={version:app.getVersion(),exe:process.env.PORTABLE_EXECUTABLE_FILE||process.execPath};
if(!app.requestSingleInstanceLock(launchInfo))app.quit();
else{
app.on('second-instance',(_event,_argv,_cwd,incoming)=>{
  policy?.open();
  if(incoming?.version!==app.getVersion()&&incoming?.exe&&fs.existsSync(incoming.exe)){
    dialog.showMessageBox(panel,{type:'info',title:'Hush update',message:`Hush ${incoming.version} is ready. This window is ${app.getVersion()}.`,detail:'Restart to open the selected build. Finish any running agent turns first.',buttons:['Keep working','Restart Hush'],defaultId:0,cancelId:0}).then(({response})=>{if(response===1){app.relaunch({execPath:incoming.exe,args:[]});app.quit();}});
  }
});
app.whenReady().then(start).catch(e=>{dialog.showErrorBox('Hush could not start',e.message);app.quit();});
}
function snapshot(){return {sessions:store.list(),settings,shortcutOk,saved,panelVisible:policy?.isOpen()||false,bridgePath:bridge?.filename||'',version:app.getVersion(),material,dictation:dictation.available,dictationReason:dictation.unavailableReason};}
let broadcastTimer;
function broadcast(){if(broadcastTimer||quitting)return;broadcastTimer=setTimeout(()=>{broadcastTimer=null;if(quitting)return;const sessions=[...store.sessions.values()];if(panel&&!panel.isDestroyed()&&policy?.isOpen())panel.webContents.send('state',snapshot());if(notice&&!notice.isDestroyed())notice.webContents.send('state',{material,unread:sessions.filter(s=>s.unread).length});updateTray();},32);}
// The tray glyph is drawn rather than shipped: an H two pixels wide with a crossbar.
// macOS asks for a template image, which it recolours itself for a light or dark menu
// bar, on a menu bar that is Retina. The pale green reads on Windows' dark tray and
// would all but vanish on a light macOS one, so draw it black at twice the size there
// and let the OS decide how it looks.
function trayImage(){
  const template=process.platform==='darwin';
  const scale=template?2:1,size=16*scale,buf=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=Math.floor(x/scale),v=Math.floor(y/scale);
    if(!((u===3||u===4||u===11||u===12||(v===7||v===8)&&u>3&&u<12)&&v>2&&v<13))continue;
    const i=(y*size+x)*4;
    buf[i]=template?0:190;buf[i+1]=template?0:225;buf[i+2]=template?0:190;buf[i+3]=255;
  }
  const image=nativeImage.createFromBitmap(buf,{width:size,height:size,scaleFactor:scale});
  if(template)image.setTemplateImage(true);
  return image;
}
let traySignature='';
function updateTray(){if(!tray)return;const count=[...store.sessions.values()].filter(s=>s.unread).length;const signature=count+':'+settings.quiet;if(signature===traySignature)return;traySignature=signature;tray.setToolTip(`Hush${count?` · ${count} need attention`:''}${settings.quiet?' · Quiet':''}`);tray.setContextMenu(Menu.buildFromTemplate([{label:`Open Hush${count?` (${count})`:''}`,click:()=>policy.open()},{label:'Quiet mode',type:'checkbox',checked:settings.quiet,click:item=>changeSettings({quiet:item.checked})},{type:'separator'},{label:'Quit Hush',click:()=>app.quit()}]));}
// A parked panel is only useful if it stays parked. Keep enough of it on a real
// display that the draggable header is always reachable, so a remembered position
// from a monitor that is no longer attached cannot strand it offscreen.
// Whether a window takes the pointer or lets clicks reach what is behind it.
// Every caller goes through here so the two overlay surfaces cannot drift apart.
function takesPointer(win,yes){if(win&&!win.isDestroyed())win.setIgnoreMouseEvents(!yes,{forward:true});}
// A dimmed panel is ambient rather than interactive: it keeps showing status while
// letting clicks reach whatever is underneath. Stepped so it reads as settling.
// Resolves when the animation actually lands, so callers never have to guess how long
// it took. A fade that is superseded resolves too: as far as whoever asked is concerned
// it is over, and leaving that promise pending would hang them.
function fadeTo(target,onDone){
  clearInterval(fadeTimer);
  settleFade?.();settleFade=null;
  if(!panel||panel.isDestroyed())return Promise.resolve();
  const from=panel.getOpacity();
  const steps=Math.max(1,Math.round(Math.abs(target-from)/0.08));
  let i=0;
  return new Promise(resolve=>{
    settleFade=resolve;
    fadeTimer=setInterval(()=>{
      i++;
      panel.setOpacity(i>=steps?target:from+(target-from)*(i/steps));
      if(i>=steps){clearInterval(fadeTimer);settleFade=null;onDone?.();resolve();}
    },16);
  });
}
// Two depths, because the two stages leave very different amounts to read. A faded full
// panel still shows a conversation worth glancing at. Once it has collapsed to a status
// bar there is one line left and nothing to act on, so it can get much further out of
// the way; over a video that is the difference between noticing it and not.
function setDimmed(on,depth){
  if(!panel||panel.isDestroyed())return Promise.resolve();
  if(on&&(!settings.fadeWhenIdle||!policy?.isOpen()))return Promise.resolve();
  const wanted=DIM[depth]?depth:'faded';
  if(dimmed===on&&dimDepth===wanted)return Promise.resolve();
  dimmed=on;dimDepth=wanted;
  if(on)return fadeTo(DIM[wanted],()=>{if(dimmed)takesPointer(panel,false);});
  takesPointer(panel,true);
  return fadeTo(1);
}
function undim(){clearInterval(fadeTimer);settleFade?.();settleFade=null;dimmed=false;dimDepth='faded';takesPointer(panel,true);if(panel&&!panel.isDestroyed())panel.setOpacity(1);}
function reachable(x,y,w){return screen.getAllDisplays().some(d=>{const r=d.workArea;return x+w>=r.x+80&&x<=r.x+r.width-80&&y>=r.y&&y<r.y+r.height-40;});}
function position(){const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());const r=display.workArea;const left=settings.corner.endsWith('left'),top=settings.corner.startsWith('top');placing=true;try{for(const win of[panel,notice]){const [w,h]=win.getSize();const parked=win===panel&&settings.panelPosition&&reachable(settings.panelPosition[0],settings.panelPosition[1],w);if(parked)win.setPosition(settings.panelPosition[0],settings.panelPosition[1]);else win.setPosition(left?r.x+16:r.x+r.width-w-16,top?r.y+16:r.y+r.height-h-16);}}finally{placing=false;}}
function changeSettings(patch){
  if(patch.corner && !['top-left','top-right','bottom-left','bottom-right'].includes(patch.corner))throw Error('Invalid corner.');
  for(const key of ['quiet','hideOnBlur','fadeWhenIdle','transparent'])if(key in patch && typeof patch[key]!=='boolean')throw Error('Invalid setting.');
  settings={...settings,...Object.fromEntries(Object.entries(patch).filter(([k])=>['corner','quiet','hideOnBlur','fadeWhenIdle','transparent'].includes(k)))};
  if('corner' in patch)settings.panelPosition=null;
  fs.writeFileSync(settingsFile,JSON.stringify(settings));policy.setQuiet(settings.quiet);position();broadcast();return snapshot();
}
// Hand a session back to a real terminal. Every platform below launches an argv
// vector rather than a command line, so a path or a title never becomes shell syntax.
// macOS is the exception and is handled by writing the command to a file we quote
// ourselves, because Terminal.app has no argv entry point.
const {shellQuote}=require('./terminal.cjs');
function linuxTerminal(){
  const candidates=[
    ['x-terminal-emulator',(bin,args)=>['-e',bin,...args]],
    ['gnome-terminal',(bin,args,cwd)=>[...(cwd?['--working-directory',cwd]:[]),'--',bin,...args]],
    ['konsole',(bin,args,cwd)=>[...(cwd?['--workdir',cwd]:[]),'-e',bin,...args]],
    ['xfce4-terminal',(bin,args,cwd)=>[...(cwd?['--working-directory',cwd]:[]),'-x',bin,...args]],
    ['alacritty',(bin,args,cwd)=>[...(cwd?['--working-directory',cwd]:[]),'-e',bin,...args]],
    ['kitty',(bin,args,cwd)=>[...(cwd?['--directory',cwd]:[]),bin,...args]],
    ['xterm',(bin,args)=>['-e',bin,...args]],
  ];
  const dirs=(process.env.PATH||'').split(path.delimiter);
  for(const [name,build] of candidates)
    if(dirs.some(d=>{try{return fs.existsSync(path.join(d,name));}catch{return false;}}))
      return {name,build};
  return null;
}
async function openTerminal(binary,args,cwd){
  const run=(command,argv,options={})=>new Promise((resolve,reject)=>{
    const child=spawn(command,argv,{windowsHide:true,stdio:'ignore',...options});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error(`${command} exited with ${code}.`)));
  });
  if(process.platform==='win32')
    return run('wt.exe',['-w','new','-M','new-tab',...(cwd?['-d',cwd]:[]),binary,...args])
      .catch(()=>{throw Error('Windows Terminal could not open. Install Windows Terminal or resume the session in your terminal.');});
  if(process.platform==='darwin'){
    // Terminal.app takes a file, not a command, so build one and quote it ourselves.
    const script=path.join(app.getPath('temp'),`hush-handoff-${Date.now()}.command`);
    const line=[binary,...args].map(shellQuote).join(' ');
    fs.writeFileSync(script,`#!/bin/sh\n${cwd?`cd ${shellQuote(cwd)}\n`:''}exec ${line}\n`,{mode:0o700});
    return run('open',['-a','Terminal',script])
      .catch(()=>{throw Error('Terminal could not open. Resume the session in your own terminal.');});
  }
  const terminal=linuxTerminal();
  if(!terminal)throw Error('No terminal emulator was found. Install one, or resume the session in your own terminal.');
  // Also spawn in the project directory. Emulators with a flag for it get one above;
  // the two without a flag inherit it this way instead of opening somewhere unrelated.
  const inherit=cwd&&fs.existsSync(cwd)?{cwd}:{};
  return run(terminal.name,terminal.build(binary,args,cwd),inherit)
    .catch(()=>{throw Error(`${terminal.name} could not open. Resume the session in your own terminal.`);});
}
async function openSource(provider,id,cwd,ownerId){
  const s=store.get(ownerId);if(s&&(s.status==='working'||s.request))throw Error('Wait for the current turn or request to finish before opening the terminal.');
  if(s) {await store.actions.get(s.id).dispose?.();store.update(s.id,{status:'offline',canReply:false});}
  try{await openTerminal(providers.executable(provider),provider==='codex'?['resume',id]:['--resume',id],cwd);policy.hide();}catch(e){throw Error(e.message+' Hush released this connection; reconnect from Tasks to continue.');}
}
function persistMetadata(){const records=new Map(saved.map(s=>[s.provider+':'+s.sourceId,s]));for(const s of store.list().filter(s=>['Codex','Claude Code'].includes(s.provider)&&s.sourceId)){const {provider,title,cwd,sourceId}=s;records.set(provider+':'+sourceId,{provider,title,cwd,sourceId});}saved=[...records.values()].slice(-100);fs.writeFileSync(metadataFile,JSON.stringify(saved));}
// Bridge a real Claude Code session rather than owning one. Claude Code spawns
// bin/channel.cjs as a channel server, which registers itself with Hush's bridge, so
// the session stays an ordinary terminal session the user can also drive directly and
// Hush is a channel into it. This is the supported answer to reaching a conversation
// another client is running: resuming one writes to its transcript without the running
// client ever seeing it.
async function startChannelSession(payload){
  let cwd=payload?.cwd;
  if(cwd)checkChannelDirectory(cwd);
  else{cwd=path.join(app.getPath('userData'),'conversations',require('node:crypto').randomUUID());fs.mkdirSync(cwd,{recursive:true});}
  const title=String(payload?.title||path.basename(cwd)||'Claude Code').slice(0,100);
  const config=path.join(app.getPath('userData'),'channel-mcp.json');
  fs.writeFileSync(config,JSON.stringify({mcpServers:{hush:{
    command:process.execPath,
    args:[path.join(__dirname,'..','bin','channel.cjs')],
    // A packaged Hush is Electron, so the child has to be told to behave as Node.
    env:{ELECTRON_RUN_AS_NODE:'1',HUSH_BRIDGE_FILE:bridge.filename,HUSH_CHANNEL_TITLE:title},
  }}},null,2),{mode:0o600});
  await openTerminal(providers.executable('claude'),
    ['--mcp-config',config,'--dangerously-load-development-channels','server:hush'],cwd);
  return {};
}
function checkChannelDirectory(cwd){
  if(!path.isAbsolute(cwd)||!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory())
    throw Error('Choose an existing project folder.');
}
async function connect(payload){
  if(payload&&payload.provider==='claude-channel')return startChannelSession(payload);
  if(!payload||!['codex','claude','cursor','herdr'].includes(payload.provider))throw Error('Choose a provider.');
  if(payload.provider==='herdr'){if(herdrConnection)throw Error('Herdr is already connected.');herdrConnection=await herdr(store,{},openTerminal);return {count:herdrConnection.count};}
  if(payload.resumeId && !/^[a-zA-Z0-9-]{8,100}$/.test(payload.resumeId))throw Error('Invalid session ID.');
  if(payload.resumeId&&store.list().some(s=>s.sourceId===payload.resumeId&&s.status!=='offline'&&!s.external))throw Error('This session is already connected.');
  const key=payload.provider+':'+payload.resumeId;
  if(payload.resumeId&&connecting.has(key))throw Error('This conversation is already connecting.');
  if(payload.resumeId)connecting.add(key);
  try{
  let previous=null,cwd=payload.cwd;
  if(payload.resumeId){previous=await history.read(payload.provider,payload.resumeId);if(previous.busy)throw Error('This task is still running. Finish its turn in the original app before continuing here.');cwd=previous.cwd;if(!cwd)throw Error('The provider did not save a working folder. Open this conversation in its original app.');}
  else if(!cwd){cwd=path.join(app.getPath('userData'),'conversations',require('node:crypto').randomUUID());fs.mkdirSync(cwd,{recursive:true});}
  const s=await (payload.provider==='cursor'?async(_store,options)=>cursor.connect(options):providers[payload.provider])(store,{cwd,title:previous?.title||String(payload.title||'New conversation').slice(0,100),resumeId:payload.resumeId},openSource);
  if(previous){store.update(s.id,{messages:previous.messages});const preview=store.list().find(x=>x.external&&x.sourceId===s.sourceId&&x.provider===s.provider);if(preview)await store.remove(preview.id);}
  persistMetadata();return {id:s.id};
  }catch(e){
    if(e.code==='SESSION_OWNED'){
      const preview=store.list().find(s=>s.external&&s.historyProvider===payload.provider&&s.sourceId===payload.resumeId);
      if(preview){store.update(preview.id,{resumeBlocked:true});return {id:preview.id};}
    }
    throw e;
  }finally{connecting.delete(key);}
}
async function previewTask(payload){
  if(payload.provider==='cursor'){const rows=await cursor.list();const task=rows.find(t=>t.sourceId===payload.sourceId);if(!task)throw Error('Refresh Cursor conversations first.');const existing=store.list().find(s=>s.provider==='Cursor'&&s.sourceId===task.sourceId&&s.status!=='offline');if(existing)return {id:existing.id};const s=await cursor.connect({cwd:task.cwd,title:task.title,resumeId:task.sourceId});return {id:s.id};}
  const existing=store.list().find(s=>s.sourceId===payload.sourceId&&s.provider===(payload.provider==='codex'?'Codex':'Claude Code')&&!s.external&&s.status!=='offline');if(existing)return {id:existing.id};
  const task=await history.read(payload.provider,payload.sourceId);
  const id=`history:${task.provider}:${task.sourceId}`;
  let s=store.sessions.get(id);
  if(!s)s=store.add({id,provider:task.provider==='codex'?'Codex':'Claude Code',title:task.title,cwd:task.cwd,sourceId:task.sourceId,canReply:task.provider==='codex'||(task.provider==='claude'&&!!liveOwner(task.sourceId)),canOpen:task.provider==='codex'},{reply:async(text,options={})=>{
    // A Claude conversation another window is running can still be written to, over
    // that session's own inbox socket. Resuming it cannot: that starts a second process
    // and the message lands in the transcript unseen. Offer the route that works.
    if(task.provider==='claude'){
      if(options.attachments?.length)throw Error('Images cannot be sent to a conversation another Claude Code window is running. Reply in that window to attach one.');
      await postToOwner(task.sourceId,text);
      store.update(id,{status:'working'});
      return;
    }
    const current=store.get(id);if(current.queuePending)throw Error('Your previous reply is still queued in Codex.');const knownUserIds=current.messages.filter(m=>m.role==='you').map(m=>m.id);const receipt=await queueCodex(task.sourceId,text,app.getPath('userData'),{...options,...(options.attachments?.length?{rpc:await history.codex()}:{})});store.update(id,{queuePending:{id:receipt.id,text,knownUserIds}});},open:async()=>{await shell.openExternal(`codex://threads/${encodeURIComponent(task.sourceId)}`);policy.hide();},dispose:()=>{clearTimeout(watched.get(id));watched.delete(id);}});
  store.update(id,{external:true,shared:task.provider==='codex',images:task.provider==='codex',resumeBlocked:false,historyProvider:task.provider,messages:task.messages,status:task.status,unread:false});
  if(!watched.has(id)){
    const poll=async()=>{try{
      if(quitting||!watched.has(id))return;
      const next=await history.read(task.provider,task.sourceId);if(quitting||!watched.has(id))return;
      const current=store.get(id);const pending=current.queuePending;const delivered=pending&&next.messages.some(m=>m.role==='you'&&m.text===pending.text&&!pending.knownUserIds.includes(m.id));if(pending&&!delivered)next.messages.push({id:pending.id,role:'you',text:pending.text});const changed=JSON.stringify(current.messages)!==JSON.stringify(next.messages);
      const newAgentOutput=next.messages.some(m=>m.role==='agent'&&!current.messages.some(old=>old.id===m.id));
      const completed=current.status==='working'&&next.status!=='working';
      if(changed||delivered||current.status!==next.status){store.update(id,{messages:next.messages,status:next.status,unread:current.unread||newAgentOutput||completed,queuePending:delivered?null:current.queuePending});if(newAgentOutput||completed)store.emit('attention',current);}
    }catch(e){if(!quitting&&watched.has(id)){const current=store.get(id);if(current.status!=='offline'){store.message(id,'system','History refresh failed: '+e.message);store.update(id,{status:'offline'});}}}
    finally{if(!quitting&&watched.has(id))watched.set(id,setTimeout(poll,6000));}};
    watched.set(id,setTimeout(poll,6000));
  }
  return {id};
}
async function action(name,payload){
  if(name==='snapshot')return snapshot();
  if(name==='open'){position();policy.open();undim();return;}
  if(name==='hide'){policy.hide();return;}
  if(name==='recede-log'){if(process.env.HUSH_DEBUG_RECEDE)try{fs.appendFileSync(path.join(app.getPath('userData'),'recede.log'),new Date().toISOString()+' '+String(payload&&payload.event).slice(0,40)+' '+JSON.stringify((payload&&payload.detail)||{})+String.fromCharCode(10));}catch{}return;}
  if(name==='pointer-over-panel'){if(!panel||panel.isDestroyed())return false;const p=screen.getCursorScreenPoint(),b=panel.getBounds();return p.x>=b.x&&p.x<b.x+b.width&&p.y>=b.y&&p.y<b.y+b.height;}
  if(name==='panel-dim')return setDimmed(payload?.on===true,payload?.depth);
  if(name==='notice-interactive'){takesPointer(notice,payload?.on===true);return;}
  if(name==='dismiss-notice'){notice.hide();return;}
  if(name==='settings')return changeSettings(payload);
  if(name==='choose-folder'){choosingFolder=true;try{const r=await dialog.showOpenDialog(panel,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0];}finally{choosingFolder=false;policy.open();}}
  if(name==='connect')return connect(payload);
  if(name==='list-tasks'){if(payload?.provider==='cursor')return {items:(await cursor.list()).filter(t=>!payload.query||t.title.toLowerCase().includes(payload.query.toLowerCase())),errors:[],nextCursor:null};if(!payload?.provider||payload.provider==='all'){const results=await Promise.allSettled([history.list(payload),cursor.list()]);const result=results[0].status==='fulfilled'?results[0].value:{items:[],errors:[{provider:'Codex/Claude',message:results[0].reason.message}],nextCursor:null};if(results[1].status==='fulfilled')result.items.push(...results[1].value.filter(t=>!payload?.query||t.title.toLowerCase().includes(payload.query.toLowerCase())));else result.errors.push({provider:'Cursor',message:results[1].reason.message});result.items.sort((a,b)=>b.updatedAt-a.updatedAt);return result;}return history.list(payload);}
  if(name==='preview-task')return previewTask(payload);
  if(name==='refresh-task'){const s=store.get(payload.id);if(!s.external)throw Error('This session is connected.');return previewTask({provider:s.historyProvider,sourceId:s.sourceId});}
  if(name==='signin'){if(payload.provider==='cursor'){const r=require('./cursor.cjs').cursorRuntime();await openTerminal(r.binary,[r.script,'login']);return;}if(!['codex','claude'].includes(payload.provider))throw Error('Choose Codex or Claude Code.');await openTerminal(providers.executable(payload.provider),payload.provider==='codex'?['login']:['auth','login']);return;}
  if(name==='clear-images'){if(store.list().some(s=>s.sending||s.queuePending||s.status==='working'))throw Error('Wait for queued replies and agent turns to finish before clearing images.');const directory=path.join(app.getPath('userData'),'attachments');if(fs.existsSync(directory))for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.isFile()&&/^[0-9a-f-]{36}\.(png|jpe?g|gif|webp)$/i.test(entry.name))fs.unlinkSync(path.join(directory,entry.name));}for(const s of store.list())store.update(s.id,{attachments:[]});return;}
  if(name==='choose-images'){const s=store.get(payload.id);if(!s.images)throw Error('Images are unavailable for this connection.');choosingFolder=true;try{const result=await dialog.showOpenDialog(panel,{properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','gif']}]});if(result.canceled)return;const existing=s.attachments||[];if(existing.length+result.filePaths.length>4)throw Error('Attach up to four images.');store.update(s.id,{attachments:[...existing,...importImages(result.filePaths,path.join(app.getPath('userData'),'attachments'))]});}finally{choosingFolder=false;policy.open();}return;}
  if(name==='remove-image'){const s=store.get(payload.id);if(s.sending)throw Error('Wait for the image to finish sending.');const removed=(s.attachments||[]).find(a=>a.id===payload.attachmentId);if(removed)fs.unlinkSync(removed.path);store.update(s.id,{attachments:(s.attachments||[]).filter(a=>a.id!==payload.attachmentId)});return;}
  if(name==='dictate')return dictation.start();
  if(name==='stop-dictation'){dictation.stop();return;}
  if(name==='models'){const s=store.get(payload.id);if(s.shared)return {models:[],managed:true};if(s.models)return {models:s.models};let models=[];if(s.provider==='Codex'){const result=await (await history.codex()).call('model/list',{});models=result.data.map(m=>({id:m.model,name:m.displayName}));}else if(s.provider==='Claude Code'){const sdk=await import('@anthropic-ai/claude-agent-sdk');async function* empty(){}const q=sdk.query({prompt:empty(),options:{cwd:s.cwd,pathToClaudeCodeExecutable:providers.executable('claude')}});try{models=(await q.supportedModels()).map(m=>({id:m.value,name:m.displayName}));}finally{q.close();}}store.update(s.id,{models});return {models};}
  if(name==='set-model'){const s=store.get(payload.id);if(s.shared||(payload.model&&!s.models?.some(m=>m.id===payload.model)))throw Error('Choose an available model for this connection.');store.update(s.id,{selectedModel:payload.model});return;}
  if(name==='reply'){const s=store.get(payload.id),attachments=s.attachments||[];const delivery=store.reply(payload.id,payload.text,{attachments,model:s.selectedModel});await delivery;store.update(s.id,{attachments:(s.attachments||[]).filter(a=>!attachments.some(sent=>sent.id===a.id))});return;}

  if(name==='answer')return store.answer(payload.id,payload.requestId,payload.value);
  if(name==='source')return store.open(payload.id);
  if(name==='seen')return store.seen(payload.id);
  if(name==='remove'){await store.remove(payload.id);persistMetadata();return;}
  if(name==='panel-size'){const height=PANEL_HEIGHTS[payload?.mode];if(!height)throw Error('Unknown panel size.');const [w]=panel.getSize();placing=true;try{panel.setResizable(true);panel.setContentSize(w,height);}finally{panel.setResizable(false);placing=false;}position();return;}
  if(name==='test-notification'){notice.webContents.send('preview');policy.lastNotice=0;policy.hide();policy.attention();return;}
  throw Error('Unknown action.');
}
// Startup on a machine you cannot attach to is otherwise opaque: if it stalls before the
// self-test begins, there is no report and no output to say how far it got. Only active
// during the self-test, and never on a user's machine.
const mark=process.env.HUSH_SELF_TEST?step=>{
  try{fs.appendFileSync(path.join(process.env.HUSH_ARTIFACTS||'artifacts','startup.log'),
    `${new Date().toISOString()} ${step}\n`);}catch{}
}:()=>{};
async function start(){
  mark('start');
  const data=app.getPath('userData');fs.mkdirSync(data,{recursive:true});settingsFile=path.join(data,'settings.json');metadataFile=path.join(data,'sessions.json');
  history=new History(data);
  try{settings={...settings,...JSON.parse(fs.readFileSync(settingsFile))};}catch{}try{saved=JSON.parse(fs.readFileSync(metadataFile));}catch{}
  const common={show:false,frame:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,transparent:true,backgroundColor:'#00000000',hasShadow:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true}};
  panel=new BrowserWindow({...common,width:390,height:PANEL_HEIGHTS.full,skipTaskbar:false,icon:path.join(__dirname,process.platform==='win32'?'assets/hush.ico':'assets/hush.png'),title:'Hush '+app.getVersion()});notice=new BrowserWindow({...common,width:276,height:62,focusable:false});
  panel.setAlwaysOnTop(true,'screen-saver');notice.setAlwaysOnTop(true,'screen-saver');takesPointer(notice,false);
  for(const win of[panel,notice]){win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.on('close',e=>{if(!quitting){e.preventDefault();if(win===panel)policy?.hide();else win.hide();}});}
  let blurTimer,restoreUntil=0;
  panel.on('blur',()=>{clearTimeout(blurTimer);blurTimer=setTimeout(()=>{if(settings.hideOnBlur&&!choosingFolder&&Date.now()>restoreUntil&&!panel.isFocused()&&policy?.isOpen())policy.hide();},200);});
  let parkTimer;const remember=()=>{if(placing||!panel||panel.isDestroyed())return;settings.panelPosition=panel.getPosition();clearTimeout(parkTimer);parkTimer=setTimeout(()=>{try{fs.writeFileSync(settingsFile,JSON.stringify(settings));}catch{}},400);};
  panel.on('move',remember);panel.on('moved',remember);
  panel.on('show',()=>{undim();broadcast();});panel.on('hide',()=>{dictation.stop();undim();broadcast();});panel.on('minimize',()=>{dictation.stop();clearTimeout(blurTimer);broadcast();});
  panel.on('restore',()=>{clearTimeout(blurTimer);restoreUntil=Date.now()+500;notice.hide();position();setImmediate(()=>{if(!quitting&&!panel.isDestroyed()){panel.show();panel.focus();broadcast();}});});
  panel.on('closed',()=>clearTimeout(blurTimer));
  mark('windows created');
  policy=new WindowPolicy({panel,notice,notifyChanged:broadcast});policy.setQuiet(settings.quiet);
  bridge=await createBridge(store,data);
  mark('bridge up');
  tray=new Tray(trayImage());tray.on('click',()=>{position();policy.open();});updateTray();
  shortcutOk=globalShortcut.register(settings.shortcut,()=>{if(dimmed){undim();panel.focus();return;}position();policy.isOpen()?policy.hide():policy.open();});
  ipcMain.handle('hush',async(event,name,payload)=>{if(![panel.webContents,notice.webContents].includes(event.sender))throw Error('Unknown window.');try{return {ok:true,value:await action(name,payload)};}catch(e){return {ok:false,error:e.message};}});
  store.on('change',broadcast);store.on('attention',()=>{position();if(policy?.isOpen())undim();policy.attention();});
  mark('tray and shortcut');
  await panel.loadFile(path.join(__dirname,'ui/index.html'));await notice.loadFile(path.join(__dirname,'ui/notice.html'));position();
  mark('renderers loaded');
  material=await applyGlass([panel,notice]);broadcast();
  if(!fs.existsSync(settingsFile))fs.writeFileSync(settingsFile,JSON.stringify(settings));
  // An explicit executable launch should show the app, including return visits.
  // Hiding the panel still leaves the normal tray-only idle state.
  mark('glass applied');
  if(!process.env.HUSH_SELF_TEST)policy.open();
  mark('handing over to the self-test');
  if(process.env.HUSH_SELF_TEST)await require('../test/electron-check.cjs')({app,panel,notice,policy,store,action,bridge,snapshot,shutdown});
  if(process.env.HUSH_SHARED_CHECK)await require('../test/shared-check.cjs')({app,panel,store,action});
  if(process.env.HUSH_TASK_CHECK)await require('../test/task-check.cjs')({app,panel,store,action});
}
// The main process owns the providers, the bridge and the tray. Letting it die quietly
// on a stray rejection would take the user's inbox with it and tell them nothing, so
// record it, show it where they are already looking for errors, and stay up.
function survive(kind,value){
  const detail=value instanceof Error?value.stack||value.message:String(value);
  try{fs.appendFileSync(path.join(app.getPath('userData'),'errors.log'),
    `${new Date().toISOString()} ${kind} ${detail}
`);}catch{}
  try{if(panel&&!panel.isDestroyed())panel.webContents.send('trouble',
    (value&&value.message)||String(value));}catch{}
}
process.on('uncaughtException',e=>survive('uncaughtException',e));
process.on('unhandledRejection',e=>survive('unhandledRejection',e));
app.on('window-all-closed',()=>{});
// Everything Hush owns outside its own process: provider app-servers, the Cursor agent,
// the dictation helper, the bridge. app.exit() does not emit before-quit, so anything
// that leaves that way has to call this itself or the children outlive us.
function shutdown(){quitting=true;globalShortcut.unregisterAll();policy?.close();herdrConnection?.close();history?.close();cursor.close();dictation.stop();bridge?.close();if(metadataFile)persistMetadata();store.close();}
app.on('before-quit',shutdown);

