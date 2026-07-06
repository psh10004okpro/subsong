"""mlapi.run 이미지 프록시 provider.

두 프록시 모두 OpenAI 호환 /v1/images/generations 응답을 우선 사용한다.
응답은 b64_json 또는 url 형태를 모두 받을 수 있게 처리한다.
"""
import base64
import os
from urllib.parse import urlparse

import requests

from .base import ImageProvider


_FREE_ASPECT_SIZES = {
    "16:9": "1536x864",
    "9:16": "864x1536",
    "1:1": "1024x1024",
}


def _first_env(*names):
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return ""


def _png_like(content: bytes, ctype: str = "") -> bool:
    return (
        content.startswith(b"\x89PNG")
        or content[:3] == b"\xff\xd8\xff"
        or content.startswith(b"RIFF")
        or "image" in (ctype or "").lower()
    )


def _generation_urls(base: str):
    base = base.rstrip("/")
    if base.endswith("/images/generations"):
        return [base]
    if base.endswith("/v1"):
        return [base + "/images/generations"]
    return [base + "/v1/images/generations", base]


def _decode_image_response(data, headers, base_url: str) -> bytes:
    if isinstance(data, dict):
        items = data.get("data") or []
        if items:
            first = items[0] or {}
            b64 = first.get("b64_json") or first.get("base64") or first.get("image")
            if b64:
                if isinstance(b64, str) and b64.startswith("data:"):
                    b64 = b64.split(",", 1)[-1]
                return base64.b64decode(b64)
            url = first.get("url")
            if url:
                return _download_url(url, base_url)

        # 일부 프록시는 최상위 필드로 이미지를 돌려준다.
        for key in ("b64_json", "base64", "image", "output"):
            b64 = data.get(key)
            if isinstance(b64, str):
                if b64.startswith("http://") or b64.startswith("https://"):
                    return _download_url(b64, base_url)
                if b64.startswith("data:"):
                    b64 = b64.split(",", 1)[-1]
                try:
                    return base64.b64decode(b64)
                except Exception:
                    pass

        for key in ("url", "image_url", "output_url"):
            url = data.get(key)
            if isinstance(url, str) and url:
                return _download_url(url, base_url)

    raise RuntimeError("프록시 응답에서 이미지 데이터를 찾지 못했습니다.")


def _download_url(url: str, base_url: str) -> bytes:
    if url.startswith("/"):
        p = urlparse(base_url)
        url = f"{p.scheme}://{p.netloc}{url}"
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    content = r.content
    if not _png_like(content, r.headers.get("Content-Type", "")):
        raise RuntimeError("프록시 URL 결과가 이미지가 아닙니다.")
    return content


class OpenAIImageProxyProvider(ImageProvider):
    name = "chatgpt_proxy"
    display_name = "GPT-Image-2 프록시"
    sizes = _FREE_ASPECT_SIZES
    env_key_names = ("SUBSONG_CHATGPT_PROXY_KEY", "SUBSONG_IMAGE_PROXY_KEY", "SUBSONG_MLAPI_KEY")
    env_base_names = ("SUBSONG_CHATGPT_PROXY_BASE", "SUBSONG_IMAGE_PROXY_BASE")
    env_model_name = "SUBSONG_CHATGPT_PROXY_MODEL"
    default_base = "https://mlapi.run/eb5722f3-111c-4fb5-a65c-3a9d44f82fc1/v1"
    default_model = "openai/gpt-image-2"

    def __init__(self):
        self.key = _first_env(*self.env_key_names)
        self.base = _first_env(*self.env_base_names) or self.default_base
        self.model = os.environ.get(self.env_model_name, self.default_model)
        self.quality = os.environ.get("SUBSONG_CHATGPT_PROXY_QUALITY", "")
        self.output_format = os.environ.get("SUBSONG_CHATGPT_PROXY_OUTPUT_FORMAT", "")
        self.timeout = int(os.environ.get("SUBSONG_IMAGE_PROXY_TIMEOUT", "240"))

    def _payload(self, prompt: str, aspect: str, **kw):
        clean_prompt = (
            f"{prompt}\n\n"
            "Create a cinematic background image only. "
            "Do not render lyrics, captions, subtitles, logos, watermarks, or any visible text."
        )
        payload = {
            "model": self.model,
            "prompt": clean_prompt,
            "n": 1,
            "size": self.sizes.get(aspect, self.sizes["16:9"]),
        }
        if self.quality:
            payload["quality"] = self.quality
        if self.output_format:
            payload["output_format"] = self.output_format
        return payload

    def generate(self, prompt: str, out_path: str, aspect: str = "16:9", **kw) -> str:
        if not self.key:
            raise RuntimeError(f"{self.display_name} 키가 없습니다. {self.env_key_names[0]}를 설정하세요.")
        payload = self._payload(prompt, aspect, **kw)
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "Authorization": f"Bearer {self.key}",
        }
        last_error = ""
        urls = _generation_urls(self.base)
        for url in urls:
            try:
                r = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
                if r.status_code in (404, 405) and url != urls[-1]:
                    last_error = f"{r.status_code} {r.text[:300]}"
                    continue
                if not r.ok:
                    raise RuntimeError(f"{r.status_code} {r.text[:1000]}")
                data = r.json()
                content = _decode_image_response(data, r.headers, self.base)
                if not _png_like(content):
                    raise RuntimeError("프록시 결과가 이미지가 아닙니다.")
                with open(out_path, "wb") as f:
                    f.write(content)
                return out_path
            except Exception as exc:
                last_error = str(exc)
        raise RuntimeError(f"{self.display_name} 생성 실패: {last_error}")


class NanoBananaProxyProvider(OpenAIImageProxyProvider):
    name = "nanobanana_proxy"
    display_name = "나노바나나 프록시"
    sizes = _FREE_ASPECT_SIZES
    env_key_names = ("SUBSONG_NANOBANANA_PROXY_KEY", "SUBSONG_IMAGE_PROXY_KEY", "SUBSONG_MLAPI_KEY")
    env_base_names = ("SUBSONG_NANOBANANA_PROXY_BASE",)
    env_model_name = "SUBSONG_NANOBANANA_PROXY_MODEL"
    default_base = "https://mlapi.run/820ebe88-0383-4fa4-b5e9-06fcf26b3420"
    default_model = "google/gemini-3-pro-image-preview"

    def _payload(self, prompt: str, aspect: str, **kw):
        payload = super()._payload(prompt, aspect, **kw)
        payload["model"] = self.model
        payload.pop("quality", None)
        payload.pop("output_format", None)
        payload.pop("response_format", None)
        payload["extra_body"] = {
            "aspect_ratio": aspect,
            "image_size": os.environ.get("SUBSONG_NANOBANANA_IMAGE_SIZE", "2K"),
        }
        ref = kw.get("ref_image")
        if ref and os.path.exists(ref):
            with open(ref, "rb") as f:
                payload["image"] = base64.b64encode(f.read()).decode("ascii")
        return payload
