#!/usr/bin/env bash
# subsong 외부 노출 — Cloudflare 터널.
#
# 고정 주소(Named Tunnel)는 Cloudflare 계정 + 본인 도메인이 필요합니다.
# 헤드리스 서버에서는 "토큰 방식"(remotely-managed)이 가장 간단합니다:
#   Cloudflare Zero Trust 대시보드 → Networks → Tunnels → Create →
#   Public hostname 을 subsong.<도메인> = http://localhost:8765 로 지정 →
#   표시되는 토큰을 복사해 아래처럼 실행.
#
# 사용:
#   고정 주소(토큰):  CF_TUNNEL_TOKEN="ey..." ./cf-tunnel.sh
#   고정 주소(로그인): ./cf-tunnel.sh login    # 브라우저 인증 후 named tunnel 생성 안내
#   임시 주소(테스트): ./cf-tunnel.sh quick     # 랜덤 *.trycloudflare.com (재시작마다 바뀜)
set -euo pipefail
cd "$(dirname "$0")"

CFD="${CLOUDFLARED:-/home/jovyan/AvatarForcing/cloudflared}"
PORT="${SUBSONG_PORT:-8765}"
LOG="$PWD/data/cf.log"
mkdir -p "$PWD/data"
[[ -x "$CFD" ]] || { echo "[!] cloudflared 없음: $CFD"; exit 1; }

MODE="${1:-token}"
[[ -n "${CF_TUNNEL_TOKEN:-}" && "$MODE" == "token" ]] || true

case "$MODE" in
  token)
    # 토큰 우선순위: 환경변수 > 저장 파일(data/.cf_token, 600).
    TOKFILE="$PWD/data/.cf_token"
    if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
      ( umask 077; printf '%s' "$CF_TUNNEL_TOKEN" > "$TOKFILE" )   # 재시작용으로 안전 저장
    elif [[ -s "$TOKFILE" ]]; then
      CF_TUNNEL_TOKEN="$(cat "$TOKFILE")"
    else
      echo "[!] 토큰이 없습니다. 고정 주소를 쓰려면:"
      echo "    CF_TUNNEL_TOKEN=\"<대시보드 토큰>\" ./cf-tunnel.sh"
      echo "    (또는 임시 주소: ./cf-tunnel.sh quick)"
      exit 1
    fi
    echo "subsong → Cloudflare Named Tunnel (token) · localhost:$PORT"
    # 토큰을 명령행 인자(world-readable /proc/PID/cmdline) 대신 TUNNEL_TOKEN 환경변수로 전달.
    TUNNEL_TOKEN="$CF_TUNNEL_TOKEN" nohup "$CFD" tunnel --no-autoupdate run \
      > "$LOG" 2>&1 &
    echo "  pid $! · 로그: $LOG · 토큰저장: $TOKFILE (600)"
    echo "  공개 주소는 대시보드에서 지정한 hostname 입니다 (예: https://subsong.<도메인>)."
    ;;
  login)
    echo "1) 브라우저 인증 (도메인 선택):"
    echo "     $CFD tunnel login"
    echo "2) 터널 생성:        $CFD tunnel create subsong"
    echo "3) DNS 라우팅:       $CFD tunnel route dns subsong subsong.<도메인>"
    echo "4) 실행:             nohup $CFD tunnel --no-autoupdate run \\"
    echo "                       --url http://localhost:$PORT subsong > $LOG 2>&1 &"
    ;;
  quick)
    echo "subsong → Cloudflare quick tunnel (임시 랜덤 주소) · localhost:$PORT"
    nohup "$CFD" tunnel --no-autoupdate --url "http://localhost:$PORT" \
      > "$LOG" 2>&1 &
    echo "  pid $! · 로그: $LOG"
    echo "  잠시 뒤 아래에 표시되는 https://*.trycloudflare.com 주소로 접속:"
    ;;
  *) echo "사용: ./cf-tunnel.sh [token|login|quick]"; exit 1 ;;
esac
