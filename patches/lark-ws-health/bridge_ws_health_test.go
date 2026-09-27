package event

import (
 "bytes"
 "context"
 "encoding/json"
 "os"
 "path/filepath"
 "strings"
 "testing"
 "time"
)

func TestBridgeWSHealthObservesOnlyRealSDKSignals(t *testing.T) {
 now:=time.UnixMilli(1000000)
 file:=filepath.Join(t.TempDir(),"health.json")
 h:=newBridgeWSHealth(file,"fixture",func() time.Time{return now})
 h.observe("bridge ping interval: 15")
 h.observe("connected to wss://example.invalid?access_key=SECRET", "[conn_id=private]")
 h.observe("ping success", "[conn_id=private]")
 if h.state.LastPong!=0 || h.state.State!="awaiting_pong" { t.Fatal("local ping is not proof") }
 h.observe("receive message, payload: receive pong SECRET", "[conn_id=private]")
 if h.state.LastPong!=0 { t.Fatal("payload text forged heartbeat") }
 now=now.Add(time.Second)
 h.observe("receive pong", "[conn_id=private]")
 if h.state.LastPong!=now.UnixMilli() || h.state.PingInterval!=15000 { t.Fatal("pong or interval missing") }
 data,_:=os.ReadFile(file)
 if strings.Contains(string(data),"SECRET") || strings.Contains(string(data),"conn_id") || strings.Contains(string(data),"wss:") { t.Fatal("sensitive log persisted") }
 var persisted bridgeWSSnapshot
 if err:=json.Unmarshal(data,&persisted); err!=nil || persisted.Pongs!=1 { t.Fatal("snapshot invalid") }
 h.observe("disconnected to wss://secret", "[conn_id=private]")
 since:=h.state.RecoveringSince
 now=now.Add(time.Second)
 h.observe("trying to reconnect: 1", "[conn_id=private]")
 if h.state.RecoveringSince!=since { t.Fatal("reconnect resets deadline") }
 h.observe("connected to wss://new", "[conn_id=new]")
 h.observe("receive pong", "[conn_id=private]")
 if h.state.LastPong!=0 || h.state.Generation!=2 { t.Fatal("old connection revived health") }
 h.observe("receive pong", "[conn_id=new]")
 if h.state.Pongs!=2 || h.state.State!="connected" { t.Fatal("new connection not verified") }
}

func TestBridgeWSLoggerNeverPrintsSensitiveSDKArguments(t *testing.T) {
 old:=bridgeWSObserver
 defer func(){bridgeWSObserver=old}()
 bridgeWSObserver=newBridgeWSHealth(filepath.Join(t.TempDir(),"health.json"),"",time.Now)
 var output bytes.Buffer
 logger:=&stderrLogger{w:&output}
 logger.Info(context.Background(),"connected to wss://example.invalid?access_key=SECRET")
 logger.Warn(context.Background(),"payload SECRET")
 logger.Error(context.Background(),"token=SECRET")
 logger.Debug(context.Background(),"receive message, payload: SECRET")
 if output.Len()!=0 { t.Fatal("raw SDK args escaped") }
}

func TestBridgeWSPingDeadlineAndFastPongRace(t *testing.T) {
 now:=time.UnixMilli(1000000)
 h:=newBridgeWSHealth(filepath.Join(t.TempDir(),"health.json"),"",func()time.Time{return now})
 h.observe("connected to wss://example.invalid", "conn")
 h.observe("ping success", "conn")
 first:=h.state.PendingPingSince
 now=now.Add(15*time.Second)
 h.observe("ping success", "conn")
 if h.state.PendingPingSince!=first { t.Fatal("new ping postponed old deadline") }
 h.observe("receive pong", "conn")
 if h.state.PendingPingSince!=0 { t.Fatal("pong did not clear pending ping") }
 now=now.Add(15*time.Second)
 h.observe("receive pong", "conn")
 now=now.Add(time.Millisecond)
 h.observe("ping success", "conn")
 if h.state.PendingPingSince!=0 { t.Fatal("post-write ping log ignored earlier pong") }
}
