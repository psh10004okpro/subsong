"""장면 목록(scene list) → SRT 자막 문자열."""


def _ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def scenes_to_srt(scenes) -> str:
    blocks = []
    n = 0
    for sc in scenes:
        text = (sc.get("text") or "").strip()
        if not text:
            continue
        start = float(sc["start"])
        end = float(sc["end"])
        if end <= start:
            end = start + 0.5
        n += 1
        blocks.append(f"{n}\n{_ts(start)} --> {_ts(end)}\n{text}\n")
    return "\n".join(blocks)
