"""스토리(이야기) 모드 — 대본 → 나레이션 TTS + 장면별 이미지 → 자막 영상.

로컬 서비스 재사용:
  - 나레이션: VoxCPM TTS (POST http://127.0.0.1:8071/tts {text,ref} -> {wav,audio})
  - 대본 생성 / 장면 이미지 프롬프트: A.X-4.0 LLM (OpenAI 호환, :8073, model=ax4)
문장 단위로 나눠 문장별 TTS 길이로 자막 타이밍을 정확히 계산한다(whisper 불필요).
이미지 생성·렌더는 기존 파이프라인을 그대로 쓴다(자막 ON).
"""
import json
import os
import re
import subprocess
import uuid

import requests

TTS_URL = os.environ.get("SUBSONG_TTS_URL", "http://127.0.0.1:8071/tts")
LLM_URL = os.environ.get("SUBSONG_LLM_URL", "http://127.0.0.1:8073/v1/chat/completions")
LLM_MODEL = os.environ.get("SUBSONG_LLM_MODEL", "ax4")

MAX_SEGMENTS = 40
GAP = 0.45  # 문장 사이 숨쉬는 무음(초)

VOICE_DIR = "/home/jovyan/SoulX-FlashHead/examples/voices"
VOICES = {
    "warm_f":    {"label": "따뜻한 여성", "ref": f"{VOICE_DIR}/design_warm_f.wav"},
    "natural_f": {"label": "자연스러운 여성", "ref": f"{VOICE_DIR}/design_natural_f.wav"},
    "calm_f":    {"label": "차분한 여성", "ref": f"{VOICE_DIR}/clone_counselor30s.wav"},
    "korean":    {"label": "표준 한국어", "ref": f"{VOICE_DIR}/clone_koreantest.wav"},
}
DEFAULT_VOICE = "warm_f"

GENRES = {
    "yadam":     {"label": "야담", "emoji": "🏺",
                  "style": "traditional Korean folk tale illustration, Joseon dynasty, hanok village, ink wash painting, atmospheric, muted earth tones",
                  "tone": "구전 야담처럼 예스럽고 흥미진진하게"},
    "history":   {"label": "역사", "emoji": "📜",
                  "style": "historical realistic illustration, period-accurate costumes and architecture, cinematic documentary style, dramatic lighting",
                  "tone": "역사적 사건을 사실적이고 극적으로"},
    "mystery":   {"label": "미스터리", "emoji": "🔍",
                  "style": "dark moody mystery scene, film noir, dramatic shadows, suspenseful atmosphere, muted cold tones",
                  "tone": "긴장감 있고 서서히 조여오는 미스터리로"},
    "horror":    {"label": "공포", "emoji": "👻",
                  "style": "eerie horror atmosphere, dark and unsettling, creepy, foggy, dramatic low-key lighting, desaturated",
                  "tone": "서늘하고 오싹한 공포 분위기로"},
    "legend":    {"label": "전설", "emoji": "🐉",
                  "style": "mythical legend illustration, epic fantasy atmosphere, mystical light, dramatic landscape, painterly",
                  "tone": "웅장한 전설처럼 신비롭게"},
    "fairytale": {"label": "동화", "emoji": "📖",
                  "style": "warm storybook illustration, whimsical fairytale style, soft colors, gentle and charming, children's book art",
                  "tone": "따뜻하고 다정한 동화체로"},
    "scifi":     {"label": "SF", "emoji": "🚀",
                  "style": "science fiction concept art, futuristic, cinematic sci-fi lighting, highly detailed, atmospheric",
                  "tone": "상상력 넘치는 SF로"},
    "knowledge": {"label": "지식", "emoji": "💡",
                  "style": "clean informative illustration, modern flat editorial style, clear and engaging, documentary mood",
                  "tone": "쉽고 명료하게 설명하듯"},
}
DEFAULT_STYLE = "cinematic illustration, atmospheric, high quality"
_TAIL = "cinematic, atmospheric, highly detailed, high quality, no text, no watermark"


def voice_ref(voice: str) -> str:
    v = VOICES.get(voice) or VOICES[DEFAULT_VOICE]
    ref = v["ref"]
    return ref if os.path.exists(ref) else ""


def _genre_style(genre: str, custom: str = "") -> str:
    custom = (custom or "").strip()
    g = GENRES.get(genre)
    if g:
        # 프리셋 장르 + 추가 분위기/화풍(있으면 덧붙임).
        return f"{g['style']}, {custom}" if custom else g["style"]
    # 직접(custom) 장르 — 입력 문구가 화풍의 뼈대.
    return custom or DEFAULT_STYLE


# ---------- LLM ----------
def _llm(messages, max_tokens=1200, temperature=0.8, timeout=90) -> str:
    r = requests.post(
        LLM_URL,
        json={"model": LLM_MODEL, "messages": messages,
              "max_tokens": max_tokens, "temperature": temperature},
        timeout=timeout,
    )
    r.raise_for_status()
    return (r.json()["choices"][0]["message"]["content"] or "").strip()


def generate_script(topic: str, genre: str, length_sec: int = 60) -> str:
    """주제 → 나레이션용 한국어 이야기 대본(본문만)."""
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("주제를 입력하세요.")
    g = GENRES.get(genre)
    tone = g["tone"] if g else "흥미롭게"
    # 대략 1초에 3~4자 낭독 → 문장 수 가늠(하한/상한).
    n_sent = max(5, min(30, round(length_sec / 5)))
    prompt = (
        f"당신은 유튜브 이야기 채널 작가입니다. 주제 '{topic}'로 {tone} "
        f"약 {length_sec}초 분량(대략 {n_sent}문장)의 한국어 이야기를 쓰세요.\n"
        "규칙:\n"
        "- 나레이션으로 소리 내어 읽기 좋게, 한 문장은 짧고 명확하게.\n"
        "- 도입-전개-반전/결말 흐름. 몰입되는 첫 문장으로 시작.\n"
        "- 제목·머리말·해설·괄호 없이 이야기 본문만 출력.\n"
        "- 각 문장은 마침표로 끝나고, 한 줄에 한 문장씩."
    )
    text = _llm([{"role": "user", "content": prompt}], max_tokens=1400, temperature=0.9)
    # 혹시 남는 머리말/따옴표 정리
    text = re.sub(r"^\s*(제목|title)\s*[:：].*$", "", text, flags=re.I | re.M)
    return text.strip()


def split_segments(text: str):
    """대본 → 자막/장면 단위 문장 리스트."""
    text = (text or "").replace("\r", "")
    # 줄바꿈과 문장부호(. ! ? 。 …) 기준 분할, 구분자 유지.
    raw = re.split(r"(?<=[.!?。…])\s+|\n+", text)
    segs = []
    for s in raw:
        s = " ".join(s.split()).strip()
        if not s:
            continue
        # 너무 길면(60자+) 쉼표에서 한 번 쪼갠다.
        if len(s) > 60 and ("," in s or "，" in s):
            parts = re.split(r"[,，]\s*", s)
            buf = ""
            for p in parts:
                if len(buf) + len(p) > 60 and buf:
                    segs.append(buf.strip()); buf = p
                else:
                    buf = f"{buf}, {p}" if buf else p
            if buf.strip():
                segs.append(buf.strip())
        else:
            segs.append(s)
    return segs[:MAX_SEGMENTS]


def visual_prompts(segments, genre: str, custom_style: str = ""):
    """문장 리스트 → 장면별 영어 이미지 프롬프트(LLM). 실패 시 장르스타일+문장 폴백."""
    style = _genre_style(genre, custom_style)
    n = len(segments)
    fallback = [f"{style}, {s}, {_TAIL}" for s in segments]
    try:
        numbered = "\n".join(f"{i+1}. {s}" for i, s in enumerate(segments))
        prompt = (
            "다음은 한국어 이야기의 문장들입니다. 각 문장에 어울리는 '배경 장면'을 "
            "영어 이미지 프롬프트로 한 줄씩 만들어 주세요. 인물 얼굴 클로즈업보다 "
            "장면·분위기·배경 위주로. 텍스트/글자는 넣지 마세요.\n"
            f"공통 화풍: {style}\n"
            f"출력은 JSON 문자열 배열로만, 정확히 {n}개. 예: [\"...\", \"...\"]\n\n"
            f"문장:\n{numbered}"
        )
        out = _llm([{"role": "user", "content": prompt}], max_tokens=1600, temperature=0.6)
        m = re.search(r"\[.*\]", out, re.S)
        arr = json.loads(m.group(0)) if m else None
        if isinstance(arr, list) and arr:
            res = []
            for i in range(n):
                p = str(arr[i]).strip() if i < len(arr) else ""
                res.append(f"{p}, {style}, {_TAIL}" if p else fallback[i])
            return res
    except Exception:
        pass
    return fallback


# ---------- TTS ----------
def _tts_one(text: str, ref: str, timeout=120):
    payload = {"text": text}
    if ref:
        payload["ref"] = ref
    r = requests.post(TTS_URL, json=payload, timeout=timeout)
    r.raise_for_status()
    d = r.json()
    if "wav" not in d or not os.path.exists(d["wav"]):
        raise RuntimeError(d.get("error", "TTS 실패"))
    return d["wav"], float(d.get("audio") or 0.0)


def _concat_with_gaps(seg_wavs, gap, out_path):
    """문장 wav들을 gap 무음을 끼워 이어붙인 오디오 하나로."""
    n = len(seg_wavs)
    cmd = ["ffmpeg", "-y"]
    for w in seg_wavs:
        cmd += ["-i", w]
    parts = [f"[{i}:a]apad=pad_dur={gap}[a{i}]" for i in range(n)]
    fc = ";".join(parts) + ";" + "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]"
    cmd += ["-filter_complex", fc, "-map", "[out]",
            "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
            "-loglevel", "error", out_path]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def build(text, genre, voice, out_dir, custom_style="", job=None):
    """대본 → (audio_id, scenes, sections). job이 있으면 진행률/메시지 갱신."""
    segments = split_segments(text)
    if not segments:
        raise ValueError("이야기 내용이 비어 있습니다.")
    ref = voice_ref(voice)

    # 1) 문장별 나레이션 TTS (진행률의 대부분)
    seg_wavs, durations, kept = [], [], []
    for i, seg in enumerate(segments):
        if job is not None and job.cancelled:
            raise RuntimeError("취소됨")
        if job is not None:
            job.message = f"나레이션 생성 {i+1}/{len(segments)}"
            job.progress = 0.05 + 0.70 * (i / max(1, len(segments)))
        try:
            wav, dur = _tts_one(seg, ref)
        except Exception:
            continue  # 한 문장 실패는 건너뛰고 진행
        if dur <= 0:
            continue
        seg_wavs.append(wav); durations.append(dur); kept.append(seg)
    if not seg_wavs:
        raise RuntimeError("나레이션 생성에 모두 실패했습니다. TTS 서비스를 확인하세요.")

    # 2) 오디오 합치기
    if job is not None:
        job.message = "나레이션 합치는 중"; job.progress = 0.78
    audio_id = uuid.uuid4().hex + ".m4a"
    _concat_with_gaps(seg_wavs, GAP, os.path.join(out_dir, audio_id))

    # 3) 장면 이미지 프롬프트(LLM)
    if job is not None:
        job.message = "장면 이미지 프롬프트 작성 중"; job.progress = 0.88
    prompts = visual_prompts(kept, genre, custom_style)

    # 4) scenes/sections 조립 (문장 길이로 정확한 타이밍)
    scenes, sections = [], []
    t = 0.0
    for i, (seg, dur, prm) in enumerate(zip(kept, durations, prompts)):
        start = round(t, 2)
        end = round(t + dur, 2)
        scenes.append({
            "id": i, "start": start, "end": end, "text": seg, "section": "",
            "words": [], "image_prompt": prm, "image_path": "", "video_path": "",
        })
        sections.append({
            "index": i, "label": (seg[:24] + ("…" if len(seg) > 24 else "")),
            "section_label": "", "start": start, "end": end, "scene_ids": [i],
            "lines": [seg], "image_prompt": prm,
            "image_path": "", "image_id": "", "image_url": "", "subtitle": True,
        })
        t = end + GAP
    if job is not None:
        job.message = "완료"; job.progress = 1.0
    return audio_id, scenes, sections
