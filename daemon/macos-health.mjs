export function workerHealth(snapshot,{now=Date.now(),alive=false,identity=false}={}) {
 if(!alive||!identity)return {healthy:false,reason:'process_missing_or_identity_mismatch'};
 const heartbeat=Date.parse(snapshot?.heartbeat_at||'');
 if(!Number.isFinite(heartbeat)||heartbeat>now+5000||now-heartbeat>90000)return {healthy:false,reason:'heartbeat_stale'};
 return {healthy:true,reason:'heartbeat_fresh'};
}
export function busHealth(bus){
 const app=bus?.apps?.[0];
 if(!app?.running)return {healthy:false,reason:'bus_missing'};
 const keys=new Set((app.consumers||[]).map(c=>c.event_key));
 if(!keys.has('im.message.receive_v1')||!keys.has('card.action.trigger'))return {healthy:false,reason:'consumer_missing'};
 return {healthy:true,reason:'bus_and_consumers_present',socket_verified:false};
}
export function retryDelay(failures){return Math.min(60000,5000*2**Math.min(Math.max(0,failures-1),4));}
export function socketHealth(s,{pid,profile,startedAt,now=Date.now()}={}){
 const age=now-startedAt;
 const invalid=!s||s.schema!==1||s.pid!==pid||s.profile!==profile||!Number.isFinite(startedAt)||Math.abs(s.started_at_ms-startedAt)>10000||s.updated_at_ms>now+1000||s.last_pong_at_ms>now+1000||s.ping_interval_ms<1000||s.ping_interval_ms>3600000;
 if(invalid)return {verified:false,needs_restart:age>60000,reason:'heartbeat_missing_or_wrong_identity'};
 const interval=s.ping_interval_ms;
 if(s.recovering_since_ms>0&&now-s.recovering_since_ms>60000)return {verified:false,needs_restart:true,reason:'reconnect_expired'};
 if(s.pending_ping_since_ms>0&&now-s.pending_ping_since_ms>30000)return {verified:false,needs_restart:true,reason:'pong_timeout'};
 if(s.last_pong_at_ms>0&&now-s.last_pong_at_ms>interval*2+30000)return {verified:false,needs_restart:true,reason:'pong_stale'};
 if(s.last_pong_at_ms<=0&&now-(s.unverified_since_ms||startedAt)>interval+30000)return {verified:false,needs_restart:true,reason:'first_pong_timeout'};
 return {verified:s.state==='connected'&&s.last_pong_at_ms>0&&s.recovering_since_ms===0,needs_restart:false,reason:s.state,pong_age_seconds:s.last_pong_at_ms>0?(now-s.last_pong_at_ms)/1000:null};
}
