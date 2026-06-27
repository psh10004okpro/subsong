"""장면 목록 → ASS 자막.

- 단어별 타이밍(words)이 있으면 \\kf 노래방 하이라이트(부르는 단어가 채워짐).
- 없으면 정적 한 줄.
- 스타일은 프리셋(색/외곽선/위치/하이라이트색)으로 선택. 폰트·크기는 렌더가 전달.

ASS 색은 &HAABBGGRR (AA=알파, 00=불투명, BGR 순서).
"""

# 프리셋: primary=하이라이트(부른 단어), secondary=기본(아직 안 부른 단어)
PRESETS = {
    "ballad": {
        "label": "발라드", "primary": "FFE08A", "secondary": "FFFFFF",
        "outline": "101010", "outline_w": 2, "shadow": 1, "margin_v": 70, "karaoke": True,
    },
    "kpop": {
        "label": "K-pop", "primary": "FF5FA2", "secondary": "FFFFFF",
        "outline": "101010", "outline_w": 3, "shadow": 1, "margin_v": 80, "karaoke": True,
    },
    "citypop": {
        "label": "시티팝", "primary": "7DE0FF", "secondary": "FFF4E0",
        "outline": "201430", "outline_w": 2, "shadow": 1, "margin_v": 70, "karaoke": True,
    },
    "simple": {
        "label": "심플", "primary": "FFFFFF", "secondary": "FFFFFF",
        "outline": "000000", "outline_w": 2, "shadow": 1, "margin_v": 60, "karaoke": False,
    },
}
DEFAULT_PRESET = "ballad"


def _ass_color(hex_rgb, alpha="00"):
    h = (hex_rgb or "FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha}{b}{g}{r}".upper()


def _ts(t):
    t = max(0.0, float(t))
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _wstart(wd):
    try:
        return float(wd.get("start"))
    except (TypeError, ValueError):
        return None


def _karaoke(words, scene_start, scene_end):
    out = []
    first = _wstart(words[0])
    lead = int(round(((first if first is not None else scene_start) - scene_start) * 100))
    if lead > 0:
        out.append(f"{{\\k{lead}}}")
    n = len(words)
    for i, wd in enumerate(words):
        ws = _wstart(wd)
        if ws is None:
            ws = scene_start
        if i + 1 < n:
            nxt = _wstart(words[i + 1])
            if nxt is None:
                nxt = ws
        else:
            we = wd.get("end")
            nxt = float(we) if we is not None else scene_end
        dur = max(1, int(round((nxt - ws) * 100)))
        token = str(wd.get("w", "")).replace("{", "").replace("}", "").replace("\n", " ")
        out.append(f"{{\\kf{dur}}}{token} ")
    return "".join(out).strip()


# 자막 세로 위치 → (ASS Alignment, MarginV)
_POSITIONS = {
    "bottom": (2, None),   # 하단 중앙 (MarginV=프리셋값, 아래에서)
    "middle": (5, 0),      # 화면 중앙
    "top": (8, None),      # 상단 중앙 (MarginV=프리셋값, 위에서)
}


def build_ass(scenes, w, h, preset=DEFAULT_PRESET, font="Malgun Gothic",
              font_size=48, position="bottom"):
    p = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    primary = _ass_color(p["primary"])
    secondary = _ass_color(p["secondary"])
    outline = _ass_color(p["outline"])
    size = int(font_size or 48)
    ow, sh = p["outline_w"], p["shadow"]
    align, mv_override = _POSITIONS.get(position, _POSITIONS["bottom"])
    mv = p["margin_v"] if mv_override is None else mv_override

    # Style K: 노래방(primary=하이라이트). Style P: 정적(전체 기본색).
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n"
        "WrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: K,{font},{size},{primary},{secondary},{outline},&H64000000,0,0,0,0,"
        f"100,100,0,0,1,{ow},{sh},{align},60,60,{mv},1\n"
        f"Style: P,{font},{size},{secondary},{secondary},{outline},&H64000000,0,0,0,0,"
        f"100,100,0,0,1,{ow},{sh},{align},60,60,{mv},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    events = []
    for sc in scenes:
        text = (sc.get("text") or "").strip()
        if not text:
            continue
        start = float(sc["start"])
        end = float(sc["end"])
        if end <= start:
            end = start + 0.5
        words = sc.get("words") or []
        if p["karaoke"] and words:
            body, style = _karaoke(words, start, end), "K"
        else:
            body, style = text.replace("{", "").replace("}", ""), "P"
        events.append(
            f"Dialogue: 0,{_ts(start)},{_ts(end)},{style},,0,0,0,,{body}"
        )

    return header + "\n".join(events) + "\n"
