// Opt-in fault relay for acceptance tests. TLS stays end-to-end encrypted.
// Never records target URLs, payloads, headers, credentials or message content.
import net from 'node:net';

export async function createFaultRelay({maxFaultMs=240000,allowTarget=(host,port)=>port===443 && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(host)}={}) {
 let mode='pass', faultUntil=0;
 const peers=new Set(), stats={connections:0,forwarded_bytes:0,dropped_bytes:0,automatic_restores:0};
 const restore=()=>{mode='pass';faultUntil=0;for(const pair of peers){if(pair.tainted){pair.client.destroy();pair.upstream?.destroy();}}};
 const timer=setInterval(()=>{if(faultUntil && Date.now()>=faultUntil){stats.automatic_restores++;restore();}},100);
 timer.unref();
 const server=net.createServer(client=>{
  const pair={client,upstream:null,tainted:mode==='blackhole'};peers.add(pair);
  const cleanup=()=>{client.destroy();pair.upstream?.destroy();peers.delete(pair);};
  client.on('error',cleanup);client.on('close',cleanup);
  let header=Buffer.alloc(0);
  const handshake=data=>{
   header=Buffer.concat([header,data]);if(header.length>8192){cleanup();return;}
   const end=header.indexOf('\r\n\r\n');if(end<0)return;
   client.off('data',handshake);
   const line=header.subarray(0,end).toString('ascii').split('\r\n')[0];
   const match=/^CONNECT ([a-zA-Z0-9.-]+):(\d+) HTTP\/1\.[01]$/.exec(line);
   if(!match || !allowTarget(match[1],Number(match[2]))){cleanup();return;}
   stats.connections++;
   if(mode==='blackhole'){pair.tainted=true;client.on('data',d=>{stats.dropped_bytes+=d.length;});return;}
   const upstream=net.connect({host:match[1],port:Number(match[2])});pair.upstream=upstream;
   upstream.on('error',cleanup);upstream.on('close',cleanup);
   const relay=(from,to,data)=>{if(mode==='blackhole'){pair.tainted=true;stats.dropped_bytes+=data.length;}else{stats.forwarded_bytes+=data.length;if(!to.write(data))from.pause();}};
   upstream.on('connect',()=>{
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const rest=header.subarray(end+4);header=null;if(rest.length)relay(client,upstream,rest);
    client.on('data',data=>relay(client,upstream,data));upstream.on('data',data=>relay(upstream,client,data));
    upstream.on('drain',()=>client.resume());client.on('drain',()=>upstream.resume());
   });
  };
  client.on('data',handshake);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}`,stats,
  blackhole(ms=maxFaultMs){if(!Number.isFinite(ms)||ms<1||ms>maxFaultMs)throw new Error('Fault exceeds bounded duration');mode='blackhole';faultUntil=Date.now()+ms;},
  restore,
  async close(){clearInterval(timer);restore();for(const pair of peers){pair.client.destroy();pair.upstream?.destroy();}await new Promise(resolve=>server.close(resolve));}
 };
}
