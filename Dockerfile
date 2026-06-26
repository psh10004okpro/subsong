# subsong — GPU 컨테이너 (가사 정렬 large-v3 + ffmpeg 렌더 + 웹/이미지)
# Kakao Cloud 등 NVIDIA GPU 노드에서 `--gpus all` 로 실행.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 시스템 의존: 파이썬, ffmpeg, 한글 폰트(자막), opencv-headless 런타임
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        ffmpeg fontconfig fonts-nanum fonts-noto-cjk libglib2.0-0 \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch 는 CUDA(cu124) 빌드로 먼저 설치 (캐시 효율)
RUN pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu124
COPY requirements-docker.txt .
RUN pip3 install --no-cache-dir -r requirements-docker.txt

COPY backend ./backend
COPY frontend ./frontend

# 영속 볼륨(/data): 업로드·출력·프로젝트·모델 캐시. 한글 자막 폰트=NanumGothic.
ENV SUBSONG_DATA_DIR=/data \
    SUBSONG_MODEL_DIR=/data/models \
    SUBSONG_FONT=NanumGothic \
    SUBSONG_MODEL=large-v3 \
    SUBSONG_IMAGE_PROVIDER=placeholder
VOLUME ["/data"]
EXPOSE 8000

CMD ["python3", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
