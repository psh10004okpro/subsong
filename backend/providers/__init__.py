"""생성기 레지스트리.

2차에서 새 API를 추가하려면:
  1) base.ImageProvider / VideoProvider 를 구현한 클래스를 만들고
  2) 아래 딕셔너리에 등록하면 끝.
"""
import os

from .base import ImageProvider, VideoProvider
from .none_provider import NoneImageProvider, NoneVideoProvider
from .placeholder_provider import PlaceholderImageProvider
from .proxy_provider import NanoBananaProxyProvider, OpenAIImageProxyProvider

IMAGE_PROVIDERS = {
    "none": NoneImageProvider,
    "placeholder": PlaceholderImageProvider,
    "chatgpt_proxy": OpenAIImageProxyProvider,
    "nanobanana_proxy": NanoBananaProxyProvider,
    # "sdxl": SdxlImageProvider,     # ← 로컬 SDXL (선택)
}

VIDEO_PROVIDERS = {
    "none": NoneVideoProvider,
    # "myapi": MyApiVideoProvider,   # ← 2차에서 여기에 추가
}

# 기본 이미지 생성기. UI에서 구간별 생성 시 provider를 명시해 보낸다.
DEFAULT_IMAGE_PROVIDER = os.environ.get("SUBSONG_IMAGE_PROVIDER", "chatgpt_proxy")


def get_image_provider(name: str | None = None) -> ImageProvider:
    name = name or DEFAULT_IMAGE_PROVIDER
    if name not in IMAGE_PROVIDERS:
        raise RuntimeError(f"알 수 없는 이미지 생성기입니다: {name}")
    return IMAGE_PROVIDERS[name]()


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
