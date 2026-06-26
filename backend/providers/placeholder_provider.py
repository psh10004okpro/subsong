"""플레이스홀더 이미지 생성기 (1차 데모용).

실제 이미지를 만들지 않고, 구간마다 색이 다른 배경에 라벨과 프롬프트를
그려 넣은 PNG를 만든다. '구간마다 배경이 바뀌는' 파이프라인을 눈으로
확인하기 위한 것. 2차에서 SDXL/API 구현으로 교체할 자리.
"""
import hashlib
import os

from PIL import Image, ImageDraw, ImageFont

from .base import ImageProvider

_SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
def _resolve(cands):
    for p in cands:
        if p and os.path.exists(p):
            return p
    return None


# Windows(Malgun) / Linux(Nanum·Noto) 한글 폰트를 순서대로 탐색
_FONT = _resolve([
    os.environ.get("SUBSONG_FONT_PATH", ""),
    r"C:\Windows\Fonts\malgun.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
])
_FONT_BOLD = _resolve([
    r"C:\Windows\Fonts\malgunbd.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
]) or _FONT

# 구간마다 구분되는 차분한 어두운 색들 (흰 글자가 잘 보이도록)
_PALETTE = [
    (26, 32, 54), (44, 26, 44), (20, 44, 44), (48, 36, 22),
    (30, 32, 50), (42, 24, 32), (24, 40, 30), (36, 30, 48),
    (22, 38, 52), (46, 30, 26), (28, 44, 40), (34, 26, 44),
]


def _font(size, bold=False):
    path = _FONT_BOLD if bold else _FONT
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def _avg_color(path):
    im = Image.open(path).convert("RGB").resize((16, 16))
    px = list(im.getdata())
    n = len(px)
    return tuple(sum(p[i] for p in px) // n for i in range(3))


def _wrap(draw, text, font, max_w):
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines[:4]


class PlaceholderImageProvider(ImageProvider):
    name = "placeholder"

    def generate(self, prompt: str, out_path: str, aspect: str = "16:9", **kw) -> str:
        w, h = _SIZES.get(aspect, (1920, 1080))
        label = (kw.get("label") or "").strip()
        # seed가 다르면 색이 달라져 후보 4장이 서로 구분된다.
        key = f"{prompt}|{label}|{kw.get('seed')}"
        seed = int(hashlib.md5(key.encode("utf-8")).hexdigest(), 16)

        # 참조(앵커) 이미지가 있으면 그 평균색을 기반으로 → 일관성이 눈에 보임
        ref = kw.get("ref_image")
        ref_used = False
        if ref and os.path.exists(ref):
            try:
                base = _avg_color(ref)
                jit = (seed % 24) - 12
                top = tuple(int(max(0, min(255, c + jit))) for c in base)
                ref_used = True
            except Exception:
                top = _PALETTE[seed % len(_PALETTE)]
        else:
            top = _PALETTE[seed % len(_PALETTE)]
        bottom = tuple(max(0, c - 16) for c in top)

        img = Image.new("RGB", (w, h))
        draw = ImageDraw.Draw(img)
        for y in range(h):  # 세로 그라데이션
            t = y / h
            draw.line(
                [(0, y), (w, y)],
                fill=tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3)),
            )

        cx = w // 2
        if label:
            f_label = _font(int(w * 0.045), bold=True)
            draw.text((cx, h * 0.40), label, font=f_label, fill=(236, 240, 250),
                      anchor="mm")

        f_prompt = _font(int(w * 0.026))
        for i, line in enumerate(_wrap(draw, prompt, f_prompt, w * 0.8)):
            draw.text((cx, h * 0.52 + i * w * 0.034), line, font=f_prompt,
                      fill=(176, 184, 204), anchor="mm")

        f_tag = _font(int(w * 0.018))
        tag = "PLACEHOLDER · 실제 이미지 생성기로 교체 예정"
        if ref_used:
            tag += " · 참조 적용"
        draw.text((w * 0.5, h * 0.92), tag, font=f_tag, fill=(120, 130, 152), anchor="mm")

        img.save(out_path)
        return out_path
