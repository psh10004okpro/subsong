"""음성 + 가사 → 장면 목록(scene list) 자동 정렬.

stable-ts의 강제 정렬(align)을 사용한다. 사용자가 준 가사의 줄바꿈을
그대로 자막 분할 단위로 쓰기 위해 original_split=True 로 호출한다.
즉 "가사 한 줄 = 장면 하나"가 되고, 시간은 모델이 음성을 듣고 채운다.
"""
import os
import re

_model = None
_MODEL_NAME = os.environ.get("SUBSONG_MODEL", "large-v3")

# [Intro], [Verse 1], [Chorus] 같은 구조 표시줄 — 불리지 않으므로 정렬에서 제외.
_SECTION_RE = re.compile(r"^\[.*\]$")


def get_model():
    """모델을 한 번만 로드해서 재사용한다(GPU 자동 사용)."""
    global _model
    if _model is None:
        try:
            import stable_whisper
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "stable-ts가 설치되어 있지 않습니다. "
                "`pip install -r requirements.txt` 실행 후 다시 시도하세요."
            ) from exc
        kwargs = {}
        model_dir = os.environ.get("SUBSONG_MODEL_DIR")
        if model_dir:
            kwargs["download_root"] = model_dir  # 모델을 영속 볼륨에 캐시
        _model = stable_whisper.load_model(_MODEL_NAME, **kwargs)
    return _model


def _scene(idx, start, end, text, section="", words=None):
    return {
        "id": idx,
        "start": round(float(start), 2),
        "end": round(float(end), 2),
        "text": text,
        "section": section,  # [Verse 1] 같은 구간 라벨 (이미지 묶기에 사용)
        "words": words or [],  # 단어별 타이밍 (ASS 노래방 하이라이트에 사용)
        # --- 2차(이미지/영상 API)에서 채워질 빈 칸 ---
        "image_prompt": "",
        "image_path": "",
        "video_path": "",
    }


def align(audio_path: str, lyrics: str, language: str = "ko"):
    """오디오와 가사를 받아 장면 목록을 반환한다."""
    model = get_model()

    # [구조 표시줄]은 구간 라벨로만 쓰고 자막에서 제외. 빈 줄도 제외.
    # 살아남는 줄마다 직전 [헤더]를 구간 라벨로 붙여 둔다.
    pairs = []  # (가사 줄, 구간 라벨)
    current = ""
    for ln in lyrics.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if _SECTION_RE.match(ln):
            current = ln[1:-1].strip()
            continue
        pairs.append((ln, current))
    if not pairs:
        return []

    text = "\n".join(t for t, _ in pairs)
    result = model.align(audio_path, text, language=language, original_split=True)

    scenes = []
    for i, seg in enumerate(getattr(result, "segments", [])):
        line = (seg.text or "").strip()
        if not line:
            continue
        section = pairs[i][1] if i < len(pairs) else ""
        words = []
        for w in (getattr(seg, "words", None) or []):
            wt = (getattr(w, "word", "") or "").strip()
            if not wt:
                continue
            words.append({
                "w": wt,
                "start": round(float(w.start), 2),
                "end": round(float(w.end), 2),
            })
        scenes.append(_scene(len(scenes), seg.start, seg.end, line, section, words))
    return scenes
