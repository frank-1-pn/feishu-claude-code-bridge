import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {networkProbeEnv} from './start-lark-append.mjs';
import {createFaultRelay} from '../scripts/feishu-network-probe.mjs';

test('diagnostic proxy is loopback-only, time-limited and never changes global environment',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'net-probe-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'probe.json'), before=process.env.HTTPS_PROXY;
 for(const config of [{proxy:'http://outside.invalid:123',expires_at_ms:1500},{proxy:'http://user:password@127.0.0.1:123',expires_at_ms:1500},{proxy:'http://127.0.0.1:123',expires_at_ms:900},{proxy:'http://127.0.0.1:123',expires_at_ms:10000000}]){
  fs.writeFileSync(file,JSON.stringify(config));assert.deepEqual(networkProbeEnv(file,1000),{});
 }
 fs.writeFileSync(file,JSON.stringify({proxy:'http://127.0.0.1:123',expires_at_ms:1500}));
 assert.equal(networkProbeEnv(file,1000).HTTPS_PROXY,'http://127.0.0.1:123');assert.equal(process.env.HTTPS_PROXY,before);
});

test('real TCP relay hides dropped bytes and remote closes, then automatically restores connectivity',async t=>{
 let peer;const echo=net.createServer(socket=>{peer=socket;socket.pipe(socket);});echo.listen(0,'127.0.0.1');await once(echo,'listening');
 const relay=await createFaultRelay({maxFaultMs:300,allowTarget:(host,port)=>host==='127.0.0.1'&&port===echo.address().port});
 t.after(async()=>{await relay.close();await new Promise(r=>echo.close(r));});
 const connect=async()=>{const c=net.connect(new URL(relay.url).port,'127.0.0.1');await once(c,'connect');c.write(`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1\r\n\r\n`);const [data]=await once(c,'data');assert.match(data.toString(),/200 Connection Established/);return c;};
 let client=await connect();client.write('positive');assert.equal((await once(client,'data'))[0].toString(),'positive');
 relay.blackhole(300);client.write('dropped');await new Promise(r=>setTimeout(r,40));peer.destroy();await new Promise(r=>setTimeout(r,40));
 assert.equal(client.destroyed,false);assert.ok(relay.stats.dropped_bytes>=7);
 await once(client,'close');assert.equal(relay.stats.automatic_restores,1);
 client=await connect();client.write('recovered');assert.equal((await once(client,'data'))[0].toString(),'recovered');client.destroy();
});
