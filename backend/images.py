"""구간 묶기 + 이미지 후보 생성 서비스.

흐름:
  1) group_only: 장면 → 구간(section) 묶기 (이미지는 아직 안 만듦)
  2) generate_candidates: 한 구간 프롬프트로 후보 N장 생성 → 사용자가 1장 선택
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import face as face_mod
from . import sections as sections_mod
from .providers import get_image_provider


def group_only(scenes, style=""):
    return sections_mod.group(scenes, style)


def generate_candidates(prompt, out_dir, count=4, aspect="16:9", label="",
                        ref_image_id=None, provider=None):
    """한 프롬프트로 후보 이미지 count장을 병렬 생성한다.

    ref_image_id: 일관성 유지를 위한 참조(앵커) 이미지. 있으면 i2i로 전달.
    각 결과에 얼굴 감지 결과(has_face)를 함께 담는다.
    """
    prov = get_image_provider(provider)
    count = max(1, min(int(count), 8))

    ref_path = os.path.join(out_dir, ref_image_id) if ref_image_id else None
    if ref_path and not os.path.exists(ref_path):
        ref_path = None

    def one(i):
        image_id = uuid.uuid4().hex + ".png"
        path = os.path.join(out_dir, image_id)
        prov.generate(prompt, path, aspect=aspect, label=label,
                      seed=1000 + i, ref_image=ref_path)
        return {"image_id": image_id, "path": path, "has_face": face_mod.has_face(path)}

    with ThreadPoolExecutor(max_workers=min(count, 4)) as ex:
        return list(ex.map(one, range(count)))
