const fs=require('node:fs');
const {bridgeFile:discoveryPath}=require('../src/app-data.cjs');
class HushClient{
  constructor(file=discoveryPath()){const config=JSON.parse(fs.readFileSync(file,'utf8'));const u=new URL(config.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('Hush bridge must be local.');this.url=config.url;this.token=config.token;}
  async request(route,body){const r=await fetch(this.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.token}`,'X-Session-Key':this.key||'','Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
  async connect(provider,title,canReply=true){Object.assign(this,await this.request('/sessions',{provider,title,canReply}));return this;}
  event(status,text){return this.request(`/sessions/${this.id}/events`,{status,text});}
  async replies(){return (await this.request(`/sessions/${this.id}/replies`)).messages;}
  ack(id){return this.request(`/sessions/${this.id}/ack`,{id});}
}
module.exports={HushClient};
