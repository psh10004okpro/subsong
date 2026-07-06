#!/usr/bin/env bash
# subsong 실행 (Linux / B200) — 브라우저에서 http://<host>:8765 접속
#   포트 변경:   ./run.sh 8000
#   GPU 지정:    SUBSONG_GPU=0 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8765}"
PY="${SUBSONG_PY:-/home/jovyan/.conda/envs/subsong/bin/python}"

# 로컬 비밀키/엔드포인트 설정. 저장소에는 올리지 않는다.
if [ -f "$PWD/.env.local" ]; then
  set -a
  . "$PWD/.env.local"
  set +a
fi

# 어떤 GPU를 쓸지 (기본 0 — 비어있는 카드). nvidia-smi 로 확인.
export CUDA_VISIBLE_DEVICES="${SUBSONG_GPU:-0}"

# 데이터/모델 캐시 위치 (업로드·출력·whisper 모델). 영속.
export SUBSONG_DATA_DIR="${SUBSONG_DATA_DIR:-$PWD/data}"
export SUBSONG_MODEL_DIR="${SUBSONG_MODEL_DIR:-$SUBSONG_DATA_DIR/models}"
mkdir -p "$SUBSONG_MODEL_DIR"

# 한글 자막 폰트 (apt fonts-nanum). 코드 기본값(Malgun Gothic)은 Windows용.
export SUBSONG_FONT="${SUBSONG_FONT:-NanumGothic}"

# 정렬 모델 — large-v3(정확·느림) / medium / small(빠름).
export SUBSONG_MODEL="${SUBSONG_MODEL:-large-v3}"

# 서브패스 배포 — avata.mindvr.co.kr/subsong 처럼 경로 아래에서 서빙.
# 루트(/)에서 서빙하려면 SUBSONG_BASE_PATH= (빈 값)으로 실행.
export SUBSONG_BASE_PATH="${SUBSONG_BASE_PATH-/subsong}"

# 이미지 생성기 — 기본은 GPT-Image-2 프록시. UI에서 프록시를 선택해 가사별 생성한다.
export SUBSONG_IMAGE_PROVIDER="${SUBSONG_IMAGE_PROVIDER:-chatgpt_proxy}"

# 의존성 확인
if ! "$PY" -c "import stable_whisper, fastapi, torch" 2>/dev/null; then
  echo "[!] 필요한 패키지가 없습니다: $PY"
  echo "    pip install torch --index-url https://download.pytorch.org/whl/cu128"
  echo "    pip install -r requirements-docker.txt"
  exit 1
fi

echo "subsong 서버 시작 → http://0.0.0.0:$PORT${SUBSONG_BASE_PATH}/  (GPU=$CUDA_VISIBLE_DEVICES, model=$SUBSONG_MODEL, provider=$SUBSONG_IMAGE_PROVIDER, base='${SUBSONG_BASE_PATH:-/}')"
exec "$PY" -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT"
