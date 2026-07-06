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


def _safe_font(font):
    """사용자가 고른 폰트명을 ASS Style 라인(콤마 구분)에 안전하게 — 콤마·중괄호·개행 제거."""
    f = (font or "Malgun Gothic")
    for ch in (",", "{", "}", "\n", "\r"):
        f = f.replace(ch, " ")
    return f.strip() or "Malgun Gothic"


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


def _plain_text(text):
    """ASS 본문용 일반 자막 텍스트. 사용자가 넣은 줄바꿈은 명시 줄바꿈으로 유지한다."""
    return (
        str(text or "")
        .replace("{", "")
        .replace("}", "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", r"\N")
    )


def _clean_title(text):
    return (text or "").strip().replace("{", "").replace("}", "").replace("\n", " ")


# 자막 세로 위치 → MarginV. ASS Alignment는 가로 정렬과 조합해 계산한다.
_POSITIONS = {
    "bottom": None,   # MarginV=프리셋값, 아래에서
    "middle": 0,      # 화면 중앙
    "top": None,      # MarginV=프리셋값, 위에서
}


def _alignment(position, text_align):
    horiz = 1 if text_align == "left" else 2
    base = {"bottom": 0, "middle": 3, "top": 6}.get(position, 0)
    return base + horiz


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _subtitle_pos(w, h, position, text_align, margin_h, margin_v, offset_x, offset_y):
    x = margin_h if text_align == "left" else w / 2
    if position == "middle":
        y = h / 2
    elif position == "top":
        y = margin_v
    else:
        y = h - margin_v
    x += offset_x
    y += offset_y
    return int(round(x)), int(round(y))


def build_ass(scenes, w, h, preset=DEFAULT_PRESET, font="Malgun Gothic",
              font_size=48, position="bottom", intro_title="", intro_title_dur=3.0,
              outro_title="", outro_title_dur=3.0, total_duration=0.0,
              text_color="", hi_color="", outline_color="", text_align="center",
              offset_x=0.0, offset_y=0.0,
              karaoke_enabled=False, render_scale=1.0):
    p = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    font = _safe_font(font)
    try:
        scale = max(0.1, float(render_scale or 1.0))
    except (TypeError, ValueError):
        scale = 1.0
    # 사용자가 직접 고른 색이 있으면 프리셋 위에 덮어쓴다(취향 커스텀).
    primary = _ass_color(hi_color or p["primary"])      # 부르는(강조) 단어
    secondary = _ass_color(text_color or p["secondary"])  # 기본 글자색
    outline = _ass_color(outline_color or p["outline"])
    size = max(12, int(round((font_size or 48) * scale)))
    ow = max(1, int(round(p["outline_w"] * scale)))
    sh = max(0, int(round(p["shadow"] * scale)))
    text_align = "left" if text_align == "left" else "center"
    mv_override = _POSITIONS.get(position, _POSITIONS["bottom"])
    align = _alignment(position, text_align)
    mv_base = p["margin_v"] if mv_override is None else mv_override
    mv = max(0, int(round(mv_base * scale)))
    mh = max(20, int(round(60 * scale)))
    ox = _num(offset_x) * scale
    oy = _num(offset_y) * scale
    pos_x, pos_y = _subtitle_pos(w, h, position, text_align, mh, mv, ox, oy)
    sub_pos_tag = f"{{\\an{align}\\pos({pos_x},{pos_y})}}"

    # Style K: 노래방(primary=하이라이트). Style P: 정적(전체 기본색). T: 타이틀 카드(중앙·대형).
    title = _clean_title(intro_title)
    outro = _clean_title(outro_title)
    title_size = max(size + max(12, int(round(28 * scale))), int(h * 0.075))
    title_style = (
        f"Style: T,{font},{title_size},{secondary},{secondary},{outline},&H64000000,1,0,0,0,"
        f"100,100,0,0,1,{ow + 1},{sh},5,{mh},{mh},0,1\n"
    ) if (title or outro) else ""

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n"
        # WrapStyle 0: 긴 줄을 화면 폭(여백 제외)에 맞춰 자동 줄바꿈 → 가로 오버플로 방지.
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: K,{font},{size},{primary},{secondary},{outline},&H64000000,0,0,0,0,"
        f"100,100,0,0,1,{ow},{sh},{align},{mh},{mh},{mv},1\n"
        f"Style: P,{font},{size},{secondary},{secondary},{outline},&H64000000,0,0,0,0,"
        f"100,100,0,0,1,{ow},{sh},{align},{mh},{mh},{mv},1\n"
        f"{title_style}\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    title_dur = max(0.5, float(intro_title_dur or 3.0)) if title else 0.0
    total_duration = max(0.0, float(total_duration or 0.0))
    outro_dur = max(0.5, float(outro_title_dur or 3.0)) if outro and total_duration else 0.0
    outro_start = max(0.0, total_duration - outro_dur) if outro_dur else 0.0
    events = []
    if title:
        fade = min(900, int(title_dur * 1000 / 3))  # 페이드 인/아웃(ms)
        events.append(
            f"Dialogue: 5,{_ts(0)},{_ts(title_dur)},T,,0,0,0,,{{\\fad({fade},{fade})}}{title}"
        )
    if outro_dur:
        fade = min(900, int(outro_dur * 1000 / 3))
        events.append(
            f"Dialogue: 5,{_ts(outro_start)},{_ts(total_duration)},T,,0,0,0,,{{\\fad({fade},{fade})}}{outro}"
        )
    for sc in scenes:
        text = (sc.get("text") or "").strip()
        if not text:
            continue
        start = float(sc["start"])
        end = float(sc["end"])
        if end <= start:
            end = start + 0.5
        # 타이틀 카드가 떠 있는 동안은 일반 자막을 내지 않는다(겹침 방지).
        if (title and start < title_dur) or (outro_dur and end > outro_start):
            continue
        words = sc.get("words") or []
        if "\n" in text:
            body, style = _plain_text(text), "P"
        elif karaoke_enabled and p["karaoke"] and words:
            body, style = _karaoke(words, start, end), "K"
        else:
            body, style = _plain_text(text), "P"
        events.append(
            f"Dialogue: 0,{_ts(start)},{_ts(end)},{style},,0,0,0,,{sub_pos_tag}{body}"
        )

    return header + "\n".join(events) + "\n"
