// Local observability adapter for the pinned Lark CLI subscriber.
// No credentials, connection URLs, event bodies or SDK arguments are persisted.
package event

import (
 "encoding/json"
 "fmt"
 "os"
 "path/filepath"
 "strconv"
 "strings"
 "sync"
 "time"
)

type bridgeWSHealth struct {
 mu sync.Mutex
 file string
 connection string
 now func() time.Time
 state bridgeWSSnapshot
}

type bridgeWSSnapshot struct {
 Schema int `json:"schema"`
 PID int `json:"pid"`
 Profile string `json:"profile"`
 StartedAt int64 `json:"started_at_ms"`
 UpdatedAt int64 `json:"updated_at_ms"`
 State string `json:"state"`
 Generation int `json:"generation"`
 ConnectedAt int64 `json:"connected_at_ms"`
 RecoveringSince int64 `json:"recovering_since_ms"`
 UnverifiedSince int64 `json:"unverified_since_ms"`
 PingInterval int64 `json:"ping_interval_ms"`
 LastPing int64 `json:"last_ping_at_ms"`
 LastPong int64 `json:"last_pong_at_ms"`
 PendingPingSince int64 `json:"pending_ping_since_ms"`
 Pings int `json:"ping_count"`
 Pongs int `json:"pong_count"`
}

func newBridgeWSHealth(file, profile string, now func() time.Time) *bridgeWSHealth {
 if file == "" { return nil }
 h := &bridgeWSHealth{file:file, now:now}
 h.state = bridgeWSSnapshot{Schema:1, PID:os.Getpid(), Profile:profile,
  StartedAt:now().UnixMilli(), UnverifiedSince:now().UnixMilli(), State:"starting", PingInterval:120000}
 h.save()
 return h
}

var bridgeWSObserver = newBridgeWSHealth(os.Getenv("LARK_BRIDGE_WS_HEALTH_FILE"), os.Getenv("LARK_BRIDGE_PROFILE"), time.Now)

// Returning true suppresses the SDK's raw stderr logs, which can contain tokens.
// The exact first argument is SDK-generated; user text inside payload logs is ignored.
func recordBridgeWS(args ...interface{}) bool {
 if bridgeWSObserver == nil { return false }
 bridgeWSObserver.observe(args...)
 return true
}

func (h *bridgeWSHealth) observe(args ...interface{}) {
 if len(args)==0 { return }
 message, ok := args[0].(string); if !ok { return }
 connection := ""
 if len(args)>1 { connection, _ = args[1].(string) }
 h.mu.Lock(); defer h.mu.Unlock()
 now := h.now().UnixMilli()
 changed := true
 recover := func(state string) {
  h.state.State=state
  if h.state.UnverifiedSince==0 { h.state.UnverifiedSince=now }
  if h.state.RecoveringSince==0 { h.state.RecoveringSince=now }
 }
 switch {
 case strings.HasPrefix(message,"bridge ping interval: "):
  seconds, err := strconv.ParseInt(strings.TrimPrefix(message,"bridge ping interval: "),10,64)
  if err!=nil || seconds<1 || seconds>3600 { return }
  h.state.PingInterval=seconds*1000
 case strings.HasPrefix(message,"connected to "):
  h.connection=connection
  h.state.Generation++
  if h.state.UnverifiedSince==0 { h.state.UnverifiedSince=now }
  h.state.ConnectedAt=now
  h.state.LastPing=0; h.state.LastPong=0; h.state.PendingPingSince=0; h.state.RecoveringSince=0
  h.state.State="awaiting_pong"
 case message=="ping success":
  if connection!=h.connection || h.state.ConnectedAt==0 { return }
  h.state.LastPing=now; h.state.Pings++
  // A fast pong may be logged before the post-write ping log. Repeated pings
  // must not postpone the deadline of an unanswered ping.
  if h.state.PendingPingSince==0 && (h.state.LastPong==0 || now-h.state.LastPong>1000) { h.state.PendingPingSince=now }
 case message=="receive pong":
  if connection!=h.connection || h.state.ConnectedAt==0 { return }
  h.state.LastPong=now; h.state.Pongs++
  h.state.PendingPingSince=0
  h.state.State="connected"; h.state.RecoveringSince=0; h.state.UnverifiedSince=0
 case strings.HasPrefix(message,"disconnected to "):
  if connection!=h.connection { return }
  h.state.ConnectedAt=0; recover("disconnected")
 case strings.HasPrefix(message,"trying to reconnect:"):
  recover("reconnecting")
 case strings.HasPrefix(message,"ping failed,"):
  recover("ping_failed")
 case strings.HasPrefix(message,"connect failed,") || strings.HasPrefix(message,"receive message failed,") || message=="connection is closed, receive message loop exit":
  recover("disconnected")
 default:
  changed=false
 }
 if changed { h.save() }
}

func (h *bridgeWSHealth) save() {
 h.state.UpdatedAt=h.now().UnixMilli()
 data,err:=json.Marshal(h.state); if err!=nil { return }
 if err=os.MkdirAll(filepath.Dir(h.file),0700); err!=nil { return }
 temp:=fmt.Sprintf("%s.%d.tmp",h.file,os.Getpid())
 f,err:=os.OpenFile(temp,os.O_CREATE|os.O_WRONLY|os.O_TRUNC,0600); if err!=nil { return }
 _,err=f.Write(data)
 if err==nil { err=f.Sync() }
 closeErr:=f.Close(); if err==nil { err=closeErr }
 if err==nil {
  for i:=0;i<5;i++ { err=os.Rename(temp,h.file); if err==nil { break }; time.Sleep(25*time.Millisecond) }
 }
 if err!=nil { _=os.Remove(temp) }
}
