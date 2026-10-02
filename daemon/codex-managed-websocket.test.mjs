import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {connectManagedWebSocket} from './codex-managed-websocket.mjs';
function frame(op,bytes,fin=true) {
 const p=Buffer.from(bytes);let h;
 if(p.length<126){h=Buffer.alloc(2);h[1]=p.length;}else if(p.length<=65535){h=Buffer.alloc(4);h[1]=126;h.writeUInt16BE(p.length,2);}else{h=Buffer.alloc(10);h[1]=127;h.writeBigUInt64BE(BigInt(p.length),2);}
 h[0]=(fin?128:0)|op;return Buffer.concat([h,p]);
}
async function fixture(t,onMessage,{upgrade}={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mws-'))),socketPath=path.join(root,'s');const connections=new Set();let masked=0;
 const server=net.createServer(s=>{connections.add(s);s.on('close',()=>connections.delete(s));let b=Buffer.alloc(0),ready=false;
 s.on('data',data=>{b=Buffer.concat([b,data]);if(!ready){const end=b.indexOf('\r\n\r\n');if(end<0)return;const header=b.subarray(0,end).toString();const key=/Sec-WebSocket-Key: (.+)\r/.exec(header+'\r')[1];
 const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write(upgrade??`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);ready=true;b=b.subarray(end+4);}
 while(b.length>=2){let n=b[1]&127,off=2;if(n===126){if(b.length<4)return;n=b.readUInt16BE(2);off=4;}else if(n===127){if(b.length<10)return;n=Number(b.readBigUInt64BE(2));off=10;}
 assert.ok(b[1]&128,'every client frame is masked');if(b.length<off+4+n)return;const mask=b.subarray(off,off+4),p=Buffer.from(b.subarray(off+4,off+4+n));for(let i=0;i<n;i++)p[i]^=mask[i%4];const op=b[0]&15;b=b.subarray(off+4+n);masked++;onMessage(s,op,p);}
 });s.on('error',()=>{});});
 await new Promise(resolve=>server.listen(socketPath,resolve));
 t.after(async()=>{for(const s of connections)s.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 return {socketPath,masked:()=>masked};
}
test('Unix WS validates upgrade and masked 7/16/64-bit text lengths with bounded JSON RPC',async t=>{
 const f=await fixture(t,(s,op,p)=>{if(op===1){const q=JSON.parse(p);s.write(frame(1,JSON.stringify({id:q.id,result:{n:q.params.text.length}})));}});
 const c=await connectManagedWebSocket(f.socketPath);
 for(const size of [12,200,70000])assert.equal((await c.request('echo',{text:'x'.repeat(size)})).n,size);
 assert.equal(f.masked(),3);c.close();await assert.rejects(c.request('closed',{}),/closed/);
});
test('fragmented UTF-8 responses survive split frame bytes and interleaved ping with masked pong',async t=>{
 let pong;const f=await fixture(t,(s,op,p)=>{if(op===10)pong=p.toString();if(op!==1)return;const q=JSON.parse(p),data=Buffer.from(JSON.stringify({id:q.id,result:{text:'中文结果'}})),at=data.indexOf(Buffer.from('中文'))+1;
 const first=frame(1,data.subarray(0,at),false),last=frame(0,data.subarray(at));s.write(first.subarray(0,1));setTimeout(()=>s.write(Buffer.concat([first.subarray(1),frame(9,'alive'),last])),2);});
 const c=await connectManagedWebSocket(f.socketPath);assert.equal((await c.request('read',{})).text,'中文结果');
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pong,'alive');c.close();
});
test('wrong HTTP upgrade accept fails before any JSON RPC',async t=>{
 const f=await fixture(t,()=>assert.fail('no rpc before upgrade'),{upgrade:'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n'});
 await assert.rejects(connectManagedWebSocket(f.socketPath),/upgrade_invalid/);
});
test('binary, oversized, masked server frames and malformed JSON fail closed without private output',async t=>{
 for(const bad of [frame(2,'private'),frame(1,'x'.repeat(256)),Buffer.from([0x81,0x80,0,0,0,0]),frame(1,'private not JSON')]){
  const f=await fixture(t,(s,op)=>{if(op===1)s.write(bad);});const c=await connectManagedWebSocket(f.socketPath,{maxBytes:128});
  await assert.rejects(c.request('read',{}),/managed_(?:frame|rpc)_/);c.close();
 }
});
test('lost ACK, socket close and RPC error reject once and never retransmit',async t=>{
 for(const mode of ['timeout','close','error']){
  let calls=0;const f=await fixture(t,(s,op,p)=>{if(op!==1)return;calls++;const q=JSON.parse(p);if(mode==='close')s.write(frame(8,Buffer.from([3,232])));if(mode==='error')s.write(frame(1,JSON.stringify({id:q.id,error:{message:'private failure'}})));});
  const c=await connectManagedWebSocket(f.socketPath,{timeoutMs:50});await assert.rejects(c.request('turn/start',{}),/managed_/);assert.equal(calls,1);c.close();
 }
});
test('persistent connection preserves response routing through interleaved notifications and server approval requests',async t=>{
 let calls=0;const f=await fixture(t,(s,op,p)=>{if(op!==1)return;calls++;const q=JSON.parse(p);
  s.write(Buffer.concat([frame(1,JSON.stringify({method:'thread/status/changed',params:{status:{type:'active'}}})),
   frame(1,JSON.stringify({id:'server-approval',method:'item/commandExecution/requestApproval',params:{}})),
   frame(1,JSON.stringify({id:q.id,result:{call:calls}}))]));});
 const c=await connectManagedWebSocket(f.socketPath);assert.equal(c.closed,false);
 for(let i=1;i<=3;i++)assert.equal((await c.request('thread/read',{})).call,i);
 assert.equal(calls,3);c.close();assert.equal(c.closed,true);
});
