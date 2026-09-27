"""Build the existing CLI with narrowly scoped, reproducible heartbeat hooks.

Requires Go >=1.23 and Git. Sources are pinned; credentials are never inputs.
The output is local-only. Do not replace a running subscriber binary in place.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

CLI_REV='ce5b4f24e1746b83b060a795ef21e28dc2c46e4d'
SDK_REV='63a9f9f4133a6789981bb87c9a440bf4cdfe5b1e'
VERSION='1.0.39-bridge-heartbeat.1'

def run(args,cwd=None):
    subprocess.run([str(a) for a in args],cwd=cwd,check=True)

def source(url,rev,target):
    if target.exists():
        raise SystemExit('Build directory must be new; refusing to overwrite sources')
    run(['git','clone','--quiet','--no-checkout',url,target])
    run(['git','checkout','--quiet','--detach',rev],target)
    actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=target,text=True).strip()
    if actual!=rev: raise SystemExit('Source revision mismatch')

def replace_once(path,before,after):
    text=path.read_text(encoding='utf8')
    if text.count(before)!=1: raise SystemExit('Pinned source hook changed: '+path.name)
    path.write_text(text.replace(before,after),encoding='utf8',newline='\n')

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--go',default='go')
    p.add_argument('--build-dir',required=True)
    p.add_argument('--cli-source',default='https://github.com/larksuite/cli.git')
    p.add_argument('--sdk-source',default='https://github.com/larksuite/oapi-sdk-go.git')
    args=p.parse_args()
    root=Path(args.build_dir).resolve()
    root.mkdir(parents=True,exist_ok=True)
    cli=root/'cli'; sdk=root/'sdk'
    source(args.cli_source,CLI_REV,cli)
    source(args.sdk_source,SDK_REV,sdk)
    patches=Path(__file__).resolve().parent.parent/'patches/lark-ws-health'
    for name in ('bridge_ws_health.go','bridge_ws_health_test.go'):
        shutil.copyfile(patches/name,cli/'shortcuts/event'/name)
    subscribe=cli/'shortcuts/event/subscribe.go'
    replace_once(subscribe,'func (l *stderrLogger) Debug(_ context.Context, _ ...interface{}) {}',
                 'func (l *stderrLogger) Debug(_ context.Context, args ...interface{}) { recordBridgeWS(args...) }')
    for level in ('Info','Warn','Error'):
        signature=f'func (l *stderrLogger) {level}(_ context.Context, args ...interface{{}}) {{'
        replace_once(subscribe,signature,signature+'\n\tif recordBridgeWS(args...) { return }')
    sdkfile=sdk/'ws/client.go'
    before='c.pingInterval = time.Duration(conf.PingInterval) * time.Second'
    replace_once(sdkfile,before,before+'\n\tc.logger.Debug(context.Background(), c.fmtLog("bridge ping interval: %d", conf.PingInterval)... )')
    run([args.go,'mod','edit','-replace=github.com/larksuite/oapi-sdk-go/v3='+sdk.as_posix()],cli)
    run([args.go,'fmt','./shortcuts/event'],cli)
    run([args.go,'fmt','./ws'],sdk)
    # Upstream's Linux-only absolute-path fixture fails unchanged on Windows.
    # Keep all other upstream and local tests; record the single exclusion.
    skipped=['^TestParseRoutes_RejectsAbsolutePath$'] if os.name=='nt' else []
    run([args.go,'test','./shortcuts/event']+(['-skip',skipped[0]] if skipped else []),cli)
    output=root/'lark-cli.exe'
    run([args.go,'build','-trimpath','-ldflags=-s -w -X github.com/larksuite/cli/internal/build.Version='+VERSION,'-o',output,'.'],cli)
    result={'version':VERSION,'cli_revision':CLI_REV,'sdk_revision':SDK_REV,'upstream_test_exclusions':skipped,
            'binary_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'patches':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in patches.glob('*.go')}}
    (root/'build-manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    print(json.dumps(result))

if __name__=='__main__': main()
