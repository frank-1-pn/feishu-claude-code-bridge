import net from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
const fail=code=>Object.assign(Error(code),{code});
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function clientFrame(opcode,bytes) {
  const payload=Buffer.from(bytes),mask=randomBytes(4);let header;
  if(payload.length<126){header=Buffer.alloc(2);header[1]=0x80|payload.length;}
  else if(payload.length<=65535){header=Buffer.alloc(4);header[1]=0xfe;header.writeUInt16BE(payload.length,2);}
  else {header=Buffer.alloc(10);header[1]=0xff;header.writeBigUInt64BE(BigInt(payload.length),2);}
  header[0]=0x80|opcode;const masked=Buffer.from(payload);
  for(let i=0;i<masked.length;i++)masked[i]^=mask[i%4];
  return Buffer.concat([header,mask,masked]);
}
// Unix-local RFC6455 client: bounded upgrade, masking, fragmentation and control
// frames. No TCP URLs, auth forwarding, binary messages or compression support.
export async function connectManagedWebSocket(socketPath,{timeoutMs=10000,maxBytes=64*1024*1024}={}) {
  const socket=net.createConnection({path:socketPath});const key=randomBytes(16).toString('base64');
  let buffer=Buffer.alloc(0),upgraded=false,closed=false,fragments=[],fragmentBytes=0,nextId=1;
  const waiting=new Map();let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const stop=error=>{
    if(closed)return;closed=true;clearTimeout(upgradeTimer);readyReject(error);
    for(const p of waiting.values()){clearTimeout(p.timer);p.reject(error);}waiting.clear();socket.destroy();
  };
  const upgradeTimer=setTimeout(()=>stop(fail('managed_socket_upgrade_timeout')),timeoutMs);
  const message=bytes=>{
    let item;try{item=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('managed_rpc_invalid_message');}
    if(!item || typeof item!=='object' || Array.isArray(item))throw fail('managed_rpc_invalid_message');
    if('id' in item && ('result' in item || 'error' in item)) {
      const pending=waiting.get(item.id);if(!pending)return;
      waiting.delete(item.id);clearTimeout(pending.timer);
      if(item.error)pending.reject(fail('managed_rpc_rejected'));else pending.resolve(item.result);
    }
    // Never answer server requests (notably approval requests), forward hidden
    // reasoning or use notifications as proof of delivery. Existing UI owns it.
  };
  const consume=()=>{
    if(!upgraded){
      const end=buffer.indexOf('\r\n\r\n');
      if(end<0){if(buffer.length>16384)throw fail('managed_upgrade_oversize');return;}
      if(end>16384)throw fail('managed_upgrade_oversize');
      const lines=buffer.subarray(0,end).toString('ascii').split('\r\n');
      const headers=new Map();for(const line of lines.slice(1)){const i=line.indexOf(':');if(i<1)throw fail('managed_upgrade_invalid');const name=line.slice(0,i).toLowerCase();if(headers.has(name))throw fail('managed_upgrade_invalid');headers.set(name,line.slice(i+1).trim());}
      const accept=createHash('sha1').update(key+GUID).digest('base64');
      if(!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]) || headers.get('sec-websocket-accept')!==accept
        || headers.get('upgrade')?.toLowerCase()!=='websocket' || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')
        || headers.has('sec-websocket-extensions'))throw fail('managed_upgrade_invalid');
      buffer=buffer.subarray(end+4);upgraded=true;clearTimeout(upgradeTimer);readyResolve();
    }
    while(buffer.length>=2){
      const fin=!!(buffer[0]&0x80),opcode=buffer[0]&15;
      if(buffer[0]&0x70 || buffer[1]&0x80)throw fail('managed_frame_invalid');
      let length=buffer[1]&127,offset=2;
      if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;if(length<126)throw fail('managed_frame_invalid');}
      else if(length===127){if(buffer.length<10)return;const big=buffer.readBigUInt64BE(2);if(big>BigInt(maxBytes)||big<65536n)throw fail('managed_frame_oversize');length=Number(big);offset=10;}
      if(length>maxBytes || opcode<8 && fragmentBytes+length>maxBytes)throw fail('managed_frame_oversize');
      if(opcode>=8 && (!fin || length>125))throw fail('managed_frame_invalid');
      if(buffer.length<offset+length)return;
      const payload=buffer.subarray(offset,offset+length);buffer=buffer.subarray(offset+length);
      if(opcode===8){if(length===1)throw fail('managed_frame_invalid');socket.write(clientFrame(8,payload));stop(fail('managed_socket_closed'));return;}
      if(opcode===9){socket.write(clientFrame(10,payload));continue;}
      if(opcode===10)continue;
      if(opcode!==0 && opcode!==1)throw fail('managed_frame_invalid');
      if(opcode===0 && !fragments.length || opcode===1 && fragments.length)throw fail('managed_frame_invalid');
      if(!fin){fragments.push(Buffer.from(payload));fragmentBytes+=length;continue;}
      if(opcode===0){fragments.push(payload);message(Buffer.concat(fragments));fragments=[];fragmentBytes=0;}
      else message(payload);
    }
  };
  socket.on('connect',()=>socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  socket.on('data',chunk=>{if(closed)return;try{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>maxBytes+16384)throw fail('managed_frame_oversize');consume();}catch(error){stop(error);}});
  socket.on('error',()=>stop(fail('managed_socket_failed')));socket.on('end',()=>stop(fail('managed_socket_closed')));socket.on('close',()=>stop(fail('managed_socket_closed')));
  await ready;
  const send=item=>{if(closed)throw fail('managed_socket_closed');const data=Buffer.from(JSON.stringify(item));if(data.length>1024*1024)throw fail('managed_request_oversize');socket.write(clientFrame(1,data));};
  return {
    request(method,params){return new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{waiting.delete(id);reject(fail('managed_rpc_timeout'));stop(fail('managed_rpc_timeout'));},timeoutMs);waiting.set(id,{resolve,reject,timer});try{send({id,method,params});}catch(error){clearTimeout(timer);waiting.delete(id);reject(error);stop(error);}});},
    notify(method,params={}){send({method,params});},
    close(){stop(fail('managed_client_closed'));},
  };
}
