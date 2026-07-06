"""장면(scene)마다 배경 슬롯(section)을 만든다.

가사 1줄 = 배경 슬롯 1개 = 배경 이미지/영상 1개.
표시 이름과 이미지 프롬프트는 verse/chorus 같은 구조명이 아니라 실제 가사에서 만든다.
각 슬롯에는 편집 가능한 이미지 프롬프트 초안(image_prompt)을 만들어 둔다.
"""

_GAP = 1.6  # 예전 API 호환용 기본값. 현재는 가사 1줄당 슬롯 1개로 고정한다.


def _lyric_label(lines, idx: int) -> str:
    for line in lines:
        text = " ".join((line or "").split())
        if text:
            return text[:36] + ("..." if len(text) > 36 else "")
    return f"구간 {idx + 1}"


def _make_prompt(style: str, lines) -> str:
    """구간 가사 + 전체 스타일로 이미지 프롬프트 초안을 만든다(사용자가 수정 가능)."""
    snippet = " / ".join(lines[:3]).strip()
    style = (style or "").strip()
    parts = [p for p in (style, snippet) if p]
    return ", ".join(parts) if parts else "background"


def _section(idx, scenes_in, section_label, style):
    lines = [s["text"] for s in scenes_in]
    return {
        "index": idx,
        "label": _lyric_label(lines, idx),
        "section_label": section_label,
        # 첫/마지막이 아니라 그룹 내 최소/최대 — 장면 시간이 비단조여도 역전 방지.
        "start": round(min(float(s["start"]) for s in scenes_in), 2),
        "end": round(max(float(s["end"]) for s in scenes_in), 2),
        "scene_ids": [s.get("id", i) for i, s in enumerate(scenes_in)],
        "lines": lines,
        "image_prompt": _make_prompt(style, lines),
        "image_path": "",
        "image_id": "",
    }


def group(scenes, style: str = "", gap: float = _GAP):
    """스탭2 자막 행과 스탭3 배경 슬롯 개수를 1:1로 맞춘다."""
    scenes = [s for s in scenes if (s.get("text") or "").strip()]
    return [
        _section(i, [sc], (sc.get("section") or "").strip(), style)
        for i, sc in enumerate(scenes)
    ]
