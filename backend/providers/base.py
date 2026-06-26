"""이미지/영상 생성기의 공통 인터페이스(2차 확장 지점).

2차에서 어떤 API를 쓰든, 아래 인터페이스만 구현해 providers/__init__.py의
레지스트리에 등록하면 나머지 코드(합성/자막/출력)는 바뀌지 않는다.
"""
from abc import ABC, abstractmethod


class ImageProvider(ABC):
    name = "base"

    @abstractmethod
    def generate(self, prompt: str, out_path: str, aspect: str = "16:9", **kwargs) -> str:
        """prompt로 이미지를 만들어 out_path에 저장하고 경로를 반환.

        kwargs로 label(구간 이름) 등 부가 정보를 받을 수 있다(구현체가 선택적으로 사용).
        """
        raise NotImplementedError


class VideoProvider(ABC):
    name = "base"

    @abstractmethod
    def generate(self, prompt: str, image_path: str, out_path: str, aspect: str = "16:9") -> str:
        """prompt(+선택적 시작 이미지)로 영상 클립을 만들어 out_path에 저장하고 경로를 반환."""
        raise NotImplementedError
