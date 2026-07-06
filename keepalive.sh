#!/usr/bin/env bash
# subsong + Cloudflare 터널 자동복구 감시자.
# 30초마다: subsong(8765) 와 named-tunnel 커넥터가 살아있는지 확인, 죽었으면 재기동.
# 이 컨테이너엔 systemd/cron 이 없어 nohup 으로 상주. (전체 재부팅까지는 못 살림 —
#  컨테이너 재시작 시엔 이 스크립트를 다시 ./keepalive.sh & 로 띄워야 함.)
#
#   시작:  nohup ./keepalive.sh > data/keepalive.out 2>&1 &
#   중지:  touch data/keepalive.stop   (다음 루프에서 종료)
set -u
cd "$(dirname "$0")"
DIR="$PWD"
PORT="${SUBSONG_PORT:-8765}"
BASE="${SUBSONG_BASE_PATH-/subsong}"   # 서브패스 배포 시 헬스체크도 그 경로로
LOG="$DIR/data/keepalive.log"
STOP="$DIR/data/keepalive.stop"
mkdir -p "$DIR/data"; rm -f "$STOP"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }

is_subsong_up(){
  local c
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT${BASE}/")
  [[ "$c" =~ ^[23] ]]   # 2xx/3xx면 정상(서브패스 인덱스 응답)
}
# named tunnel(토큰 run, --url 없음) 커넥터 — 옛 quick tunnel(--url)과 구분.
is_tunnel_up(){ pgrep -f "cloudflared tunnel --no-autoupdate run" >/dev/null 2>&1; }

start_subsong(){
  log "subsong DOWN → 재기동"
  CUDA_VISIBLE_DEVICES="${SUBSONG_GPU:-0}" nohup "$DIR/run.sh" "$PORT" \
    >> "$DIR/data/subsong.out" 2>&1 &
}
start_tunnel(){
  log "tunnel DOWN → 재기동 (token)"
  "$DIR/cf-tunnel.sh" token >> "$DIR/data/cf-restart.out" 2>&1 || true
}

log "keepalive 시작 (pid $$)"
while true; do
  [[ -e "$STOP" ]] && { log "stop 신호 → 종료"; rm -f "$STOP"; exit 0; }
  is_subsong_up || start_subsong
  is_tunnel_up  || start_tunnel
  sleep 30
done
