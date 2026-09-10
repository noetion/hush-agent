const { EventEmitter }=require('node:events');
class Rpc extends EventEmitter {
  constructor(input,output) {
    super(); this.output=output; this.pending=new Map(); this.sequence=0; this.buffer=''; this.closed=false;
    input.setEncoding('utf8'); input.on('data',chunk=>this.read(chunk));
    input.on('end',()=>this.close()); input.on('error',e=>this.close(e)); output.on('error',e=>this.close(e));
  }
  read(chunk) {
    // Four supported 5 MB images can be echoed as base64 by the queue API.
    this.buffer+=chunk; if(this.buffer.length>40*1024*1024) return this.close(Error('Provider response exceeded the size limit.'));
    let at; while((at=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,at); this.buffer=this.buffer.slice(at+1); if(!line.trim()) continue;
      let msg; try{msg=JSON.parse(line);}catch {this.emit('protocolError',Error('Provider sent invalid JSON.'));continue;}
      if(msg.method) this.emit('event',msg);
      else if(this.pending.has(msg.id)) { const p=this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer); msg.error?p.reject(Error(msg.error.message||'Provider request failed.')):p.resolve(msg.result); }
    }
  }
  send(msg) { if(this.closed) throw Error('Provider disconnected.'); this.output.write(JSON.stringify(msg)+'\n'); }
  call(method,params={},timeout=30000) {
    return new Promise((resolve,reject)=>{const id=++this.sequence; const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`${method} timed out. Check the source app before retrying.`));},timeout); this.pending.set(id,{resolve,reject,timer}); try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);} });
  }
  close(error=Error('Provider disconnected.')) { if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error); }
}
module.exports={Rpc};
