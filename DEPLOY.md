# subsong 배포 (Kakao Cloud · GPU 컨테이너)

정렬(stable-ts large-v3) · 렌더(ffmpeg) · 웹/이미지(마브)를 **하나의 GPU 컨테이너**로
배포한다. 마브를 돌리는 GPU 노드와 같은 환경을 쓴다.

## 전제
- NVIDIA GPU 노드 (드라이버 + nvidia-container-toolkit 설치 — 마브와 동일).
- Docker.

## 1. 이미지 빌드
```bash
docker build -t subsong:latest .
```
> 베이스가 CUDA 이미지 + torch(cu124)라 처음 빌드는 수 GB 받습니다.

## 2. 실행 (GPU + 영속 볼륨)
```bash
docker run -d --name subsong --gpus all \
  -p 8010:8000 \
  -v subsong-data:/data \
  -e SUBSONG_IMAGE_PROVIDER=marv \
  -e SUBSONG_MARV_API_KEY=$INTERNAL_TOOL_API_KEY \
  subsong:latest
```
- 마브가 같은 노드 8000을 쓰면 충돌하니 호스트 포트는 **8010** 등으로.
- 첫 정렬 때 `large-v3`(~3GB)가 `/data/models`에 캐시됨(볼륨이라 재시작해도 유지).
- 업로드 음원·결과 MP4·프로젝트(`/data/projects`)도 볼륨에 영속.

## 3. 외부 노출
마브와 동일하게 **Cloudflare Named Tunnel** 로 컨테이너 포트(8010)를 도메인에 연결한다.
(또는 Kakao Cloud LB/Ingress.) 노출 후 브라우저에서 그 도메인으로 접속.

## 환경변수
| 변수 | 기본 | 설명 |
|---|---|---|
| `SUBSONG_DATA_DIR` | `/data` | 업로드·출력·프로젝트·모델 저장 루트(볼륨) |
| `SUBSONG_MODEL_DIR` | `/data/models` | whisper 모델 캐시 |
| `SUBSONG_MODEL` | `large-v3` | 정렬 모델 (`small`/`medium`로 가볍게 가능) |
| `SUBSONG_FONT` | `NanumGothic` | 자막 폰트(컨테이너에 설치됨) |
| `SUBSONG_IMAGE_PROVIDER` | `placeholder` | `marv`로 두면 실제 이미지 |
| `SUBSONG_MARV_API_KEY` | — | 마브 API 키 (`marv`일 때 필수) |
| `SUBSONG_MARV_MODEL` | `Z-Image-Turbo` | 마브 이미지 모델 |

## Kakao Container Registry(KCR) 사용 시
```bash
docker tag subsong:latest <KCR주소>/subsong:latest
docker push <KCR주소>/subsong:latest
# GPU 노드에서:
docker pull <KCR주소>/subsong:latest && docker run ... (위 2번과 동일)
```

## 점검
```bash
docker logs -f subsong          # 기동 로그
curl localhost:8010/            # 페이지
docker exec subsong nvidia-smi  # 컨테이너에서 GPU 보이는지
```

## 참고
- GPU가 안 잡히면(`nvidia-smi` 실패) 노드의 nvidia-container-toolkit 확인.
- 마브와 별개 컨테이너이므로 마브 운영에 영향 없음.
- 로컬(Windows) 개발은 기존대로 `./run.ps1`.
