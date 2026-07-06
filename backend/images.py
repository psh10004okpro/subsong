"""가사별 배경 슬롯 + 이미지 후보 생성 서비스.

흐름:
  1) group_only: 장면 → 가사별 배경 슬롯(section) 만들기 (이미지는 아직 안 만듦)
  2) generate_candidates: 한 슬롯 프롬프트로 선택한 프록시 이미지 생성
"""
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw

from . import face as face_mod
from . import prompts as prompts_mod
from . import sections as sections_mod
from .providers import get_image_provider
from .providers.placeholder_provider import _font, _wrap


def group_only(scenes, style="", gap=1.6):
    return sections_mod.group(scenes, style, gap=gap)


_HANGUL_RE = re.compile(r"[\uac00-\ud7a3\u3131-\u318e\u1100-\u11ff]")


def _prompt_for_generation(prompt):
    """UI에는 한글 프롬프트를 보존하고, 생성 API에는 필요할 때만 영어로 변환."""
    prompt = (prompt or "").strip()
    if not prompt or not _HANGUL_RE.search(prompt):
        return prompt
    positive, _negative = prompts_mod.adapt(prompt)
    return positive or prompt


def generate_candidates(prompt, out_dir, count=4, aspect="16:9", label="",
                        ref_image_id=None, provider=None):
    """한 프롬프트로 이미지 count장을 생성한다.

    ref_image_id: 일관성 유지를 위한 참조(앵커) 이미지. 있으면 i2i로 전달.
    각 결과에 얼굴 감지 결과(has_face)를 함께 담는다.
    """
    prov = get_image_provider(provider)
    generate_prompt = _prompt_for_generation(prompt)
    count = max(1, min(int(count), 8))

    ref_path = os.path.join(out_dir, ref_image_id) if ref_image_id else None
    if ref_path and not os.path.exists(ref_path):
        ref_path = None

    errors = []

    def one(i):
        image_id = uuid.uuid4().hex + ".png"
        path = os.path.join(out_dir, image_id)
        try:
            prov.generate(generate_prompt, path, aspect=aspect, label=label,
                          seed=1000 + i, ref_image=ref_path)
        except Exception as exc:
            errors.append(str(exc))
            # 후보 하나가 실패해도 나머지는 살린다.
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
            return None
        # 얼굴 감지는 보조 정보 — 실패해도 생성된 후보를 버리지 않는다.
        try:
            face = face_mod.has_face(path)
        except Exception:
            face = False
        return {"image_id": image_id, "path": path, "has_face": face}

    with ThreadPoolExecutor(max_workers=min(count, 4)) as ex:
        results = [c for c in ex.map(one, range(count)) if c]
    if not results:
        detail = errors[-1] if errors else "알 수 없는 오류"
        raise RuntimeError(f"이미지 생성에 모두 실패했습니다: {detail}")
    return results


def _cover(src, w, h):
    """이미지를 w×h를 꽉 채우도록 스케일 후 중앙 크롭."""
    sr, tr = src.width / src.height, w / h
    if sr > tr:
        nw, nh = int(h * sr), h
    else:
        nw, nh = w, int(w / sr)
    src = src.resize((max(nw, w), max(nh, h)))
    left, top = (src.width - w) // 2, (src.height - h) // 2
    return src.crop((left, top, left + w, top + h))


def make_thumbnail(out_dir, title, subtitle="", bg_image_id=None):
    """1280×720 유튜브 썸네일: 배경 이미지(구간 이미지) + 제목 오버레이."""
    W, H = 1280, 720
    base = None
    if bg_image_id:
        p = os.path.join(out_dir, bg_image_id)
        if os.path.exists(p):
            base = _cover(Image.open(p).convert("RGB"), W, H)
    if base is None:
        base = Image.new("RGB", (W, H), (24, 26, 34))

    draw = ImageDraw.Draw(base, "RGBA")
    for y in range(H):  # 하단 어둡게(가독성)
        if y > H * 0.42:
            a = int(210 * (y - H * 0.42) / (H * 0.58))
            draw.line([(0, y), (W, y)], fill=(0, 0, 0, min(200, a)))

    margin = 60
    f_title = _font(int(W * 0.078), bold=True)
    f_sub = _font(int(W * 0.030))
    lines = _wrap(draw, (title or "").strip() or "제목", f_title, W - margin * 2)[:3]
    lh = int(W * 0.092)
    sub = (subtitle or "").strip()
    block_h = len(lines) * lh + (int(W * 0.05) if sub else 0)
    y = H - margin - block_h

    if sub:
        draw.text((margin, y), sub, font=f_sub, fill=(255, 224, 138, 255))
        y += int(W * 0.05)
    for ln in lines:
        draw.text((margin, y), ln, font=f_title, fill=(255, 255, 255, 255),
                  stroke_width=3, stroke_fill=(0, 0, 0, 255))
        y += lh

    out_id = uuid.uuid4().hex + ".png"
    base.convert("RGB").save(os.path.join(out_dir, out_id))
    return out_id
