class WindowPolicy {
  constructor({panel,notice,notifyChanged=()=>{},duration=5000,cooldown=15000}) {Object.assign(this,{panel,notice,notifyChanged,duration,cooldown});this.quiet=false;this.lastNotice=0;this.timer=null;}
  attention() {this.notifyChanged();if(this.quiet||this.isOpen()||Date.now()-this.lastNotice<this.cooldown)return;this.lastNotice=Date.now();this.notice.setIgnoreMouseEvents?.(true,{forward:true});this.notice.showInactive();clearTimeout(this.timer);this.timer=setTimeout(()=>this.notice.hide(),this.duration);}
  isOpen(){return this.panel.isVisible()&&!this.panel.isMinimized();}
  open() {clearTimeout(this.timer);this.notice.hide();if(this.panel.isMinimized())this.panel.restore();this.panel.show();this.panel.focus();}
  hide() {this.panel.minimize();}
  setQuiet(value) {this.quiet=value;this.notice.hide();clearTimeout(this.timer);this.notifyChanged();}
  close(){clearTimeout(this.timer);}
}
module.exports={WindowPolicy};
