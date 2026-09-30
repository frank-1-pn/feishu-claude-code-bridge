"""Build a pinned macOS consume/bus CLI with real SDK pong observations."""
import argparse, hashlib, json, shutil, subprocess
from pathlib import Path
CLI_REV='7beffb086d7fa3c5b843d8affa7c089f49cfc65e'
SDK_REV='efd7ae4c25f7187100b04b6018469aba2bfac99d'
def replace(p,b,a):
 s=p.read_text();assert s.count(b)==1,(p.name,b);p.write_text(s.replace(b,a))
def main():
 p=argparse.ArgumentParser();p.add_argument('--cli-dir',required=True);p.add_argument('--sdk-dir',required=True);p.add_argument('--output-dir',required=True);args=p.parse_args()
 cli=Path(args.cli_dir).resolve();sdk=Path(args.sdk_dir).resolve();out=Path(args.output_dir).resolve();out.mkdir(parents=True,exist_ok=True)
 for directory,revision in [(cli,CLI_REV),(sdk,SDK_REV)]:assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=directory,text=True).strip()==revision
 patches=Path(__file__).resolve().parent.parent/'patches/lark-ws-health';target=cli/'internal/event/adapter/lark/websocket'
 code=(patches/'bridge_ws_health.go').read_text().replace('package event','package websocket',1)
 code=code.replace('var bridgeWSObserver = newBridgeWSHealth(os.Getenv("LARK_BRIDGE_WS_HEALTH_FILE"), os.Getenv("LARK_BRIDGE_PROFILE"), time.Now)','var bridgeWSObserver *bridgeWSHealth')
 (target/'bridge_ws_health.go').write_text(code)
 tests=(patches/'bridge_ws_health_test.go').read_text().replace('package event','package websocket',1).replace(' "os"',' "os"\n "log"').replace('&stderrLogger{w:&output}','&sdkLogger{l:log.New(&output,"",0)}')
 (target/'bridge_ws_health_test.go').write_text(tests)
 shutil.copyfile(patches/'macos_socket_integration_test.go',target/'macos_socket_integration_test.go')
 source=target/'feishu.go'
 replace(source,'larkcore.LogLevelInfo','larkcore.LogLevelDebug')
 replace(source,'cli := larkws.NewClient(s.AppID, s.AppSecret, opts...)','bridgeWSObserver = newBridgeWSHealth(os.Getenv("LARK_BRIDGE_WS_HEALTH_FILE"), os.Getenv("LARK_BRIDGE_PROFILE"), time.Now)\n\tcli := larkws.NewClient(s.AppID, s.AppSecret, opts...)')
 replace(source,'"log"','"log"\n"os"\n"time"')
 replace(source,'func (a *sdkLogger) Debug(_ context.Context, _ ...interface{}) {}','func (a *sdkLogger) Debug(_ context.Context, args ...interface{}) { recordBridgeWS(args...) }')
 for level in ['Info','Warn','Error']:
  sig=f'func (a *sdkLogger) {level}(_ context.Context, args ...interface{{}}) {{'
  # Keep lifecycle notification with a fixed safe hint; never forward raw URL/error.
  hook='''
 if recordBridgeWS(args...) {
  if len(args)>0 { if msg,ok:=args[0].(string);ok {
   switch {case strings.HasPrefix(msg,"connected to "):a.tryNotify("connected to","")
   case strings.HasPrefix(msg,"disconnected to "):a.tryNotify("disconnected to","")
   case strings.HasPrefix(msg,"trying to reconnect:"):a.tryNotify("trying to reconnect:","")}
  }}
  return
 }
'''
  replace(source,sig,sig+hook)
 f=sdk/'ws/client.go';hook='c.pingInterval = time.Duration(conf.PingInterval) * time.Second';replace(f,hook,hook+'\n c.logger.Debug(context.Background(),c.fmtLog("bridge ping interval: %d",conf.PingInterval)... )')
 subprocess.run(['go','mod','edit','-replace=github.com/larksuite/oapi-sdk-go/v3='+str(sdk)],cwd=cli,check=True)
 subprocess.run(['go','fmt','./internal/event/adapter/lark/websocket'],cwd=cli,check=True)
 subprocess.run(['go','fmt','./ws'],cwd=sdk,check=True)
 subprocess.run(['go','test','./internal/event/adapter/lark/websocket','./internal/event/consume','./internal/event/bus','./cmd/event'],cwd=cli,check=True)
 binary=out/'lark-cli-heartbeat';subprocess.run(['go','build','-trimpath','-ldflags=-s -w -X github.com/larksuite/cli/internal/build.Version=1.0.97-macos-heartbeat.1','-o',str(binary),'.'],cwd=cli,check=True)
 (out/'build-manifest.json').write_text(json.dumps({'cli_revision':CLI_REV,'sdk_revision':SDK_REV,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'platform':'darwin','patch_script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
 print('macOS heartbeat CLI tests and build complete')
if __name__=='__main__':main()
