"""아바타 영상 모드 — 인물이 대본을 말하는 영상(신뢰형/실감형).

마브 외부 API(/v1)를 오케스트레이션한다:
  - 아바타 이미지 생성: POST /v1/image (Z-Image-Turbo)  [AI 아바타]
  - 대본 자동생성: A.X-4.0 LLM (story._llm 재사용)
  - 토킹헤드 영상: POST /v1/talking_head (ref_image + saved_voice_id + 대본)
  - 잡 폴링/다운로드: GET /v1/jobs/{id}, /v1/jobs/{id}/result
결과 MP4를 subsong DATA로 내려받아 그대로 보여준다(별도 렌더 없음).
"""
import json
import os
import time
import uuid

import requests

from .story import _llm  # A.X-4.0 (:8073) 재사용

BASE = os.environ.get("SUBSONG_MARV_BASE", "https://maket.mindvr.co.kr").rstrip("/")
KEY = os.environ.get("SUBSONG_MARV_API_KEY", "")

AVATAR_IMAGE_MODEL = os.environ.get("SUBSONG_AVATAR_IMAGE_MODEL", "Z-Image-Turbo")

# 용도(톤) 프리셋 — 아바타 화풍/토킹헤드 모델/감정/대본 톤을 한 번에 정한다.
TONES = {
    "trust": {
        "label": "신뢰형", "emoji": "🎤",
        "model": "daVinci-MagiHuman", "emotion": "confident",
        "avatar_prompt": "전문 한국인 아나운서, 신뢰감 있는 표정, 밝고 깔끔한 스튜디오, 카메라를 정면으로 응시, 단정한 정장",
        "script_tone": "신뢰감 있고 명확한 발표·설명 톤으로, 카메라를 보고 말하듯",
    },
    "immersive": {
        "label": "실감형", "emoji": "🎭",
        "model": "Wan 2.2 S2V", "emotion": "expressive",
        "avatar_prompt": "영화적인 사실적 한국인 인물, 감정이 담긴 표정, 드라마틱한 조명, 이야기하는 분위기",
        "script_tone": "감정이 실린 이야기·연기 톤으로, 한 사람이 들려주듯",
    },
}
DEFAULT_TONE = "trust"
# 토킹헤드 모델 선택지(UI 노출용)
TALKING_HEAD_MODELS = ["daVinci-MagiHuman", "Wan 2.2 S2V", "LongCat-Avatar"]


def _headers():
    return {"x-api-key": KEY} if KEY else {}


def _tone(tone):
    return TONES.get(tone) or TONES[DEFAULT_TONE]


# ---------- 마브 잡 공통 ----------
def _marv_wait(job_id, job=None, lo=0.1, hi=0.9, timeout=900):
    """마브 잡 완료까지 폴링. subsong job 진행률을 lo~hi 구간으로 갱신."""
    start = time.time()
    while True:
        if job is not None and job.cancelled:
            raise RuntimeError("취소됨")
        r = requests.get(f"{BASE}/v1/jobs/{job_id}", headers=_headers(), timeout=30)
        r.raise_for_status()
        d = r.json()
        st = d.get("status")
        if job is not None:
            pct = d.get("progress_pct")
            if pct is not None:
                try:
                    job.progress = lo + (hi - lo) * min(1.0, float(pct) / 100.0)
                except (TypeError, ValueError):
                    pass
        if st == "finished":
            return d
        if st == "failed":
            raise RuntimeError(d.get("error") or "마브 잡 실패")
        if time.time() - start > timeout:
            raise RuntimeError("마브 잡 시간 초과")
        time.sleep(3)


def _marv_download(job_id, out_dir, ext):
    r = requests.get(f"{BASE}/v1/jobs/{job_id}/result", headers=_headers(), timeout=180)
    r.raise_for_status()
    name = uuid.uuid4().hex + ext
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(r.content)
    return name


def list_voices():
    """마브 저장 보이스 목록 → [{key,label}]."""
    try:
        r = requests.get(f"{BASE}/v1/voices", headers=_headers(), timeout=15)
        r.raise_for_status()
        d = r.json()
        items = d if isinstance(d, list) else d.get("voices", d.get("items", []))
        out = []
        for v in items:
            vid = v.get("voice_id") or v.get("id")
            if vid:
                out.append({"key": vid, "label": v.get("name") or vid})
        return out
    except Exception:
        return []


# ---------- 대본 · 아바타 이미지 ----------
def generate_script(topic, tone, length_sec=20):
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("주제를 입력하세요.")
    t = _tone(tone)
    prompt = (
        f"'{topic}' 주제로 {t['script_tone']} 약 {length_sec}초 분량의 한국어 대본을 쓰세요.\n"
        "- 화자가 카메라를 보고 말하는 1인칭 대사.\n"
        "- 소리 내어 읽기 좋게 짧고 자연스러운 문장.\n"
        "- 제목·지문·따옴표 없이 실제 말하는 대사 본문만 출력."
    )
    return _llm([{"role": "user", "content": prompt}], max_tokens=600, temperature=0.8).strip()


def generate_avatar_image(description, tone, out_dir, job=None):
    """설명 → 마브 이미지 생성 → subsong DATA에 저장 → image_id."""
    t = _tone(tone)
    desc = (description or "").strip()
    prompt = f"{t['avatar_prompt']}, {desc}" if desc else t["avatar_prompt"]
    if job is not None:
        job.message = "아바타 이미지 생성 중"; job.progress = 0.1
    r = requests.post(
        f"{BASE}/v1/image", headers=_headers(),
        data={"model": AVATAR_IMAGE_MODEL, "prompt_ko": prompt,
              "params_json": json.dumps({"aspect": "9:16", "no_text": True})},
        timeout=60,
    )
    r.raise_for_status()
    jid = r.json()["job_id"]
    _marv_wait(jid, job=job, lo=0.15, hi=0.9, timeout=300)
    if job is not None:
        job.message = "이미지 내려받는 중"; job.progress = 0.95
    return _marv_download(jid, out_dir, ".png")


# ---------- 토킹헤드 영상 ----------
def build(portrait_path, script, voice_id, tone, out_dir, model=None, job=None):
    """아바타 이미지 + 대본 + 보이스 → 말하는 영상 MP4. video_id 반환."""
    script = (script or "").strip()
    if not script:
        raise ValueError("대본이 비어 있습니다.")
    if not portrait_path or not os.path.exists(portrait_path):
        raise ValueError("아바타 이미지가 없습니다.")
    t = _tone(tone)
    model = model or t["model"]
    dur = max(5, min(90, round(len(script) / 4)))  # 한국어 낭독 대략 4자/초

    if job is not None:
        job.message = "아바타 영상 생성 요청"; job.progress = 0.05
    data = {
        "model": model, "prompt_ko": script,
        "duration_s": str(dur), "emotion": t["emotion"],
        "params_json": json.dumps({}),
    }
    if voice_id:
        data["saved_voice_id"] = voice_id
    with open(portrait_path, "rb") as fh:
        files = {"ref_image": (os.path.basename(portrait_path), fh, "image/png")}
        r = requests.post(f"{BASE}/v1/talking_head", headers=_headers(),
                          data=data, files=files, timeout=120)
    r.raise_for_status()
    jid = r.json()["job_id"]

    if job is not None:
        job.message = "마브에서 아바타 영상 생성 중(1~3분)"; job.progress = 0.1
    _marv_wait(jid, job=job, lo=0.1, hi=0.92, timeout=1200)
    if job is not None:
        job.message = "영상 내려받는 중"; job.progress = 0.95
    vid = _marv_download(jid, out_dir, ".mp4")
    if job is not None:
        job.message = "완료"; job.progress = 1.0
    return vid
