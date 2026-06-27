"""가사 → 이미지 프롬프트 자동작성.

마브 `/v1/prompt-adapter`(한→영 프롬프트 LLM)로 구간 가사+스타일을 받아
영화 같은 영어 이미지 프롬프트(+네거티브)를 만든다. 실패 시 입력 그대로 폴백.
가사 자체는 절대 바꾸지 않는다 — '배경 그림 설명'만 생성.
"""
import os
from concurrent.futures import ThreadPoolExecutor

import requests

BASE = os.environ.get("SUBSONG_MARV_BASE", "https://maket.mindvr.co.kr").rstrip("/")
KEY = os.environ.get("SUBSONG_MARV_API_KEY", "")
MODEL = os.environ.get("SUBSONG_MARV_MODEL", "Z-Image-Turbo")


def _headers():
    return {"x-api-key": KEY} if KEY else {}


def adapt(prompt_ko: str):
    """한국어 프롬프트 → (영어 positive, negative). 실패 시 (원문, '')."""
    prompt_ko = (prompt_ko or "").strip()
    if not prompt_ko:
        return "", ""
    try:
        r = requests.post(
            f"{BASE}/v1/prompt-adapter",
            headers=_headers(),
            json={"prompt_ko": prompt_ko, "model": MODEL},
            timeout=40,
        )
        r.raise_for_status()
        d = r.json()
        pos = (d.get("positive") or "").strip()
        neg = (d.get("negative") or "").strip()
        if pos:
            return pos, neg
    except Exception:
        pass
    return prompt_ko, ""


def auto_prompts(items, style=""):
    """items: [{label, base}] → [{positive, negative}] 병렬 변환.

    base(구간 가사)와 style(전체 분위기)을 합쳐 어댑터에 넘긴다.
    """
    style = (style or "").strip()

    def one(it):
        base = (it.get("base") or "").strip() or (it.get("label") or "")
        ko = f"{style}, {base}" if style else base
        pos, neg = adapt(ko)
        return {"positive": pos, "negative": neg}

    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(len(items), 4)) as ex:
        return list(ex.map(one, items))
