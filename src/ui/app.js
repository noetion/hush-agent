const $=id=>document.getElementById(id);let state={sessions:[],saved:[],settings:{}},selected=null,tab='tasks';let drafts={};try{drafts=JSON.parse(localStorage.getItem('drafts')||'{}');}catch{}let requestRendered='',scrollConversation=null,listening=false,sessionSignature='',attachmentSignature='',panelWasVisible=false,compact=false,faded=false,collapsed=false,pointerInside=false,fadeTimer,collapseTimer,dwellTimer,lastWake=0,lastInput=Date.now();const sessionOrder=[];let messageNodes=new Map();
const modifier=window.hush.platform==='darwin'?'Command':'Ctrl';
for(const key of document.querySelectorAll('[data-shortcut-modifier]'))key.textContent=modifier;
$('send').title=`Send & hide - ${modifier}+Enter`;
async function call(name,data){const r=await window.hush.call(name,data);if(!r.ok)throw Error(r.error);return r.value;}
function error(e){$('error').textContent=e.message||String(e);$('error').hidden=false;}
// Nothing was catching what fell through. A rejected call or a throw inside an event
// handler left the interface looking as though the click had simply done nothing, which
// is the worst way for an app that lives in the corner of a screen to fail.
addEventListener('unhandledrejection',event=>{error(event.reason||Error('Something went wrong.'));event.preventDefault();});
addEventListener('error',event=>{if(event.error||event.message)error(event.error||Error(event.message));});
window.hush.onTrouble?.(message=>error(Error(message)));

function clearError(){$('error').hidden=true;}
function draftKey(id){const s=state.sessions.find(s=>s.id===id);return s?.sourceId?s.provider+':'+s.sourceId:id;}
function saveDraft(){if(selected){drafts[draftKey(selected)]=$('reply').value;localStorage.setItem('drafts',JSON.stringify(drafts));}}
function showTab(name){saveDraft();tab=name;for(const [id,page]of[['tasks','tasks'],['inbox','inbox'],['connections','connections'],['settings','preferences']]){$(page).hidden=id!==name;$(id+'-tab').classList.toggle('active',id===name);if(id===name)$(id+'-tab').setAttribute('aria-current','page');else $(id+'-tab').removeAttribute('aria-current');}clearError();if(name==='inbox')requestAnimationFrame(()=>{const messages=$('messages');messages.scrollTop=messages.scrollHeight;});}
// Recede in two stages once you stop using Hush, and come back on any real attention.
// Hovering counts as using it, so reading does not get interrupted. Never while you
// are dictating or have a decision waiting. Drafts extend the idle delay.
const FADE_AFTER=1800,COLLAPSE_AFTER=5000,FADE_COMPOSING=4000,COLLAPSE_COMPOSING=12000,DWELL_TO_WAKE=350,HOVER_GRACE=12000;
function composing(){return document.activeElement===$('reply')||!!$('reply').value.trim();}
// The collapsed bar is one line of text and nothing else, so that line is the whole of
// what Hush shows while it is out of the way. It used to read "Ready when you are",
// which is a pleasant way of saying nothing. Say what is actually happening instead, in
// the order that matters: something needs you, something is running, or nothing is.
function statusLine(unread){
  if(state.settings.quiet)return 'Quiet · popups paused';
  if(unread)return `${unread} ${unread===1?'agent needs':'agents need'} you`;
  const working=state.sessions.filter(s=>s.status==='working').length;
  if(working)return working===1?'1 agent working':`${working} agents working`;
  const live=state.sessions.length;
  if(live)return live===1?'1 agent connected':`${live} agents connected`;
  return 'No agents connected';
}
function holdAwake(){const s=state.sessions.find(x=>x.id===selected);return listening||!!s?.request;}
// The depth follows the stage: collapsed leaves one line of status, so it can sink
// further than a faded panel that still shows the conversation.
function dimDepth(){return collapsed?'collapsed':'faded';}
function setFaded(on){if(faded===on)return Promise.resolve();faded=on;return call('panel-dim',{on,depth:dimDepth()}).catch(error);}
function setCollapsed(on){if(collapsed===on)return Promise.resolve();collapsed=on;document.body.classList.toggle('collapsed',on);const settled=Promise.all([call('panel-size',{mode:on?'collapsed':(compact?'compact':'full')}).catch(error),on&&faded?call('panel-dim',{on:true,depth:'collapsed'}).catch(error):null]);if(!on)requestAnimationFrame(()=>{const messages=$('messages');messages.scrollTop=messages.scrollHeight;});return settled;}
const trace=(event,detail)=>{call('recede-log',{event,detail}).catch(()=>{});};
function recede(){clearTimeout(fadeTimer);clearTimeout(collapseTimer);if(state.panelVisible===false||state.settings.fadeWhenIdle===false){trace('skip',{panelVisible:state.panelVisible,fadeWhenIdle:state.settings.fadeWhenIdle});return;}const drafting=composing();trace('armed',{drafting,faded,collapsed});fadeTimer=setTimeout(async()=>{const hold=holdAwake(),over=await call('pointer-over-panel');const parked=Date.now()-lastInput>HOVER_GRACE;trace('fade-tick',{hold,over,parked});if(hold||(over&&!parked))return recede();setFaded(true);},drafting?FADE_COMPOSING:FADE_AFTER);collapseTimer=setTimeout(async()=>{const hold=holdAwake(),over=await call('pointer-over-panel');const parked=Date.now()-lastInput>HOVER_GRACE;trace('collapse-tick',{hold,over,parked});if(hold||(over&&!parked))return recede();$('reply').blur();setCollapsed(true);},drafting?COLLAPSE_COMPOSING:COLLAPSE_AFTER);}
function wake(){clearTimeout(dwellTimer);dwellTimer=null;const settled=Promise.all([setCollapsed(false),setFaded(false)]);const now=Date.now();if(now-lastWake>=200){lastWake=now;recede();}return settled;}
addEventListener('mousemove',()=>{pointerInside=true;lastInput=Date.now();if(!faded&&!collapsed){wake();return;}if(dwellTimer)return;dwellTimer=setTimeout(async()=>{dwellTimer=null;if(await call('pointer-over-panel')){trace('dwell-wake',{});wake();}},DWELL_TO_WAKE);},{passive:true});
document.addEventListener('mouseleave',()=>{pointerInside=false;recede();});
addEventListener('blur',()=>{pointerInside=false;recede();});
for(const kind of['mousedown','keydown','wheel','focusin'])addEventListener(kind,()=>{lastInput=Date.now();wake();},{passive:true});
function setCompact(on){if(compact===on)return;compact=on;document.body.classList.toggle('compact',on);call('panel-size',{mode:on?'compact':'full'}).catch(error);requestAnimationFrame(()=>{const messages=$('messages');messages.scrollTop=messages.scrollHeight;});}
const ownerName=s=>({codex:'Codex',claude:'Claude Code',cursor:'Cursor'})[s.historyProvider]||s.provider||'the original app';
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function render(next){let migrated=false;for(const item of next.sessions){const key=item.sourceId?item.provider+':'+item.sourceId:item.id;if(key!==item.id&&Object.hasOwn(drafts,item.id)){drafts[key]=drafts[item.id];delete drafts[item.id];migrated=true;}}if(migrated)localStorage.setItem('drafts',JSON.stringify(drafts));state=next;if(!state.sessions.some(s=>s.id===selected))selected=state.sessions[0]?.id||null;document.querySelector('.brand')?.setAttribute('title','Hush '+state.version);document.documentElement.dataset.material=state.material||'solid';$('dictate').hidden=false;$('dictate').classList.toggle('unavailable',!state.dictation);$('dictate').title=state.dictation?'Dictate a reply':(state.dictationReason||'Dictation is unavailable on this machine.');const unread=state.sessions.filter(s=>s.unread).length;$('count').textContent=unread||'';$('quiet').setAttribute('aria-pressed',String(state.settings.quiet));const status=statusLine(unread);$('footer-status').textContent=status;$('bar-status').textContent=status;$('corner').value=state.settings.corner;$('blur').checked=state.settings.hideOnBlur;$('fade').checked=state.settings.fadeWhenIdle!==false;$('transparent').checked=state.settings.transparent===true;document.documentElement.dataset.transparent=state.settings.transparent?'on':'off';$('bridge-path').textContent=state.bridgePath;$('shortcut-state').textContent=state.shortcutOk?'Toggle Hush from anywhere.': 'Shortcut unavailable, possibly used by another app. Open Hush from the tray.';
  const list=$('sessions');for(const item of state.sessions)if(!sessionOrder.includes(item.id))sessionOrder.push(item.id);const ordered=state.sessions.slice().sort((a,b)=>sessionOrder.indexOf(a.id)-sessionOrder.indexOf(b.id));const signature=JSON.stringify(ordered.map(s=>[s.id,s.title,s.provider,s.status,s.shared,s.external,s.resumeBlocked,s.unread,s.id===selected]));if(signature!==sessionSignature){sessionSignature=signature;list.replaceChildren();for(const s of ordered){const b=el('button','session'+(s.id===selected?' selected':''));b.setAttribute('aria-pressed',String(s.id===selected));b.append(el('span','dot '+s.status));const copy=el('span','session-copy');copy.append(el('strong','',s.title),el('small','',`${s.provider} · ${s.shared?'Shared with Codex':s.external?(s.resumeBlocked?`Open in ${ownerName(s)}`:'Saved history'):s.status}`));b.append(copy);if(s.unread)b.append(el('span','unread','New'));b.onclick=()=>{select(s.id);render(state);};list.append(b);}}
  $('empty').hidden=state.sessions.length>0;$('sessions').hidden=state.sessions.length<2;
  if(!selected&&state.sessions.length)selected=state.sessions[0].id;
  if(selected&&!state.sessions.some(s=>s.id===selected))selected=state.sessions[0]?.id||null;
  if(next.panelVisible&&!panelWasVisible){const waiting=state.sessions.find(s=>s.unread);if(waiting){if(selected!==waiting.id)select(waiting.id);showTab('inbox');setCompact(true);}else setCompact(false);}
  if(next.panelVisible&&!panelWasVisible)wake();
  if(!next.panelVisible&&panelWasVisible){clearTimeout(fadeTimer);clearTimeout(collapseTimer);setCollapsed(false);setFaded(false);}
  panelWasVisible=!!next.panelVisible;
  renderConversation();
  if(state.panelVisible&&tab==='inbox'&&state.sessions.find(s=>s.id===selected)?.unread)call('seen',{id:selected}).catch(error);
  $('saved').replaceChildren();
}
function select(id){if(listening)call('stop-dictation').catch(error);saveDraft();selected=id;requestRendered='';scrollConversation=null;$('reply').value=drafts[draftKey(id)]||'';renderConversation();const chosen=state.sessions.find(s=>s.id===id);if(chosen&&!chosen.shared&&!chosen.models)call('models',{id}).catch(error);call('seen',{id}).catch(error);}
function renderConversation(){const s=state.sessions.find(x=>x.id===selected);$('conversation').hidden=!s;if(!s)return;$('session-title').textContent=s.title;$('session-meta').textContent=`${s.provider} · ${s.shared?'Shared with Codex':s.external?(s.resumeBlocked?`Open in ${ownerName(s)}`:'Saved history'):s.status}`;$('source').disabled=!s.canOpen||(!s.external&&(s.status==='working'||!!s.request));$('source').textContent=s.external&&s.historyProvider?`Open in ${ownerName(s)}`:'Open terminal';$('disconnect').disabled=!!(s.sending||s.queuePending||s.status==='working'||s.request);$('about-version').textContent='Hush '+state.version;$('external-controls').hidden=!s.external||!!s.shared;$('reply-form').hidden=!!s.external&&!s.shared&&!(s.historyProvider==='claude'&&s.canReply);$('continue-task').hidden=!!s.shared;$('bridge-session').hidden=!(s.historyProvider==='claude'&&s.external&&s.canReply);$('continue-task').disabled=s.status==='working'||!!s.resumeBlocked;$('continue-task').textContent=s.resumeBlocked?`Open in ${ownerName(s)}`:'Connect to reply';$('external-controls').querySelector('p').textContent=s.shared?'Replies are queued to this same task in Codex. Keep Codex running; approvals stay in Codex.':(s.historyProvider==='claude'&&s.canReply)?`${ownerName(s)} is running this conversation in another window. Hush sends to it directly, so your message arrives there rather than being written to its transcript unseen. It lands as a message from Hush, so that window frames it as coming from another session and it cannot answer a permission prompt there. A bridged session avoids both: your message arrives as your own and approvals come back here.`:s.resumeBlocked?`${ownerName(s)} still owns this conversation. A reply sent from here would be written to its transcript without ever reaching it, so Hush will not send one. Reply in that app, or close it and refresh this history.`:'Saved history only. Connecting works when the original client has released the conversation. An idle task can still belong to that client.';
  const messages=$('messages');const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<50,previousTop=messages.scrollTop,changedConversation=scrollConversation!==s.id;
  if(changedConversation){messageNodes.clear();messages.replaceChildren();}
  if(!s.messages.length){if(!messages.querySelector('.fine')){messages.replaceChildren(el('p','fine','Connected. Send a task, then get back to your day.'));messageNodes.clear();}}
  else {messages.querySelector('.fine')?.remove();const ids=new Set(s.messages.map(m=>m.id));for(const [id,node]of messageNodes)if(!ids.has(id)){node.remove();messageNodes.delete(id);}s.messages.forEach((m,i)=>{let node=messageNodes.get(m.id);if(!node){node=el('div','message '+m.role);const speaker=m.role==='you'?'You':m.role==='agent'?s.provider:'Connection';const same=i>0&&s.messages[i-1].role===m.role;node.append(el('span','byline',same?'':speaker),document.createTextNode(m.text));messageNodes.set(m.id,node);}else if(node.lastChild.nodeValue!==m.text)node.lastChild.nodeValue=m.text;if(messages.children[i]!==node)messages.insertBefore(node,messages.children[i]||null);});}
  scrollConversation=s.id;if(nearBottom||changedConversation)requestAnimationFrame(()=>{if(selected===s.id)messages.scrollTop=messages.scrollHeight;});else messages.scrollTop=previousTop;
  if(document.activeElement!==$('reply'))$('reply').value=drafts[draftKey(s.id)]||drafts[s.id]||'';
  const unavailable=!s.canReply||s.status==='offline';$('reply').disabled=unavailable||!!s.request;$('send').disabled=unavailable||!!s.request||(s.status==='working'&&!s.shared)||s.sending||!!s.queuePending;
  $('attach').disabled=unavailable||!s.images||!!s.sending; $('dictate').disabled=unavailable||!state.dictation;
  const attachments=$('attachments');const attachmentKey=JSON.stringify([s.id,s.attachments,s.sending]);if(attachmentKey!==attachmentSignature){attachmentSignature=attachmentKey;attachments.replaceChildren();for(const a of s.attachments||[]){const chip=el('button','attachment',a.name+' ×');chip.type='button';chip.disabled=!!s.sending;chip.setAttribute('aria-label','Remove '+a.name);chip.onclick=()=>call('remove-image',{id:s.id,attachmentId:a.id}).catch(error);attachments.append(chip);}}
  const model=$('model');const desired=JSON.stringify([s.id,s.models,s.shared,s.selectedModel]);if(model.dataset.options!==desired){model.dataset.options=desired;model.replaceChildren();const base=el('option','',s.shared?'Model set in Codex':'Use current model');base.value='';model.append(base);for(const m of s.models||[]){const option=el('option','',m.name);option.value=m.id;model.append(option);}model.value=s.selectedModel||'';}model.disabled=unavailable||!!s.shared||!['Codex','Claude Code','Cursor'].includes(s.provider);model.title=s.shared?'The shared reply queue does not change the model. Change it in Codex.':'Model for your next message';
  $('reply-hint').textContent=listening?'Listening ... speak, or press Stop':s.sending?'Sending...':s.queuePending?'Queued in Codex · waiting for its owner':unavailable?'Reply in the source app':s.status==='working'?'Agent is working · draft kept here':`${modifier}+Enter to send`;
  const request=$('request');request.hidden=!s.request;
  const key=s.id+':'+(s.request?.id||'');if(requestRendered===key)return;requestRendered=key;request.replaceChildren();if(!s.request)return;
  const r=s.request;request.append(el('h2','',r.title));if(r.detail)request.append(el('pre','',r.detail));
  if(r.kind==='approval'){for(const [text,value]of[['Allow once','accept'],['Deny','decline']]){const b=el('button',value==='decline'?'':'primary',text);b.onclick=()=>answer(s,r,value);request.append(b);}}
  else if(r.kind==='question'){const fields={};for(const q of r.questions||[]){const label=el('label','',q.question);const field=el('input');field.id='q-'+q.id;label.htmlFor=field.id;field.type=q.isSecret?'password':'text';fields[q.id]=field;request.append(label,field);if(q.options?.length)request.append(el('p','fine',q.options.map(o=>o.label).join(' · ')));}const b=el('button','primary','Send answer');b.onclick=()=>answer(s,r,Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value])));request.append(b);}
}
async function answer(s,r,value){clearError();try{await call('answer',{id:s.id,requestId:r.id,value});const latest=await call('snapshot');render(latest);if(!latest.sessions.find(x=>x.id===s.id)?.request)await call('hide');}catch(e){error(e);}}
for(const name of['inbox','connections','settings'])$(name+'-tab').onclick=()=>showTab(name);
$('first-connect').onclick=()=>{showTab('tasks');loadTasks();};$('hide').onclick=()=>{saveDraft();call('hide');};$('expand').onclick=()=>{setCompact(false);showTab('inbox');};$('quiet').onclick=()=>call('settings',{quiet:!state.settings.quiet}).catch(error);$('reply').oninput=saveDraft;
$('reply-form').onsubmit=async e=>{e.preventDefault();clearError();saveDraft();const id=selected,key=draftKey(id),text=$('reply').value;$('send').disabled=true;try{await call('reply',{id,text});render(await call('snapshot'));const currentKey=draftKey(id);if(drafts[currentKey]===text||drafts[key]===text){if(drafts[key]===text)delete drafts[key];if(drafts[currentKey]===text)delete drafts[currentKey];localStorage.setItem('drafts',JSON.stringify(drafts));if(selected===id&&$('reply').value===text){$('reply').value='';$('reply').blur();if(!state.sessions.find(s=>s.id===id)?.request)await call('hide');}}}catch(e){error(e);}finally{renderConversation();}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){saveDraft();call('hide');}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&tab==='inbox'&&!$('send').disabled){e.preventDefault();$('reply-form').requestSubmit();}});
$('disconnect').onclick=async()=>{saveDraft();try{await call('remove',{id:selected});render(await call('snapshot'));}catch(e){error(e);}};
$('source').onclick=()=>call('source',{id:selected}).catch(error);
$('provider').onchange=()=>{const p=$('provider').value;$('project-fields').hidden=p==='herdr';$('provider-note').textContent=p==='claude-channel'?'Opens Claude Code in a terminal and bridges it to Hush. The session stays yours to use there; Hush is a channel into it rather than a second owner, so your replies reach it. Asks you to confirm on first launch.':p==='herdr'?'Connects agents in the running local Herdr server. Install Herdr and start a session first.':(p==='codex'?'Codex is included.':`${p==='cursor'?'Cursor Agent CLI':'Claude Code'} must be installed.`);};
$('browse').onclick=async()=>{try{const folder=await call('choose-folder');if(folder)$('folder').value=folder;}catch(e){error(e);}};
$('signin').onclick=()=>call('signin',{provider:$('provider').value}).catch(error);
$('connect-form').onsubmit=async e=>{e.preventDefault();clearError();$('connect').disabled=true;$('connect').textContent='Connecting…';try{const r=await call('connect',{provider:$('provider').value,cwd:$('folder').value,title:$('title').value,resumeId:undefined});if(r.id){render(await call('snapshot'));select(r.id);}showTab('inbox');if(r.count===0)error(Error('Herdr connected, but no agents with stable session identities were found. Start an agent with a Herdr integration.'));}catch(e){error(e);}finally{$('connect').disabled=false;$('connect').textContent='Start conversation';}};
$('corner').onchange=()=>call('settings',{corner:$('corner').value}).catch(error);$('blur').onchange=()=>call('settings',{hideOnBlur:$('blur').checked}).catch(error);$('fade').onchange=()=>{call('settings',{fadeWhenIdle:$('fade').checked}).catch(error);wake();};$('transparent').onchange=()=>call('settings',{transparent:$('transparent').checked}).catch(error);$('preview-notice').onclick=()=>call('test-notification').catch(error);
let taskCursor=null,taskRequest=0,taskRows=[];
async function loadTasks(more=false){
  const request=++taskRequest;const provider=$('task-provider').value,query=$('task-query').value.trim();
  $('task-status').textContent='Finding your conversations…';$('refresh-tasks').disabled=true;$('more-tasks').disabled=true;
  try{const result=await call('list-tasks',{provider:more?'codex':provider,query,cursor:more?taskCursor:null});if(request!==taskRequest)return;
    taskCursor=result.nextCursor;taskRows=more?[...taskRows,...result.items]:result.items;
    const unique=[...new Map(taskRows.map(t=>[t.provider+':'+t.sourceId,t])).values()];
    const list=$('task-results');list.replaceChildren();for(const task of unique){const b=el('button','task-row');b.append(el('strong','',task.title),el('span','',`${task.provider==='codex'?'Codex':task.provider==='cursor'?'Cursor':'Claude Code'} · ${new Date(task.updatedAt).toLocaleDateString()}${task.cwd?' · '+task.cwd.split(/[\\/]/).filter(Boolean).at(-1):''}`));b.onclick=async()=>{clearError();b.disabled=true;try{const r=await call('preview-task',{provider:task.provider,sourceId:task.sourceId});render(await call('snapshot'));select(r.id);showTab('inbox');}catch(e){error(e);}finally{b.disabled=false;}};list.append(b);}
    $('task-status').textContent=result.errors.length?result.errors.map(e=>e.provider+': '+e.message).join(' · '):unique.length?`${unique.length} conversations`:'No saved conversations found. Start one in New.';
    $('more-tasks').hidden=!taskCursor;
  }catch(e){if(request===taskRequest)$('task-status').textContent=e.message;}finally{if(request===taskRequest){$('refresh-tasks').disabled=false;$('more-tasks').disabled=false;}}
}
$('task-search').onsubmit=e=>{e.preventDefault();loadTasks();};$('task-provider').onchange=()=>loadTasks();$('refresh-tasks').onclick=()=>loadTasks();$('more-tasks').onclick=()=>loadTasks(true);
$('tasks-tab').onclick=()=>{showTab('tasks');loadTasks();};
$('continue-task').onclick=async()=>{const s=state.sessions.find(x=>x.id===selected);if(!s?.external)return;clearError();$('continue-task').disabled=true;try{const r=await call('connect',{provider:s.historyProvider,resumeId:s.sourceId});render(await call('snapshot'));select(r.id);$('reply').focus();}catch(e){error(e);}finally{renderConversation();}};
$('bridge-session').onclick=async()=>{const s=state.sessions.find(x=>x.id===selected);clearError();$('bridge-session').disabled=true;try{await call('connect',{provider:'claude-channel',cwd:s?.cwd,title:s?.title});}catch(e){error(e);}finally{$('bridge-session').disabled=false;}};
$('refresh-task').onclick=async()=>{try{await call('refresh-task',{id:selected});render(await call('snapshot'));}catch(e){error(e);}};
$('connect-herdr').onclick=async()=>{clearError();$('connect-herdr').disabled=true;try{const r=await call('connect',{provider:'herdr'});render(await call('snapshot'));showTab('inbox');if(!r.count)error(Error('No running Herdr agents found.'));}catch(e){error(e);}finally{$('connect-herdr').disabled=false;}};
window.hush.subscribe(render);call('snapshot').then(render).catch(error);showTab('tasks');loadTasks();



$('attach').onclick=()=>call('choose-images',{id:selected}).catch(error);
$('model').onfocus=async()=>{const id=selected;try{await call('models',{id});}catch(e){error(e);}};
$('model').onchange=()=>{call('set-model',{id:selected,model:$('model').value}).catch(error);};
$('dictate').onclick=async()=>{if(listening){await call('stop-dictation');return;}saveDraft();const id=selected;listening=true;$('dictate').classList.add('listening');$('dictate').setAttribute('aria-label','Stop dictation');$('dictate').setAttribute('aria-pressed','true');renderConversation();try{const text=await call('dictate');if(text){const key=draftKey(id);drafts[key]=((drafts[key]||'')+' '+text).trim();localStorage.setItem('drafts',JSON.stringify(drafts));if(selected===id)$('reply').value=drafts[key];}}catch(e){error(e);}finally{listening=false;$('dictate').classList.remove('listening');$('dictate').setAttribute('aria-label','Dictate a reply');$('dictate').setAttribute('aria-pressed','false');renderConversation();}};

$('clear-images').onclick=()=>call('clear-images').catch(error);
wake();
