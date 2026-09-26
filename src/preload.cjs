const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('hush',{
  platform:process.platform,
  call:(action,payload)=>ipcRenderer.invoke('hush',action,payload),
  subscribe:callback=>{const listener=(_,state)=>callback(state);ipcRenderer.on('state',listener);return()=>ipcRenderer.removeListener('state',listener);},
  // Trouble the main process could not handle, so the user hears about it rather than
  // watching the interface do nothing.
  onTrouble:callback=>{ipcRenderer.on('trouble',(_,message)=>callback(message));}
});
