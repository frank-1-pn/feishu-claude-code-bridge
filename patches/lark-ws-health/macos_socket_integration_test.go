package websocket
import (
 "context"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "path/filepath"
 "strings"
 "sync/atomic"
 "testing"
 "time"
 gorilla "github.com/gorilla/websocket"
 larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)
type fixtureHealthLogger struct {h *bridgeWSHealth}
func(l fixtureHealthLogger)Debug(_ context.Context,args ...interface{}){l.h.observe(args...)}
func(l fixtureHealthLogger)Info(_ context.Context,args ...interface{}){l.h.observe(args...)}
func(l fixtureHealthLogger)Warn(_ context.Context,args ...interface{}){l.h.observe(args...)}
func(l fixtureHealthLogger)Error(_ context.Context,args ...interface{}){l.h.observe(args...)}
func TestMacRealSocketSilentPongLoss(t *testing.T){
 var url string;var received atomic.Int32;var open atomic.Bool
 h:=newBridgeWSHealth(filepath.Join(t.TempDir(),"health.json"),"fixture",time.Now)
 upgrader:=gorilla.Upgrader{}
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if r.URL.Path!="/socket" {json.NewEncoder(w).Encode(larkws.EndpointResp{Code:0,Data:&larkws.Endpoint{Url:url,ClientConfig:&larkws.ClientConfig{PingInterval:1,ReconnectCount:0}}});return}
  conn,err:=upgrader.Upgrade(w,r,nil);if err!=nil{return};open.Store(true);defer func(){conn.Close();open.Store(false)}()
  for{_,_,err=conn.ReadMessage();if err!=nil{return};count:=received.Add(1)
   if count==1{frame:=larkws.Frame{Method:0,Service:1,Headers:[]larkws.Header{{Key:larkws.HeaderType,Value:"pong"}}};data,_:=frame.Marshal();conn.WriteMessage(gorilla.BinaryMessage,data)}
   // Subsequent real SDK pings reach a live socket but deliberately get no pong.
  }
 }));defer server.Close();url="ws"+strings.TrimPrefix(server.URL,"http")+"/socket?device_id=fixture&service_id=1"
 client:=larkws.NewClient("fixture","fixture-secret",larkws.WithDomain(server.URL),larkws.WithAutoReconnect(false),larkws.WithLogger(fixtureHealthLogger{h}))
 go client.Start(context.Background())
 deadline:=time.Now().Add(5*time.Second)
 for time.Now().Before(deadline){h.mu.Lock();ready:=h.state.Pongs==1&&h.state.Pings>=3&&h.state.PendingPingSince>0;h.mu.Unlock();if ready{break};time.Sleep(20*time.Millisecond)}
 h.mu.Lock();defer h.mu.Unlock()
 if h.state.Pongs!=1||h.state.Pings<3||h.state.PendingPingSince==0||!open.Load(){t.Fatal("did not observe silent pong loss with live socket and continuing real pings")}
}
