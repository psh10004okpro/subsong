# subsong — AI 음악 가사 싱크 / 뮤직비디오 생성기

음성 파일과 가사를 넣으면 **자동으로 가사 타이밍을 맞춰** 주고, 어긋난 줄만
화면에서 고친 뒤 **유튜브용 MP4**로 출력하는 로컬 웹 도구.

```
음성 + 가사  →  자동 싱크(stable-ts)  →  줄 단위 수정  →  MP4 출력(ffmpeg)
```

## 요구 사항
- Python 3.10+, ffmpeg (PATH 등록)
- (권장) NVIDIA GPU — 정렬 속도 ↑

## 설치
```powershell
pip install torch --index-url https://download.pytorch.org/whl/cu121   # CUDA 빌드
pip install -r requirements.txt
```

## 실행
```powershell
./run.ps1
```
브라우저에서 <http://127.0.0.1:8765> 접속. (포트 변경: `./run.ps1 -Port 8000`)

1. **입력** — 음성 파일 + 가사(한 줄 = 자막 한 줄) → `자동 정렬 시작`
   - 첫 실행은 정렬 모델(large-v3, 약 3GB)을 내려받아 시간이 걸립니다.
   - 더 빠른 모델: `SUBSONG_MODEL=medium` 등 환경변수로 지정 가능.
2. **수정** — 노래를 들으며 어긋난 줄의 시작/끝 시간·가사를 고침. 🎯 = 현재 재생 위치 적용.
3. **출력** — 화면 비율·배경·자막 크기 선택 후 `MP4 영상 만들기`. `SRT 내보내기`도 가능.

## 구조
```
backend/
  main.py            FastAPI 서버 (API + 정적 파일)
  align.py           stable-ts 강제 정렬 → 장면 목록(JSON)
  srt.py             장면 목록 → SRT
  render.py          장면 목록 + (구간 배경) + 음악 → ffmpeg MP4
  sections.py        장면 → 구간(section) 묶기
  images.py          구간 묶기 + 이미지 생성 연결
  providers/         이미지/영상 생성기
    base.py              인터페이스
    none_provider.py     빈 구현
    placeholder_provider.py  플레이스홀더 이미지(현재 기본)
frontend/            편집기 UI (HTML/CSS/JS)
data/                업로드·출력 파일 (git 제외)
```

## 데이터 모델 — 장면 목록
모든 단계가 이 JSON 하나를 주고받는다. 1차에서는 이미지/영상 칸을 비워둔다.
```json
{ "start": 14.0, "end": 16.6, "text": "너의 이름을 불러본다",
  "image_prompt": "", "image_path": "", "video_path": "" }
```

## 2차 — 구간별 배경 이미지 (현재: 플레이스홀더)
파이프라인은 완성돼 있고, 지금은 **플레이스홀더 생성기**가 구간마다 색·라벨만
다른 이미지를 만든다. 흐름:

```
장면 → 구간 묶기(sections.py) → 구간별 이미지(images.py + providers)
     → 구간마다 배경이 바뀌는 영상(render.py)
```

- 구간 묶기: 가사의 `[Verse]`·`[Chorus]` 라벨이 있으면 그걸로, 없으면 시간 간격으로.
- UI: 출력 패널 "배경 이미지 · 구간별" → 스타일 입력 → `구간 나누기`
  → 구간별 `4장 생성` → 후보 썸네일 중 1장 클릭 선택 → `MP4 만들기`.
- 구간별 **자막 on/off** 체크박스(반복 후렴 등 자막 제외 가능).
- 관련 파일: `backend/sections.py`, `backend/images.py`,
  `backend/providers/placeholder_provider.py`, API `/api/images`(구간묶기)·`/api/candidates`(후보 N장).

### 마브 외부 API로 실제 이미지 생성
`backend/providers/marv_provider.py` 가 마브 `/v1/image`(Z-Image-Turbo)로 생성. 활성화:
```powershell
$env:SUBSONG_MARV_API_KEY = "<INTERNAL_TOOL_API_KEY>"
$env:SUBSONG_IMAGE_PROVIDER = "marv"   # 키 없으면 placeholder가 기본
./run.ps1
```

## 프로젝트 저장 / 불러오기
정렬·편집·구간 선택을 다시 안 하도록 작업 상태를 저장한다.
- UI: Step 1 상단의 프로젝트 바(목록 선택 → `불러오기`, `현재 저장`).
- 저장 위치: `data/projects/<이름>.json` (audio_id·가사·scenes·sections·설정).
- API: `POST /api/projects`, `GET /api/projects`, `GET·DELETE /api/projects/{slug}`.

### 실제 이미지 생성기로 교체하기
1. `backend/providers/base.py` 의 `ImageProvider` 를 구현 (로컬 SDXL 또는 클라우드 API)
2. `backend/providers/__init__.py` 의 `IMAGE_PROVIDERS` 에 등록
3. `SUBSONG_IMAGE_PROVIDER=<이름>` 환경변수로 기본 생성기 지정
   → 나머지(구간 묶기·합성·자막·출력) 코드는 그대로.
