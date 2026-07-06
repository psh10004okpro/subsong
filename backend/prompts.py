"""가사 → 이미지 프롬프트 자동작성.

마브 `/v1/prompt-adapter`(한→영 프롬프트 LLM)로 구간 가사+스타일을 받아
생성 직전에 쓸 영어 이미지 프롬프트(+네거티브)를 만든다. 실패 시 입력 그대로 폴백.
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
    """items: [{label, base}] → 화면 표시용 한글 프롬프트 초안.

    실제 생성 API로 보내는 영어 변환은 generate_candidates 단계에서 수행한다.
    그래야 Step 3 입력칸은 계속 한글로 유지된다.
    """
    style = (style or "").strip()

    def one(it):
        base = (it.get("base") or "").strip() or (it.get("label") or "")
        ko = f"{style}, {base}" if style else base
        return {"positive": ko, "negative": ""}

    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(len(items), 4)) as ex:
        return list(ex.map(one, items))
