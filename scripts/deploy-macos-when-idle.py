"""Install an authorized fixed revision after the existing worker is fully idle.
Private config, binary and report paths are explicit host-local inputs.
"""
import argparse,datetime,hashlib,json,os,shutil,signal,subprocess,tempfile,time
from pathlib import Path
COUNTERS=['queued_count','awaiting_delivery_count','awaiting_reply_count','reply_pending_count','file_pending_count','action_pending_count','native_reply_pending_count','native_action_pending_count','cloud_doc_pending_count','reaction_pending_count','waiting_input_count','failed_count','watch_error_count','outbound_blocked_count','file_failed_count','reaction_blocked_count','native_reply_blocked_count','cloud_doc_failed_count','native_action_blocked_count','action_blocked_count']
def read(p):return json.loads(p.read_text())
def capture(args):return subprocess.run(list(map(str,args)),capture_output=True,text=True,timeout=20)
def identity(pid,script):
 if not isinstance(pid,int) or pid<2:return False
 r=capture(['/bin/ps','-p',pid,'-o','args=']);return r.returncode==0 and str(script) in r.stdout

def idle(s,source,config):
 if s.get('state')!='idle' or s.get('worker_path')!=str(source/'daemon/codex-bridge-worker.mjs'):return False
 for bot in config['bindings']:
  b=s.get('bot_states',{}).get(bot,{})
  if any(b.get(k)!=0 for k in COUNTERS):return False
  log=source/'daemon/state/events'/f'{bot}.ndjson';offset=Path(os.path.realpath(tempfile.gettempdir()))/f'lark-{bot}-codex.offset'
  if not log.exists() or not offset.exists() or int(offset.read_text())!=log.stat().st_size:return False
 return True

def atomic(p,value):
 tmp=p.with_name(p.name+'.deploy.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(p)
def main():
 p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--runtime',required=True);p.add_argument('--binary',required=True);p.add_argument('--manifest',required=True);p.add_argument('--revision',required=True);p.add_argument('--report',required=True);a=p.parse_args()
 source=Path(a.source);runtime=Path(a.runtime);binary=Path(a.binary);report=Path(a.report);config=read(source/'daemon/codex-thread-bindings.json')
 assert capture(['git','-C',source,'rev-parse','HEAD']).stdout.strip()==a.revision
 assert capture(['git','-C',source,'diff','--quiet']).returncode==0
 remote=capture(['git','-C',source,'ls-remote','origin','refs/heads/feat/macos-codex-20260930']);assert remote.returncode==0 and remote.stdout.startswith(a.revision)
 manifest=read(Path(a.manifest));assert hashlib.sha256(binary.read_bytes()).hexdigest()==manifest['binary_sha256']
 snapshot=Path(os.path.realpath(tempfile.gettempdir()))/'lark-codex-bridge.status.json'
 deadline=time.monotonic()+1800;atomic(report,{'stage':'waiting_for_delivery_and_idle','revision':a.revision})
 while time.monotonic()<deadline:
  try:
   s=read(snapshot)
   if idle(s,source,config) and identity(s.get('pid'),source/'daemon/codex-bridge-worker.mjs'):
    time.sleep(2);s=read(snapshot)
    if idle(s,source,config):break
  except (ValueError,FileNotFoundError):pass
  time.sleep(2)
 else:raise RuntimeError('idle_gate_timeout')
 # Final exact identity and complete queue gate, immediately before stopping.
 s=read(snapshot);assert idle(s,source,config) and identity(s['pid'],source/'daemon/codex-bridge-worker.mjs')
 backup=Path.home()/'.local/share/feishu-backups'/datetime.datetime.now().strftime('macos-deploy-%Y%m%d-%H%M%S');backup.mkdir(parents=True,mode=0o700)
 if runtime.exists():shutil.copytree(runtime,backup/'runtime-before')
 os.kill(s['pid'],signal.SIGTERM)
 for bot,binding in config['bindings'].items():
  subscriber=read(source/'daemon/state/events'/f'{bot}.subscriber.json');pid=subscriber.get('pid')
  if identity(pid,source/'daemon/macos-subscriber.mjs'):os.kill(pid,signal.SIGTERM)
  for _ in range(30):
   stopped=capture([config['runtime']['lark_cli_exe'],*(['--profile',binding['profile']] if binding['profile'] else []),'event','stop','--json'])
   if stopped.returncode==0:break
   time.sleep(1)
  else:raise RuntimeError('old_bus_not_stopped')
 for _ in range(15):
  if not identity(s['pid'],source/'daemon/codex-bridge-worker.mjs'):break
  time.sleep(1)
 else:raise RuntimeError('worker_did_not_stop')
 runtime.mkdir(parents=True,exist_ok=True)
 for file in (source/'daemon').glob('*.mjs'):
  if '.test.' not in file.name:shutil.copy2(file,runtime/file.name)
 shutil.copytree(source/'daemon/state',runtime/'state',dirs_exist_ok=True)
 (runtime/'bin').mkdir(exist_ok=True);shutil.copy2(binary,runtime/'bin/lark-cli-heartbeat');atomic(runtime/'subscriber-runtime.json',manifest)
 config['runtime'].update(lark_send_script=str(runtime/'lark-send.mjs'),subscriber_cli_exe=str(runtime/'bin/lark-cli-heartbeat'),ws_health_required=True)
 atomic(runtime/'codex-thread-bindings.json',config)
 registry=read(runtime/'bot-registry.json') if (runtime/'bot-registry.json').exists() else {'bots':{},'projects':{},'default':None}
 for bot,b in config['bindings'].items():registry.setdefault('bots',{})[bot]={'profile':b['profile'],'chat_id':b['chat_id'],'enabled':True}
 atomic(runtime/'bot-registry.json',registry)
 node=shutil.which('node');started=capture([node,runtime/'macos-service.mjs','harden']);assert started.returncode==0,'watchdog_start_failed'
 atomic(report,{'stage':'installed_waiting_for_real_pong','revision':a.revision,'backup':str(backup)})
 for _ in range(60):
  status=read(runtime/'state/macos-watchdog.status.json') if (runtime/'state/macos-watchdog.status.json').exists() else {}
  if status.get('socket_verified') and status.get('bridge',{}).get('healthy'):
   atomic(report,{'stage':'enabled_real_pong_verified','revision':a.revision,'backup':str(backup),'end_to_end_after_deploy':'pending_next_user_message'});return
  time.sleep(3)
 raise RuntimeError('real_pong_verification_pending')
if __name__=='__main__':
 try:main()
 except Exception as e:
  # No exception args/CLI output: private details must not escape diagnostics.
  print(type(e).__name__+': deployment did not fully verify',flush=True);raise SystemExit(1)
