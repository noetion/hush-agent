const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
module.exports=async({app,panel,notice,policy,store,action,bridge,snapshot,shutdown})=>{
  const dir=process.env.HUSH_ARTIFACTS||path.resolve('artifacts');fs.mkdirSync(dir,{recursive:true});
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const report={};let backdrop;
  const step=text=>{try{fs.appendFileSync(path.join(dir,'startup.log'),`${new Date().toISOString()} check: ${text}
`);}catch{}};
  // The report is written when the run ends, so a run that is killed rather than
  // failing -- a CI step timeout, a crash -- leaves nothing at all to look at. Flush
  // what has been gathered as it goes, so even a killed run says how far it got.
  const save=()=>{try{fs.writeFileSync(path.join(dir,'electron-check.json'),JSON.stringify(report,null,2));}catch{}};
  const flushing=setInterval(save,1000);
  flushing.unref?.();
  // And bound the whole run from inside. A stage that never settles would otherwise
  // hang until something outside kills the process, which is exactly the case where the
  // report is the only way to find out where it stopped.
  const budget=Number(process.env.HUSH_SELF_TEST_BUDGET||480000);
  const deadline=setTimeout(()=>{
    report.error=`the self-test did not finish within ${Math.round(budget/1000)}s`;
    save();app.exit(1);
  },budget);
  deadline.unref?.();
  // Screenshots are evidence, not assertions: nothing below reads the PNGs back. A
  // headless runner may have no compositor to capture from, and losing every
  // behavioural check to a missing screenshot would be the wrong trade, so record that
  // it was unavailable and carry on.
  // Capturing can fail two ways depending on the platform: it throws where there is no
  // compositor, and it can simply never return where the window is not being composited
  // at all, which is a hang rather than an error. Both end up in the same place here.
  const capture=async(win,name)=>{
    try{
      const image=await Promise.race([win.webContents.capturePage(),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('capturePage never returned')),5000))]);
      fs.writeFileSync(path.join(dir,name),image.toPNG());
    }catch(e){(report.capturesUnavailable??=[]).push(`${name}: ${e.message}`);}
  };
  // Minimizing is instant on Windows and is not anywhere else: macOS runs its animation
  // and Linux waits on the window manager, so isMinimized() is still false the moment
  // hide() returns. Wait for the window's own event instead of guessing a duration, and
  // fail with something readable rather than hanging if it never arrives.
  const settles=(win,event,act,within=10000)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`the panel never emitted ${event}`)),within);
    win.once(event,()=>{clearTimeout(timer);resolve();});
    act();
  });
  async function glassCapture(name){
    if(!process.env.HUSH_GLASS_BACKGROUND)return;
    const {BrowserWindow,screen,desktopCapturer}=require('electron');const display=screen.getPrimaryDisplay();
    if(!backdrop){
      backdrop=new BrowserWindow({...display.bounds,frame:false,show:false,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      const background=fs.readFileSync(process.env.HUSH_GLASS_BACKGROUND).toString('base64');
      await backdrop.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<body style="margin:0;background:#222 url(data:image/jpeg;base64,${background}) center/cover no-repeat;height:100vh"></body>`));
      backdrop.setAlwaysOnTop(true,'floating');backdrop.showInactive();
    }
    const {x,y,width,height}=display.bounds;panel.setPosition(x+Math.round(width*.57),y+Math.round((height-panel.getBounds().height)/2));panel.show();
    await pause(2500);
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(width*display.scaleFactor),height:Math.round(height*display.scaleFactor)}});
    const source=sources.find(s=>s.display_id===String(display.id));if(!source)throw Error('Test display capture unavailable');
    fs.writeFileSync(path.join(dir,name+'-desktop.png'),source.thumbnail.toPNG());
    const b=panel.getBounds(),scale=source.thumbnail.getSize().width/width;
    fs.writeFileSync(path.join(dir,name+'-glass.png'),source.thumbnail.crop({x:Math.round((b.x-x-20)*scale),y:Math.round((b.y-y-20)*scale),width:Math.round((b.width+40)*scale),height:Math.round((b.height+40)*scale)}).toPNG());
    report.material=snapshot().material;
  }
  try{
    await action('settings',{fadeWhenIdle:false});
    // The channel server and the CLI run outside Electron and work this path out for
    // themselves. If the two ever disagree they look for the bridge file in different
    // places, and nothing says so until a real session fails to connect. Each platform
    // takes its own branch, so this only proves the one it runs on; CI runs all three.
    assert.equal(require('../src/app-data.cjs').appDataRoot(),app.getPath('appData'));report.appDataMatchesElectron=true;
    // Exercise the app's actual window and domain APIs; no synthetic OS input.
    policy.open();
    await settles(panel,'minimize',()=>policy.hide());assert.equal(panel.isMinimized(),true);
    await settles(panel,'restore',()=>policy.open());assert.equal(panel.isMinimized(),false);report.taskbarMinimizeRestore=true;
    // These three go back to back on purpose: the case is a blur arriving while a
    // restore is still in flight, which must not leave the panel hidden. Only the wait
    // afterwards is relaxed, because the restore itself takes as long as the platform
    // takes; the panel still has to end up open.
    panel.minimize();panel.restore();panel.emit('blur');
    await pause(300);
    for(let i=0;i<40&&!policy.isOpen();i++)await pause(50);
    assert.equal(policy.isOpen(),true);report.restoreBlurRace=true;
    await settles(panel,'minimize',()=>policy.hide());notice.hide();report.idle={panel:policy.isOpen(),notice:notice.isVisible()};assert.equal(policy.isOpen(),false);assert.equal(notice.isVisible(),false);
    policy.lastNotice=0;policy.attention();report.notification={visible:notice.isVisible(),focused:notice.isFocused(),focusable:notice.isFocusable(),panelVisible:policy.isOpen(),bounds:notice.getBounds()};assert.equal(notice.isVisible(),true);assert.equal(notice.isFocusable(),false);assert.equal(notice.isFocused(),false);assert.equal(policy.isOpen(),false);
    await pause(350);await capture(notice,'notification.png');
    policy.setQuiet(true);policy.lastNotice=0;policy.attention();assert.equal(notice.isVisible(),false);report.quiet=true;policy.setQuiet(false);
    await settles(panel,'restore',()=>policy.open());await pause(400);await capture(panel,'welcome.png');await glassCapture('welcome');
    await panel.webContents.executeJavaScript("document.getElementById('connections-tab').click()");await pause(300);await capture(panel,'new-conversation.png');
    await panel.webContents.executeJavaScript("document.getElementById('inbox-tab').click()");
    const s=store.add({provider:'Acceptance fixture',title:'Website accessibility',canReply:true},{reply:async text=>{assert.equal(text,'Please fix the keyboard navigation.');store.message(s.id,'agent','The reply reached the correct session.');store.update(s.id,{status:'done'});}});
    store.message(s.id,'agent','The audit is complete. Two navigation controls need keyboard support. Should I fix those now?');store.update(s.id,{status:'done'});await pause(400);await capture(panel,'inbox.png');await glassCapture('inbox');
    await action('reply',{id:s.id,text:'Please fix the keyboard navigation.'});assert.equal(s.messages.at(-2).role,'you');report.reply=true;
    store.update(s.id,{status:'waiting',request:{id:'approval-test',kind:'approval',title:'Allow updating navigation.ts?',detail:'Edit the keyboard handlers in navigation.ts. Applies to this request only.'}});store.actions.get(s.id).answer=async(id,value)=>{assert.equal(id,'approval-test');assert.equal(value,'decline');};await pause(300);await capture(panel,'approval.png');await action('answer',{id:s.id,requestId:'approval-test',value:'decline'});report.approval=true;
    report.snapshot={shortcutOk:snapshot().shortcutOk,bridgeActive:fs.existsSync(bridge.filename)};
    const modifier=process.platform==='darwin'?'Command':'Ctrl';
    report.shortcuts=await panel.webContents.executeJavaScript("({labels:[...document.querySelectorAll('[data-shortcut-modifier]')].map(n=>n.textContent),send:document.getElementById('send').title})");
    assert.ok(report.shortcuts.labels.length>=2);
    assert.ok(report.shortcuts.labels.every(label=>label===modifier));
    assert.ok(report.shortcuts.send.includes(modifier+'+Enter'));
    if(backdrop){
      await panel.webContents.executeJavaScript("document.getElementById('connections-tab').click()");await glassCapture('connections');
      await panel.webContents.executeJavaScript("document.getElementById('settings-tab').click()");await glassCapture('preferences');
      await panel.webContents.executeJavaScript("document.getElementById('inbox-tab').click()");
      await backdrop.webContents.executeJavaScript("document.body.style.background='#fafafa'");await glassCapture('bright');
      await backdrop.webContents.executeJavaScript("document.body.style.background='#05070b'");await glassCapture('dark');
    }
    // Read-only renderer verification of layout and controls.
    report.layout=await panel.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('button')].filter(b=>!b.hidden).length})`);
    assert.equal(report.layout.overflow,false);
    const {dialog}=require('electron');const originals={show:dialog.showMessageBox,relaunch:app.relaunch,quit:app.quit};
    try{let prompts=0,restarted=false,quit=false;dialog.showMessageBox=async()=>{prompts++;return {response:1};};app.relaunch=options=>{assert.equal(options.execPath,process.execPath);restarted=true;};app.quit=()=>{quit=true;};
      app.emit('second-instance',{},[],process.cwd(),{version:app.getVersion(),exe:process.execPath});await pause(20);assert.equal(prompts,0);
      app.emit('second-instance',{},[],process.cwd(),{version:'99.0.0',exe:process.execPath});await pause(20);assert.equal(prompts,1);assert.equal(restarted,true);assert.equal(quit,true);report.versionHandoff=true;
    }finally{dialog.showMessageBox=originals.show;app.relaunch=originals.relaunch;app.quit=originals.quit;}
    await action('settings',{hideOnBlur:false});policy.open();
    store.update(s.id,{external:true,historyProvider:'codex',resumeBlocked:true,canOpen:true});await pause(100);
    const ownership=await panel.webContents.executeJavaScript("({disabled:document.getElementById('continue-task').disabled,text:document.getElementById('external-controls').textContent,meta:document.getElementById('session-meta').textContent})");assert.equal(ownership.disabled,true);
    // The wording now names whichever app owns the conversation and says why a reply is
    // refused rather than merely queued, so assert that meaning rather than the old text.
    assert.match(ownership.text,/Codex still owns this conversation/);assert.match(ownership.text,/without ever reaching it/);
    assert.match(ownership.meta,/Open in Codex/);report.ownershipConflict=true;
    store.update(s.id,{external:false,shared:false,images:true,status:'idle',request:null,requests:[],models:[{id:'test-model',name:'Test model'}]});for(let i=0;i<15;i++)store.message(s.id,'agent','Long conversation message '+i+' '+('content '.repeat(25)));
    await panel.webContents.executeJavaScript("document.getElementById('connections-tab').click();document.getElementById('inbox-tab').click()");await pause(100);
    let scroll=await panel.webContents.executeJavaScript("(()=>{const m=document.getElementById('messages');return {top:m.scrollTop,height:m.scrollHeight,client:m.clientHeight}})()");assert.ok(scroll.top+scroll.client>=scroll.height-3);report.openAtEnd=true;
    await panel.webContents.executeJavaScript("document.getElementById('messages').scrollTop=0");store.update(s.id,{});await pause(100);assert.equal(await panel.webContents.executeJavaScript("document.getElementById('messages').scrollTop"),0);report.preserveReadingPosition=true;
    await panel.webContents.executeJavaScript("document.getElementById('model').value='test-model';document.getElementById('model').dispatchEvent(new Event('change'))");await pause(100);assert.equal(s.selectedModel,'test-model');await panel.webContents.executeJavaScript("document.getElementById('model').value='';document.getElementById('model').dispatchEvent(new Event('change'))");await pause(100);assert.equal(s.selectedModel,'');report.modelSelection=true;
    await capture(panel,'composer.png');
    // Compact reply: answering a cue must shrink the real window, keep the composer
    // on screen, and restore the full application when the user asks for it.
    await panel.webContents.executeJavaScript('setCompact(true)');await pause(400);
    report.compact=await panel.webContents.executeJavaScript("(()=>{const send=document.getElementById('send').getBoundingClientRect();return {height:innerHeight,navShown:getComputedStyle(document.querySelector('nav')).display!=='none',footerShown:getComputedStyle(document.querySelector('footer')).display!=='none',expandShown:getComputedStyle(document.getElementById('expand')).display!=='none',sendVisible:send.bottom<=innerHeight&&send.top>=0,messageRoom:Math.round(document.getElementById('messages').clientHeight),lastMessageHeight:(()=>{const m=document.querySelectorAll('#messages .message');const last=m[m.length-1];return last?Math.round(last.getBoundingClientRect().height):null;})(),lastMessageEndVisible:(()=>{const m=document.querySelectorAll('#messages .message');const last=m[m.length-1];if(!last)return null;const box=document.getElementById('messages').getBoundingClientRect();return last.getBoundingClientRect().bottom<=box.bottom+1;})(),overflow:document.documentElement.scrollWidth>innerWidth};})()");
    assert.ok(Math.abs(panel.getContentBounds().height-320)<=2,'compact height should be about 320, allowing for display scaling');assert.equal(report.compact.navShown,false);assert.equal(report.compact.footerShown,false);
    assert.equal(report.compact.expandShown,true);assert.equal(report.compact.sendVisible,true);assert.equal(report.compact.overflow,false);assert.equal(report.compact.lastMessageEndVisible,true);
    await capture(panel,'compact.png');
    await panel.webContents.executeJavaScript('setCompact(false)');await pause(400);
    report.compactRestored=panel.getContentBounds().height;assert.ok(Math.abs(report.compactRestored-500)<=2,'restoring should return to about 500');
    // A parked panel must survive the repositioning that every open performs.
    const parked=[panel.getBounds().x-140,panel.getBounds().y+90];panel.setPosition(parked[0],parked[1]);await pause(600);
    policy.hide();await pause(120);await action('open');await pause(200);
    report.parked={want:parked,got:[panel.getBounds().x,panel.getBounds().y],stored:snapshot().settings.panelPosition??null};
    assert.deepEqual(report.parked.got,report.parked.want);
    await panel.webContents.executeJavaScript("window.auditUpdates=0;window.hush.subscribe(()=>window.auditUpdates++);window.auditMessage=document.getElementById('messages').firstElementChild;document.getElementById('messages').scrollTop=120;");
    for(let i=0;i<100;i++)store.update(s.id,{});await pause(150);
    report.renderAudit=await panel.webContents.executeJavaScript("({updates:window.auditUpdates,nodeRetained:window.auditMessage===document.getElementById('messages').firstElementChild,scroll:document.getElementById('messages').scrollTop,readableHeight:document.getElementById('messages').clientHeight})");assert.ok(report.renderAudit.updates<=3);assert.equal(report.renderAudit.nodeRetained,true);assert.equal(report.renderAudit.scroll,120);
    await notice.webContents.executeJavaScript("window.hush.subscribe(s=>window.auditNoticeKeys=Object.keys(s));void 0");store.update(s.id,{});await pause(100);report.noticeKeys=await notice.webContents.executeJavaScript("window.auditNoticeKeys");assert.deepEqual(report.noticeKeys.sort(),['material','unread']);
    policy.hide();await pause(100);await panel.webContents.executeJavaScript("window.auditUpdates=0");for(let i=0;i<100;i++)store.update(s.id,{});await pause(100);report.hiddenUpdates=await panel.webContents.executeJavaScript("window.auditUpdates");assert.equal(report.hiddenUpdates,0);policy.open();await pause(100);
    await panel.webContents.executeJavaScript("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
    await capture(panel,'composer.png');
    store.actions.get(s.id).reply=async()=>{store.update(s.id,{sourceId:'assigned-after-first-message'});store.enqueueRequest(s.id,{id:'acceptance-permission',kind:'approval',title:'Allow this next step?'});};
    await panel.webContents.executeJavaScript("document.getElementById('reply').value='draft-migration-fixture';document.getElementById('reply').dispatchEvent(new Event('input'));document.getElementById('reply-form').requestSubmit();");await pause(200);
    report.permissionAfterSend=await panel.webContents.executeJavaScript("({draft:document.getElementById('reply').value,requestVisible:!document.getElementById('request').hidden,stored:localStorage.getItem('drafts')})");assert.equal(policy.isOpen(),true);assert.equal(report.permissionAfterSend.draft,'');assert.equal(report.permissionAfterSend.requestVisible,true);assert.equal(report.permissionAfterSend.stored.includes('draft-migration-fixture'),false);
    // The cue passes clicks through to whatever is underneath while its own controls
    // still work. OS-level passthrough needs a real pointer and is not asserted here;
    // this covers the plumbing and that the cue stays usable as an entry point.
    await action('notice-interactive',{on:true});await action('notice-interactive',{on:false});
    policy.hide();await pause(150);policy.lastNotice=0;policy.attention();await pause(300);
    report.cue={visible:notice.isVisible(),focused:notice.isFocused(),focusable:notice.isFocusable()};
    assert.equal(report.cue.visible,true);assert.equal(report.cue.focused,false);assert.equal(report.cue.focusable,false);
    await notice.webContents.executeJavaScript("document.getElementById('open').click()");await pause(300);
    report.cueOpensPanel=policy.isOpen();assert.equal(report.cueOpensPanel,true);
    // Collapse: the panel rolls up to its own top bar, returning the space it was
    // occupying rather than merely going see-through, and still reports status.
    await action('settings',{fadeWhenIdle:true});await pause(80);
    await panel.webContents.executeJavaScript('setCollapsed(true)');await pause(400);
    report.collapsedImmediate=panel.getContentBounds().height;
    report.collapsed=await panel.webContents.executeJavaScript("({height:innerHeight,"+
      "navShown:getComputedStyle(document.querySelector('nav')).display!=='none',"+
      "mainShown:getComputedStyle(document.getElementById('inbox')).display!=='none',"+
      "statusShown:getComputedStyle(document.getElementById('bar-status')).display!=='none',"+
      "statusText:document.getElementById('bar-status').textContent})");
    report.collapsed.windowHeight=panel.getContentBounds().height;
    assert.ok(Math.abs(report.collapsed.windowHeight-46)<=2,'collapsed height should be about 46, allowing for display scaling');assert.equal(report.collapsed.navShown,false);
    assert.equal(report.collapsed.mainShown,false);assert.equal(report.collapsed.statusShown,true);
    // Rolled up, this one line is everything Hush is showing, so it has to carry state
    // rather than a pleasantry. A fixture session exists by now, so it should be counted.
    assert.match(report.collapsed.statusText,/\d|Quiet/,
      `the collapsed bar must report state, got ${JSON.stringify(report.collapsed.statusText)}`);
    await capture(panel,'collapsed.png');
    await panel.webContents.executeJavaScript('setCollapsed(false)');await pause(400);
    report.collapsedRestored=panel.getContentBounds().height;assert.ok(Math.abs(report.collapsedRestored-500)<=2,'restoring should return to about 500');
    // The pointer checks live further down, where the panel is placed on the far side of
    // the display to guarantee it is clear of the cursor and stretched over the display
    // to guarantee it is underneath. Positioning relative to the cursor, as this block
    // used to, passed or failed on where the tester's mouse happened to be.
    // Fade while idle: the panel becomes ambient, then fully present again on any
    // attention. It must never fade while a reply is in progress or a decision waits.
    policy.open();await pause(200);await panel.webContents.executeJavaScript('wake()');await pause(120);
    // These resolve when the animation actually lands, so there is no duration to guess
    // and nothing to poll. Waiting a fixed time and sampling mid-fade is what made this
    // fail on a loaded runner at 0.696 while the behaviour was correct.
    const opacityAfter=async expression=>{
      await panel.webContents.executeJavaScript(expression);
      return +panel.getOpacity().toFixed(2);
    };
    report.fade={awake:panel.getOpacity()};
    report.fade.dimmed=await opacityAfter('setFaded(true)');
    // Collapsed leaves one line of status and nothing to act on, so it has to get
    // further out of the way than a faded panel that still shows the conversation.
    report.fade.collapsedDim=await opacityAfter('setCollapsed(true)');
    report.fade.restored=await opacityAfter('wake()');
    assert.equal(report.fade.awake,1);assert.ok(report.fade.dimmed<0.6,'panel did not dim');assert.equal(report.fade.restored,1);
    assert.ok(report.fade.collapsedDim<report.fade.dimmed-0.1,
      `collapsing should sink further than fading, got ${report.fade.collapsedDim} against ${report.fade.dimmed}`);
    // A waiting decision is a real hold, and one is queued by this point.
    report.fade.requestBlocks=await panel.webContents.executeJavaScript('holdAwake()');
    assert.equal(report.fade.requestBlocks,true,'a pending decision must hold the panel awake');
    store.update(s.id,{request:null,requests:[]});await pause(200);
    // A draft buys thinking room rather than blocking receding outright. Blocking was
    // wrong: once anything had been typed, Hush could never get out of the way again.
    await panel.webContents.executeJavaScript("document.getElementById('reply').value='half written'");
    report.fade.draftBlocks=await panel.webContents.executeJavaScript('holdAwake()');
    report.fade.draftExtends=await panel.webContents.executeJavaScript('composing()');
    assert.equal(report.fade.draftBlocks,false,'a draft must not block receding forever');
    assert.equal(report.fade.draftExtends,true,'a draft must still extend the delay');
    await panel.webContents.executeJavaScript("document.getElementById('reply').value='';document.getElementById('reply').blur()");
    report.fade.idleBlocks=await panel.webContents.executeJavaScript('holdAwake()');
    assert.equal(report.fade.idleBlocks,false,'nothing should hold an idle panel awake');
    // Turning the preference off disables it outright.
    await action('settings',{fadeWhenIdle:false});await pause(100);
    await panel.webContents.executeJavaScript('setFaded(false);setFaded(true)');await pause(400);
    report.fade.withPreferenceOff=+panel.getOpacity().toFixed(2);assert.equal(report.fade.withPreferenceOff,1);
    await action('settings',{fadeWhenIdle:true});await panel.webContents.executeJavaScript('wake()');await pause(200);
    // Two claims about the pointer, both made independent of where the mouse
    // physically is: the panel is placed on the opposite side of the display from the
    // cursor to guarantee it is clear, and then placed under the cursor to guarantee it
    // is not. Placing it on the cursor rather than stretching it over the whole display
    // is both the smaller move and the more reliable one, since a window manager may
    // refuse to put a window over a menu bar but will happily put one where it fits.
    {const {screen}=require('electron');
     await action('settings',{fadeWhenIdle:true});
     const was=panel.getBounds();const cursor=screen.getCursorScreenPoint();
     const area=screen.getDisplayNearestPoint(cursor).bounds;
     const clear={x:cursor.x>area.x+area.width/2?area.x+8:area.x+area.width-was.width-8,
                  y:cursor.y>area.y+area.height/2?area.y+8:area.y+area.height-was.height-8};
     const settle=async()=>{await panel.webContents.executeJavaScript("document.getElementById('reply').value='';document.getElementById('reply').blur();"+
       "lastInput=Date.now();wake()");await pause(2600);};

     // Clear of the cursor: it must recede on its own.
     panel.setPosition(clear.x,clear.y);await pause(250);
     report.dwell={cursorClear:!(await action('pointer-over-panel'))};
     await settle();
     report.dwell.fadedFirst=await panel.webContents.executeJavaScript('faded');
     // A sweep while the cursor is elsewhere must not bring it back.
     await panel.webContents.executeJavaScript("dispatchEvent(new MouseEvent('mousemove'))");
     await pause(700);
     report.dwell.stillFadedAfterSweep=await panel.webContents.executeJavaScript('faded');

     // Under the cursor: the same sweep is a dwell and must wake it. Ask for a window
     // centred on the pointer, then read back where it actually landed: if the platform
     // put it somewhere else, these two claims cannot be made here and say so rather
     // than failing as though the behaviour were wrong.
     // Read the pointer again rather than reusing the one from the top of this block:
     // several seconds of waiting have passed since then and a hand may have moved.
     // Placing has to be the last thing that touches the window. Changing the panel's
     // size goes through panel-size, which re-parks it at its remembered corner, so a
     // collapse or a wake in the middle of this would quietly move it off the pointer
     // and these measurements would be of nothing. Wake first to restart the fade and
     // collapse timers, then place, then measure inside that window.
     const place=async()=>{
       await panel.webContents.executeJavaScript('lastInput=Date.now();wake()');
       await pause(150);
       const here=screen.getCursorScreenPoint();
       const at={width:was.width,height:was.height,
         x:Math.min(Math.max(here.x-Math.round(was.width/2),area.x),area.x+area.width-was.width),
         y:Math.min(Math.max(here.y-Math.round(was.height/2),area.y),area.y+area.height-was.height)};
       panel.setResizable(true);panel.setBounds(at);panel.setResizable(false);
       await pause(250);
       return {at,here};
     };
     // The dwell claim needs the panel faded, which the sweep above already achieved,
     // so place without waking here and let the dwell do the waking.
     const here=screen.getCursorScreenPoint();
     const on={width:was.width,height:was.height,
       x:Math.min(Math.max(here.x-Math.round(was.width/2),area.x),area.x+area.width-was.width),
       y:Math.min(Math.max(here.y-Math.round(was.height/2),area.y),area.y+area.height-was.height)};
     panel.setResizable(true);panel.setBounds(on);panel.setResizable(false);await pause(250);
     report.parkedCursor={cursorInside:await action('pointer-over-panel')};
     if(!report.parkedCursor.cursorInside)
       report.parkedCursor.placement={wanted:on,got:panel.getBounds(),whenPlaced:here,now:screen.getCursorScreenPoint()};
     await panel.webContents.executeJavaScript("dispatchEvent(new MouseEvent('mousemove'))");
     await pause(700);
     report.dwell.wokeOnDwell=!(await panel.webContents.executeJavaScript('faded'));

     // Hovering holds it awake while you are active, and stops once you are idle.
     // Evaluated as the rule rather than by waiting: the panel now covers the display,
     // so a real mouse twitch resets lastInput before any timer fires and the earlier
     // timing version passed or failed on whether the tester's hand moved.
     const placed=await place();
     report.parkedCursor.placedForRule=await action('pointer-over-panel');
     if(!report.parkedCursor.placedForRule)report.parkedCursor.rulePlacement={wanted:placed.at,got:panel.getBounds(),now:screen.getCursorScreenPoint()};
     const wouldRecede=async ageMs=>panel.webContents.executeJavaScript(
       `(async()=>{const over=await call('pointer-over-panel');`+
       `const parked=${ageMs}>HOVER_GRACE;`+
       `return {over,parked,recedes:!holdAwake()&&!(over&&!parked)};})()`);
     report.parkedCursor.active=await wouldRecede(0);
     report.parkedCursor.idle=await wouldRecede(60000);
     report.parkedCursor.heldWhileActive=!report.parkedCursor.active.recedes;
     report.parkedCursor.recedesWhenIdle=report.parkedCursor.idle.recedes;
     panel.setResizable(true);panel.setBounds(was);panel.setResizable(false);await pause(250);
     await panel.webContents.executeJavaScript('lastInput=Date.now();wake()');}
    assert.equal(report.dwell.cursorClear,true,'the panel must be clear of the cursor for this check');
    assert.equal(report.dwell.fadedFirst,true,'a panel clear of the cursor must recede on its own');
    assert.equal(report.dwell.stillFadedAfterSweep,true,'passing over a receded panel must not wake it');
    if(report.parkedCursor.cursorInside&&report.parkedCursor.placedForRule){
      assert.equal(report.dwell.wokeOnDwell,true,'resting on a receded panel must wake it');
      assert.equal(report.parkedCursor.heldWhileActive,true,'a hovered panel must stay awake while you are active');
      assert.equal(report.parkedCursor.recedesWhenIdle,true,'a parked cursor must stop holding it awake once idle');
    }else{
      // Nothing about hovering can be claimed if the platform would not put the window
      // under the pointer. Recorded, not quietly passed.
      report.parkedCursor.unclaimed='the platform would not place the panel under the pointer';
    }
    // Nothing was catching what fell through, so a rejected call or a throw in a handler
    // left the interface looking as though the click had done nothing. Prove both the
    // renderer's own net and the one the main process reaches it through.
    await panel.webContents.executeJavaScript(
      "(()=>{document.getElementById('error').hidden=true;"
      + "Promise.reject(Error('HUSH_STRAY_REJECTION'));return 'left unhandled on purpose';})()");
    await pause(250);
    report.strayRejectionShown=await panel.webContents.executeJavaScript(
      "({shown:!document.getElementById('error').hidden,text:document.getElementById('error').textContent})");
    assert.equal(report.strayRejectionShown.shown,true,'a stray rejection must reach the user');
    assert.match(report.strayRejectionShown.text,/HUSH_STRAY_REJECTION/);

    await panel.webContents.executeJavaScript("document.getElementById('error').hidden=true");
    panel.webContents.send('trouble','HUSH_MAIN_TROUBLE');
    await pause(250);
    report.mainTroubleShown=await panel.webContents.executeJavaScript(
      "({shown:!document.getElementById('error').hidden,text:document.getElementById('error').textContent})");
    assert.equal(report.mainTroubleShown.shown,true,'trouble in the main process must reach the user');
    assert.match(report.mainTroubleShown.text,/HUSH_MAIN_TROUBLE/);
    await panel.webContents.executeJavaScript("document.getElementById('error').hidden=true");

    // Transparent theme: the panel background drops away so only its text sits over
    // whatever is behind it, and the choice survives a restart of the renderer.
    {const alpha=async()=>panel.webContents.executeJavaScript(
       "getComputedStyle(document.body).backgroundColor");
     await action('settings',{transparent:false});await pause(150);
     report.transparent={off:await alpha()};
     await action('settings',{transparent:true});await pause(200);
     report.transparent.on=await alpha();
     report.transparent.flag=await panel.webContents.executeJavaScript(
       'document.documentElement.dataset.transparent');
     await capture(panel,'transparent.png');
     await action('settings',{transparent:false});await pause(150);}
    const opacityOf=value=>{const m=/rgba?\(([^)]+)\)/.exec(value);if(!m)return 1;
      const parts=m[1].split(',');return parts.length>3?parseFloat(parts[3]):1;};
    assert.equal(report.transparent.flag,'on','the transparent flag should be set');
    assert.ok(opacityOf(report.transparent.on)<opacityOf(report.transparent.off),
      `transparent should be less opaque: ${report.transparent.on} vs ${report.transparent.off}`);
    assert.ok(opacityOf(report.transparent.on)<0.4,'transparent should be substantially see-through');
    // Replying to a Claude conversation another window is running. Guarded by an env
    // var because it sends a real message into a real session; without it the check is
    // skipped rather than silently passing.
    if(process.env.HUSH_LIVE_CLAUDE_SESSION){
      const sourceId=process.env.HUSH_LIVE_CLAUDE_SESSION;
      const preview=await action('preview-task',{provider:'claude',sourceId});
      const owned=store.get(preview.id);
      report.ownedReply={canReply:owned.canReply,external:owned.external};
      assert.equal(report.ownedReply.canReply,true,'an owned Claude conversation should be repliable');
      await panel.webContents.executeJavaScript(`select(${JSON.stringify(preview.id)})`);await pause(250);
      report.ownedReply.composerShown=await panel.webContents.executeJavaScript(
        "!document.getElementById('reply-form').hidden");
      assert.equal(report.ownedReply.composerShown,true,'the composer should be shown for a writable owned conversation');
      await action('reply',{id:preview.id,text:'HUSH_OWNED_REPLY_OK — sent from Hush to a session another window is running'});
      report.ownedReply.sent=true;
      // The way out of peer framing is a bridged session, so it has to be offered
      // where the limitation is met rather than only described there.
      report.ownedReply.bridgeOffered=await panel.webContents.executeJavaScript(
        "!document.getElementById('bridge-session').hidden");
      assert.equal(report.ownedReply.bridgeOffered,true,'a bridged session should be offered here');
    } else report.ownedReply='skipped (set HUSH_LIVE_CLAUDE_SESSION)';
    report.passed=true;
  }catch(e){report.error=e.stack;process.exitCode=1;}finally{clearInterval(flushing);clearTimeout(deadline);backdrop?.destroy();save();// app.exit skips before-quit, so the app's children would outlive it and keep the
  // parent shell's stdout open, which reads as a hang rather than a failure.
  try{shutdown?.();step('shutdown returned');}catch(e){report.shutdownError=String(e&&e.message||e);save();}step('calling app.exit');app.exit(report.passed?0:1);}
};
