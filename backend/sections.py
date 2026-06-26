"""장면(scene)들을 '구간(section)'으로 묶는다.

구간 1개 = 배경 이미지 1장. 묶는 기준:
  1) 장면에 구간 라벨(section)이 있으면 → 연속된 같은 라벨끼리 묶는다.
  2) 라벨이 없으면 → 줄 사이 시간 간격이 큰 곳을 경계로 자동으로 묶는다.

각 구간에는 편집 가능한 이미지 프롬프트 초안(image_prompt)을 만들어 둔다.
"""

_GAP = 1.6  # 라벨이 없을 때, 이 초 이상 비면 새 구간으로 본다.


def _make_prompt(style: str, lines, label: str) -> str:
    """구간 가사 + 전체 스타일로 이미지 프롬프트 초안을 만든다(사용자가 수정 가능)."""
    snippet = " / ".join(lines[:2]).strip()
    style = (style or "").strip()
    parts = [p for p in (style, snippet) if p]
    return ", ".join(parts) if parts else (label or "background")


def _section(idx, scenes_in, label, style):
    lines = [s["text"] for s in scenes_in]
    return {
        "index": idx,
        "label": label or f"구간 {idx + 1}",
        "start": round(float(scenes_in[0]["start"]), 2),
        "end": round(float(scenes_in[-1]["end"]), 2),
        "scene_ids": [s.get("id", i) for i, s in enumerate(scenes_in)],
        "lines": lines,
        "image_prompt": _make_prompt(style, lines, label),
        "image_path": "",
        "image_id": "",
    }


def group(scenes, style: str = ""):
    scenes = [s for s in scenes if (s.get("text") or "").strip()]
    if not scenes:
        return []

    has_labels = any((s.get("section") or "").strip() for s in scenes)
    groups = []
    cur = [scenes[0]]

    for prev, sc in zip(scenes, scenes[1:]):
        if has_labels:
            boundary = (sc.get("section") or "") != (prev.get("section") or "")
        else:
            boundary = float(sc["start"]) - float(prev["end"]) >= _GAP
        if boundary:
            groups.append(cur)
            cur = [sc]
        else:
            cur.append(sc)
    groups.append(cur)

    return [
        _section(i, g, (g[0].get("section") or "").strip(), style)
        for i, g in enumerate(groups)
    ]
