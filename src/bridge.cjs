const http=require('node:http');
const {randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
function text(value,max=200) { if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('Invalid or missing text field.');return value; }
async function createBridge(store,directory) {
  const token=randomBytes(32).toString('hex'),clients=new Map();
  const server=http.createServer(async(req,res)=>{
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const auth=Buffer.from(req.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(req.headers.origin || auth.length!==expected.length || !timingSafeEqual(auth,expected))return send(401,{error:'Unauthorized'});
    try{
      const url=new URL(req.url,'http://127.0.0.1');let body={};
      if(req.method==='POST'){let raw='';for await(const c of req){raw+=c;if(raw.length>128000){send(413,{error:'Payload too large'});return;}}body=JSON.parse(raw||'{}');}
      if(req.method==='POST'&&url.pathname==='/sessions') {
        const id=randomUUID(),key=randomBytes(24).toString('hex');
        const client={key,lastSeen:Date.now(),queue:[],verdicts:[],reply:body.canReply===true};
        store.add({id,provider:text(body.provider),title:text(body.title),canReply:client.reply},{reply:async message=>{if(Date.now()-client.lastSeen>30000)throw Error('Bridge disconnected. Your reply has not been sent.');if(client.queue.length>=20)throw Error('Bridge has too many unacknowledged replies.');client.queue.push({id:randomUUID(),text:message});store.update(id,{status:'working'});},
        // An adapter that raises approvals collects the verdicts here. The decision is
        // the user's alone: only accept and decline exist, and neither is ever inferred.
        answer:async(requestId,value)=>{if(!['accept','decline'].includes(value))throw Error('Choose Allow once or Deny.');if(Date.now()-client.lastSeen>30000)throw Error('Bridge disconnected. Your decision has not been sent.');client.verdicts.push({requestId,value});},
        dispose:()=>clients.delete(id)});
        clients.set(id,client);return send(201,{id,key});
      }
      const match=/^\/sessions\/([^/]+)\/(events|replies|ack|requests|verdicts|verdict-ack)$/.exec(url.pathname);
      if(!match)return send(404,{error:'Not found'});
      const [,id,action]=match,client=clients.get(id);
      if(!client||req.headers['x-session-key']!==client.key)return send(403,{error:'Unknown session'});
      client.lastSeen=Date.now();
      if(action==='replies'&&req.method==='GET')return send(200,{messages:client.queue});
      if(action==='ack'&&req.method==='POST'){client.queue=client.queue.filter(m=>m.id!==body.id);return send(200,{ok:true});}
      // An approval the adapter is holding open. Hush shows it as Allow once / Deny,
      // and the answer leaves through /verdicts. Nothing here decides anything.
      if(action==='requests'&&req.method==='POST'){
        const requestId=text(body.id,120);
        if(store.get(id).requests.some(r=>r.id===requestId))return send(200,{ok:true});
        if(store.get(id).requests.length>=10)throw Error('Too many approvals are already waiting.');
        store.enqueueRequest(id,{id:requestId,kind:'approval',title:text(body.title,300),
          ...(body.detail?{detail:text(body.detail,20000)}:{})});
        return send(201,{ok:true});
      }
      if(action==='verdicts'&&req.method==='GET')return send(200,{verdicts:client.verdicts});
      if(action==='verdict-ack'&&req.method==='POST'){client.verdicts=client.verdicts.filter(v=>v.requestId!==body.requestId);return send(200,{ok:true});}
      if(action==='events'&&req.method==='POST'){
        if(body.text)store.message(id,'agent',text(body.text,60000));
        if(body.status){if(!['idle','working','waiting','done','error'].includes(body.status))throw Error('Invalid status.');store.update(id,{status:body.status,canReply:client.reply});}
        return send(200,{ok:true});
      }
      send(405,{error:'Method not allowed'});
    }catch(e){send(400,{error:e.message});}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.mkdirSync(directory,{recursive:true});
  const filename=path.join(directory,'bridge.json');
  fs.writeFileSync(filename,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token}),{mode:0o600});
  const sweep=setInterval(()=>{for(const [id,c]of clients)if(Date.now()-c.lastSeen>30000&&store.get(id).status!=='offline')store.update(id,{status:'offline',canReply:false});},10000);sweep.unref();
  return {filename,server,close:()=>{clearInterval(sweep);server.closeAllConnections();server.close();try{fs.unlinkSync(filename);}catch{}}};
}
module.exports={createBridge};
