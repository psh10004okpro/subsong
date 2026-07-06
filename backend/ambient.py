"""분위기(ambient) 모드 — 가사 없이 '음악 + 목적'만으로 배경 슬라이드쇼를 만든다.

가사 싱크(align)가 필요 없는 명상/공부/수면 같은 롱폼 음악용. 음원 길이를 장면 수만큼
균등 분할하고, 목적별 프리셋 프롬프트를 돌려가며 배경 이미지 프롬프트를 채운다.
실제 이미지 생성·렌더는 기존 파이프라인(images.py / render.py)을 그대로 재사용한다.
"""

# 목적별 배경 프롬프트. 슬라이드쇼가 지루하지 않도록 장면마다 다른 변주를 순환한다.
# 한글이 아니라 영어로 저장 → 어댑터(마브) 없이도 GPT-Image/나노바나나에 바로 통한다.
PRESETS = {
    "meditation": {
        "label": "명상",
        "emoji": "🧘",
        "prompts": [
            "serene misty mountain lake at dawn, soft ethereal light, calm reflective water, zen minimalism, peaceful",
            "tranquil zen garden with raked sand and smooth stones, soft morning mist, muted natural tones, meditative calm",
            "soft clouds drifting over a calm ocean horizon at sunrise, gentle pastel sky, infinite serenity, dreamy soft focus",
            "quiet forest clearing with sunbeams through fog, moss and soft green light, spiritual stillness",
            "single warm candle glow in a dark tranquil room, soft light, deep calm, minimalist meditation space",
            "endless calm desert dunes under a soft dawn sky, minimal, silent and peaceful",
        ],
    },
    "study": {
        "label": "공부",
        "emoji": "📖",
        "prompts": [
            "cozy warm study desk by a rainy window at night, soft lamp light, books and coffee, lofi aesthetic, calm focus",
            "quiet library reading nook, warm ambient light, wooden shelves, soft bokeh, peaceful concentration",
            "rainy city window with warm interior glow, blurred lights outside, calm study mood, cinematic",
            "minimal clean desk with a small plant and soft daylight, muted tones, focused calm workspace",
            "open notebook and warm tea on a wooden table, gentle window light, quiet study atmosphere",
        ],
    },
    "sleep": {
        "label": "수면",
        "emoji": "🌙",
        "prompts": [
            "dreamy starry night sky over a calm landscape, deep blue and purple, soft glowing moon, tranquil and gentle",
            "soft cloudy night with a crescent moon, muted indigo tones, peaceful dark sky, calming",
            "calm moonlit ocean at night, gentle slow waves, deep navy and silver light, serene and sleepy",
            "quiet snowfall over a peaceful village at night, warm distant lights, soft dreamy, restful",
            "gentle aurora over a still lake at night, deep calm colors, soothing and quiet",
        ],
    },
    "focus": {
        "label": "집중",
        "emoji": "🎯",
        "prompts": [
            "abstract calm gradient waves, deep blue and teal, smooth flowing shapes, minimal focus ambience",
            "minimal geometric zen composition, soft neutral tones, clean and uncluttered, deep focus",
            "aerial view of calm ocean water texture, deep blue, meditative repetitive pattern, focus",
            "soft flowing silk-like abstract in cool tones, calm and smooth, minimal concentration mood",
        ],
    },
    "cafe": {
        "label": "카페",
        "emoji": "☕",
        "prompts": [
            "cozy coffee shop interior, warm afternoon light, latte and pastries, soft bokeh, relaxing lofi cafe vibe",
            "rainy day cafe window with warm lights, plants and a wooden table, relaxed ambient mood",
            "sunlit cafe corner with plants and soft steam from coffee, warm inviting, gentle relaxation",
            "quiet bookstore cafe with warm lamps and shelves, cozy nostalgic atmosphere",
        ],
    },
    "nature": {
        "label": "자연",
        "emoji": "🌿",
        "prompts": [
            "lush green forest with a gentle waterfall, soft sunlight, misty air, natural serenity, cinematic",
            "peaceful riverside with smooth stones and clear water, green foliage, calming nature",
            "golden meadow swaying in a gentle breeze at sunset, warm light, tranquil natural beauty",
            "close up of soft rain on green leaves, fresh natural tones, soothing nature mood",
            "quiet misty valley at sunrise, rolling green hills, calm and expansive",
        ],
    },
    "lofi": {
        "label": "로파이",
        "emoji": "🎧",
        "prompts": [
            "lofi anime style cozy bedroom at night, warm desk lamp, city lights outside the window, nostalgic calm, illustrated",
            "lofi illustration of a person studying by the window on a rainy night, warm interior, chill aesthetic",
            "retro lofi city rooftop at dusk, warm purple sky, nostalgic chill vibe, anime illustration",
            "lofi cozy cafe interior at night, warm neon glow, relaxed nostalgic anime style",
        ],
    },
}

# 장면 수가 변주 개수보다 많을 때, 같은 프롬프트가 이어져도 살짝 달라지도록 붙이는 구도 변주.
_VARY = [
    "", ", wide establishing shot", ", soft close up detail", ", different composition",
    ", overhead view", ", golden hour lighting", ", cool blue hour lighting", ", gentle bokeh",
]

# 직접입력(custom) 또는 프리셋 프롬프트 공통 마감 — 화질·분위기 통일.
_TAIL = "calm, soothing, cinematic, high quality, no text, no watermark"

MAX_SCENES = 30


def _clamp_count(count) -> int:
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = 6
    return max(1, min(MAX_SCENES, count))


def _base_prompts(purpose: str, mood: str, count: int):
    """장면별 기본 프롬프트(꼬리·mood 붙이기 전) count개를 만든다."""
    mood = (mood or "").strip()
    preset = PRESETS.get(purpose)
    if preset:
        variants = preset["prompts"]
    elif mood:
        # 직접입력 — 사용자 문구를 모든 장면의 뼈대로.
        variants = [mood]
    else:
        variants = ["calm ambient background, soft light, minimal"]
    out = []
    for i in range(count):
        base = variants[i % len(variants)]
        vary = _VARY[i % len(_VARY)] if count > len(variants) else ""
        out.append(base + vary)
    return out


def _compose(base: str, purpose: str, mood: str) -> str:
    mood = (mood or "").strip()
    parts = [base]
    # 프리셋 + 직접입력 문구가 함께 오면 문구도 반영(프리셋 무드 위에 덧입힘).
    if mood and purpose in PRESETS:
        parts.append(mood)
    parts.append(_TAIL)
    return ", ".join(p for p in parts if p)


def build(duration: float, count, purpose: str = "meditation", mood: str = "", style: str = ""):
    """음원 길이 → (scenes, sections).

    scenes: 가사 없는 빈 텍스트 장면(렌더 가드/타임라인 재사용용).
    sections: 목적 프롬프트가 채워진 배경 슬롯(스탭3가 그대로 사용).
    """
    count = _clamp_count(count)
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        duration = 180.0  # ffprobe 실패 시 안전 기본값(3분). 장면 분할만을 위한 값.

    style = (style or "").strip()
    bases = _base_prompts(purpose, mood, count)
    seg = duration / count

    scenes, sections = [], []
    for i in range(count):
        start = round(i * seg, 2)
        end = round(duration if i == count - 1 else (i + 1) * seg, 2)
        prompt = _compose(bases[i], purpose, mood)
        if style:
            prompt = f"{prompt}, {style}"
        scenes.append({
            "id": i,
            "start": start,
            "end": end,
            "text": "",
            "section": "",
            "words": [],
            "image_prompt": prompt,
            "image_path": "",
            "video_path": "",
        })
        sections.append({
            "index": i,
            "label": f"장면 {i + 1}",
            "section_label": "",
            "start": start,
            "end": end,
            "scene_ids": [i],
            "lines": [],
            "image_prompt": prompt,
            "image_path": "",
            "image_id": "",
            "image_url": "",
            "subtitle": False,
        })
    return scenes, sections
