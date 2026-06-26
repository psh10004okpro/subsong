"""생성기 레지스트리.

2차에서 새 API를 추가하려면:
  1) base.ImageProvider / VideoProvider 를 구현한 클래스를 만들고
  2) 아래 딕셔너리에 등록하면 끝.
"""
import os

from .base import ImageProvider, VideoProvider
from .marv_provider import MarvImageProvider
from .none_provider import NoneImageProvider, NoneVideoProvider
from .placeholder_provider import PlaceholderImageProvider

IMAGE_PROVIDERS = {
    "none": NoneImageProvider,
    "placeholder": PlaceholderImageProvider,
    "marv": MarvImageProvider,       # 마브 외부 API (Z-Image-Turbo 등)
    # "sdxl": SdxlImageProvider,     # ← 로컬 SDXL (선택)
}

VIDEO_PROVIDERS = {
    "none": NoneVideoProvider,
    # "myapi": MyApiVideoProvider,   # ← 2차에서 여기에 추가
}

# 현재 기본 이미지 생성기 (환경변수로 교체 가능: SUBSONG_IMAGE_PROVIDER=sdxl 등)
DEFAULT_IMAGE_PROVIDER = os.environ.get("SUBSONG_IMAGE_PROVIDER", "placeholder")


def get_image_provider(name: str | None = None) -> ImageProvider:
    name = name or DEFAULT_IMAGE_PROVIDER
    return IMAGE_PROVIDERS.get(name, PlaceholderImageProvider)()


def get_video_provider(name: str = "none") -> VideoProvider:
    return VIDEO_PROVIDERS.get(name, NoneVideoProvider)()


__all__ = [
    "ImageProvider",
    "VideoProvider",
    "get_image_provider",
    "get_video_provider",
    "IMAGE_PROVIDERS",
    "VIDEO_PROVIDERS",
]
