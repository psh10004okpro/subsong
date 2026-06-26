"""1차 버전용 빈 구현 — 아무 이미지/영상도 만들지 않는다.

배경은 사용자가 올린 사진/영상 또는 단색으로 처리하므로, 1차에서는
생성기를 호출하지 않는다. 2차에서 실제 API 구현으로 교체할 자리.
"""
from .base import ImageProvider, VideoProvider


class NoneImageProvider(ImageProvider):
    name = "none"

    def generate(self, prompt: str, out_path: str, aspect: str = "16:9") -> str:
        return ""


class NoneVideoProvider(VideoProvider):
    name = "none"

    def generate(self, prompt: str, image_path: str, out_path: str, aspect: str = "16:9") -> str:
        return ""
