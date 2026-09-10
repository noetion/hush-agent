const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const STATES = new Set(['idle', 'working', 'waiting', 'done', 'error', 'offline']);
class Store extends EventEmitter {
  constructor() { super(); this.sessions = new Map(); this.actions = new Map(); }
  list() { return [...this.sessions.values()].map(s => structuredClone(s)).sort((a,b) => b.updatedAt-a.updatedAt); }
  get(id) { const s = this.sessions.get(id); if (!s) throw Error('This session is no longer connected.'); return s; }
  add({id=randomUUID(), provider, title, cwd='', sourceId='', canReply=false, canOpen=false}, actions={}) {
    if (this.sessions.has(id)) throw Error('Session already exists.');
    if (this.sessions.size >= 100) throw Error('Session limit reached. Remove old sessions first.');
    const s = {id,provider,title,cwd,sourceId,canReply,canOpen,status:'idle',messages:[],request:null,requests:[],unread:false,updatedAt:Date.now()};
    this.sessions.set(id,s); this.actions.set(id,actions); this.emit('change'); return s;
  }
  update(id, patch) {
    const s=this.get(id), previous=s.status;
    if (patch.status && !STATES.has(patch.status)) throw Error('Invalid session status.');
    Object.assign(s,patch,{updatedAt:Date.now()});
    if (patch.status && previous!==s.status && ['waiting','done','error'].includes(s.status)) { s.unread=true; this.emit('attention',s); }
    this.emit('change'); return s;
  }
  message(id, role, text) {
    const s=this.get(id); s.messages.push({id:randomUUID(),role,text:String(text).slice(0,60000),time:Date.now()});
    if(s.messages.length>100) s.messages.shift(); s.updatedAt=Date.now(); this.emit('change');
  }
  seen(id) { const s=this.get(id);if(s.unread){s.unread=false;this.emit('change');} }
  enqueueRequest(id,request){const s=this.get(id);s.requests.push(request);this.update(id,{request:s.requests[0],status:'waiting'});}
  resolveRequest(id,requestId){const s=this.get(id);s.requests=s.requests.filter(r=>r.id!==requestId);this.update(id,{request:s.requests[0]||null,status:s.requests.length?'waiting':'working'});}
  async reply(id,text,options={}) {
    const s=this.get(id); text=String(text).trim();
    if((!text&&!options.attachments?.length) || text.length>16000) throw Error('Write a reply between 1 and 16,000 characters.');
    if(!s.canReply || s.status==='offline') throw Error('Open the source app to reply to this session.');
    if(s.request) throw Error('Answer the pending request before sending another message.');
    if(s.sending || (s.status==='working'&&!s.shared) || s.queuePending) throw Error('This agent is still working. Your draft is kept here.');
    s.sending=true; this.emit('change');
    const message={id:randomUUID(),role:'you',text,time:Date.now(),pending:true};s.messages.push(message);this.emit('change');
    try { await this.actions.get(id).reply(text||'Describe the attached images.',options); message.pending=false;if(s.messages.length>100)s.messages.shift(); }
    catch(e){s.messages=s.messages.filter(m=>m.id!==message.id);throw e;}
    finally { s.sending=false; this.emit('change'); }
  }
  async answer(id,requestId,value) {
    const s=this.get(id); if(!s.request || s.request.id!==requestId) throw Error('This request has already been resolved.');
    if(s.answering) throw Error('Your answer is already being sent.');
    s.answering=true;
    try { await this.actions.get(id).answer(requestId,value); if(s.request?.id===requestId) this.resolveRequest(id,requestId); }
    finally { s.answering=false; this.emit('change'); }
  }
  async open(id) { const s=this.get(id); if(!s.canOpen) throw Error('No source app is available.'); await this.actions.get(id).open(); }
  async remove(id) { const s=this.get(id); if(s.sending || s.queuePending || s.status==='working' || s.request) throw Error('Wait for this agent and queued replies to finish before removing it.'); await this.actions.get(id)?.dispose?.(); this.actions.delete(id); this.sessions.delete(id); this.emit('change'); }
  async close() { await Promise.allSettled([...this.actions.values()].map(a=>a.dispose?.())); }
}
module.exports={Store};
