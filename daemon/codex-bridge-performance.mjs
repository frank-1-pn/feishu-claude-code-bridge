import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {sourceTimestamp,finalTiming,normalizeMetricsEpoch,metricsEpochKey,intakeEpochMatches} from './codex-bridge-metrics.mjs';
export {buildFinalDeliveryEvidence} from './codex-bridge-metrics.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const duration=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;
const timingSource=s=>['send_response','create_response','reconciled_observation','reconciled'].includes(s)?s:'unknown';
export function performanceMetadata(bot,job) {
  const r=job.prepared?.bridgeReadonly;
  const original=sourceTimestamp(job.event),final=finalTiming(job);
  return {version:2,key:hash(`perf-v2\0${bot}\0${job.id}`),scope:'historical_observation',status:job.status,
    disposition:job.completionDisposition==='silent'?'silent':job.feedbackDisposition==='actionable'?'actionable':'unknown',
    timings_ms:{original_to_intake:duration(original,job.acceptedAt),original_to_marker:duration(original,job.deliveredAt),
      original_to_first_card:duration(original,job.firstCardSentAt),original_to_first_typing:duration(original,job.firstTypingAppliedAt??job.firstTypingVerifiedAt),
      original_to_final_delivery:duration(original,final.at),intake_to_submit:duration(job.acceptedAt,job.submittedAt),submit_to_marker:duration(job.submittedAt,job.deliveredAt),
      intake_to_final_delivery:duration(job.acceptedAt,final.at),intake_to_first_card:duration(job.acceptedAt,job.firstCardSentAt),
      intake_to_first_typing:duration(job.acceptedAt,job.firstTypingAppliedAt??job.firstTypingVerifiedAt),prefetch:duration(r?.startedAt,r?.fetchedAt)},
    sources:{card:timingSource(job.firstCardTimingSource),typing:timingSource(job.firstTypingTimingSource??job.firstTypingVerifiedTimingSource),final:final.source},
    prefetch:{status:r?.status==='complete'?'complete':r?.status==='fallback'?'fallback':'legacy_unknown',
      used:job.readonlyPrefetchIncluded===true && job.markerSeen===true,
      event_count:job.readonlyPrefetchIncluded===true && job.markerSeen===true?r?.result?.events?.length??0:0}};
}

// Atomic private per-hash records avoid an ever-growing JSONL load/dedupe pass.
// No task text, timestamps, source IDs, paths, credentials or platform writes.
export class DeferredPerformance {
  constructor(root,{schedule=setImmediate,onError=()=>{},metricsEpoch,now=Date.now}={}) {
    this.root=root;this.schedule=schedule;this.onError=onError;this.pending=new Set();this.recorded=new Set();
    this.now=now;this.metricsEpoch=normalizeMetricsEpoch(metricsEpoch,{now:now()});
    this.metricsRequested=metricsEpoch!==undefined;
  }
  observe(bot,jobs) {
    for(const job of jobs) {
      if(job.status!=='done')continue;
      if(this.metricsRequested && !this.metricsEpoch)continue;
      if(this.metricsEpoch) {
        const sourceAt=sourceTimestamp(job.event),end=this.metricsEpoch.frozenAt??this.now();
        if(job.event?.synthetic_callback===true || job.markerSeen!==true || job.feedbackDisposition!=='actionable'
          || job.completionDisposition==='silent' || !intakeEpochMatches(job,this.metricsEpoch) || sourceAt===null || sourceAt<this.metricsEpoch.startedAt || sourceAt>end || this.now()>end)continue;
      }
      const record=performanceMetadata(bot,job);
      if(this.metricsEpoch){record.scope='deployment_epoch';record.epochKey=metricsEpochKey(this.metricsEpoch);record.key=hash(`${record.key}\0${record.epochKey}`);}
      const key=record.key;
      if(this.pending.has(key)||this.recorded.has(key))continue;
      this.pending.add(key);
      this.schedule(()=>{this.write(record).then(()=>this.recorded.add(key)).catch(()=>this.onError('performance_write_failed')).finally(()=>this.pending.delete(key));});
    }
  }
  async write(record) {
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    const file=path.join(this.root,`perf-${record.key}.json`);
    try { const prior=JSON.parse(await fs.readFile(file,'utf8'));if(prior.version===2&&prior.key===record.key)return; }catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;}
    const temp=path.join(this.root,`.pending-${randomUUID()}`);
    try {
      await fs.writeFile(temp,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});
      await fs.rename(temp,file);
      const readback=JSON.parse(await fs.readFile(file,'utf8'));
      if(readback.key!==record.key || readback.version!==2)throw new Error('performance_readback_failed');
    }finally {await fs.rm(temp,{force:true});}
  }
}
