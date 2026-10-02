import fs from 'node:fs';
import path from 'node:path';

// One coalesced pending signal survives time spent in the lane's async work.
// The timed wait remains the authority for recovery from lost filesystem events.
export class WakeSignal {
  constructor() {this.pending=false;this.waiter=null;this.closed=false;}
  signal() {
    if(this.closed)return;
    this.pending=true;
    if(this.waiter){this.pending=false;this.waiter();}
  }
  wait(delay=500) {
    if(this.closed)return Promise.resolve();
    if(this.pending){this.pending=false;return Promise.resolve();}
    if(this.waiter)throw Error('wake_wait_already_active');
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.waiter=null;resolve();};
      const timer=setTimeout(finish,delay);this.waiter=finish;
    });
  }
  close() {this.closed=true;this.pending=false;this.waiter?.();}
}

// Watch the containing directory so an atomic file replacement stays visible.
// Failure/close only removes the hint; callers continue the 500ms intake sweep
// and retry ensure() after a missing/replaced directory or watcher failure.
export class EventFileWakeup {
  constructor(file,signal,{watch=fs.watch,stat=fs.statSync}={}) {
    this.dir=path.dirname(file);this.name=path.basename(file);this.signal=signal;
    this.watch=watch;this.stat=stat;this.watcher=null;this.identity=null;this.closed=false;
    this.ensure();
  }
  drop() {const watcher=this.watcher;this.watcher=null;this.identity=null;watcher?.close();}
  ensure() {
    if(this.closed)return;
    try {
      const stat=this.stat(this.dir),identity=`${stat.dev}:${stat.ino}`;
      if(this.watcher && identity===this.identity)return;
      this.drop();
      const watcher=this.watch(this.dir,(_event,name)=>{
        if(!this.closed && (name==null || String(name)===this.name))this.signal.signal();
      });
      this.watcher=watcher;this.identity=identity;
      watcher.on('error',()=>{if(this.watcher===watcher)this.drop();});
      watcher.on('close',()=>{if(this.watcher===watcher){this.watcher=null;this.identity=null;}});
    } catch {this.drop();}
  }
  close() {this.closed=true;this.drop();}
}
