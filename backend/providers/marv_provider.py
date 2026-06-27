"""마브(Marv) 외부 API 이미지 생성기.

마브 플랫폼의 /v1/image 엔드포인트로 이미지를 생성한다.
흐름: POST /v1/image → job_id → GET /v1/jobs/{id} 폴링 → 결과 다운로드.

환경변수:
  SUBSONG_MARV_API_KEY   x-api-key 값 (필수)
  SUBSONG_MARV_BASE      기본 https://maket.mindvr.co.kr
  SUBSONG_MARV_MODEL     기본 Z-Image-Turbo (빠름·상업가능)
  SUBSONG_MARV_TIMEOUT   잡 대기 최대 초 (기본 180)
"""
import json
import os
import time

import requests

from .base import ImageProvider


class MarvImageProvider(ImageProvider):
    name = "marv"

    def __init__(self):
        self.base = os.environ.get("SUBSONG_MARV_BASE", "https://maket.mindvr.co.kr").rstrip("/")
        self.key = os.environ.get("SUBSONG_MARV_API_KEY", "")
        self.model = os.environ.get("SUBSONG_MARV_MODEL", "Z-Image-Turbo")
        self.timeout = int(os.environ.get("SUBSONG_MARV_TIMEOUT", "180"))

    def _headers(self):
        return {"x-api-key": self.key} if self.key else {}

    def generate(self, prompt: str, out_path: str, aspect: str = "16:9", **kw) -> str:
        # 키는 선택적: 마브 서버 인증이 비활성이면 없이도 동작. 있으면 x-api-key로 전송.
        seed = int(kw.get("seed") or 42)
        params = {"aspect": aspect, "seed": seed}
        data = {
            "model": self.model,
            "prompt_ko": prompt,
            "params_json": json.dumps(params, ensure_ascii=False),
        }

        # 참조(앵커) 이미지가 있으면 i2i 로 전달 → 인물/컨셉 일관성 유지
        ref = kw.get("ref_image")
        files = None
        fh = None
        if ref and os.path.exists(ref):
            fh = open(ref, "rb")
            files = {"ref_image": (os.path.basename(ref), fh, "image/png")}
        try:
            r = requests.post(
                f"{self.base}/v1/image",
                headers=self._headers(),
                data=data,
                files=files,
                timeout=60,
            )
        finally:
            if fh:
                fh.close()
        r.raise_for_status()
        job_id = r.json()["job_id"]

        deadline = time.time() + self.timeout
        errors = 0
        while time.time() < deadline:
            try:
                jr = requests.get(f"{self.base}/v1/jobs/{job_id}",
                                  headers=self._headers(), timeout=30)
                jr.raise_for_status()
                errors = 0
            except requests.RequestException:
                # 폴링 중 단발성 네트워크 오류는 잡 전체를 죽이지 않고 재시도.
                errors += 1
                if errors >= 5:
                    raise RuntimeError("마브 상태 조회가 반복 실패했습니다.")
                time.sleep(2)
                continue
            status = jr.json().get("status")
            if status == "finished":
                break
            if status == "failed":
                raise RuntimeError(jr.json().get("error") or "마브 잡 실패")
            time.sleep(2)
        else:
            raise RuntimeError("마브 생성 시간 초과")

        dr = requests.get(f"{self.base}/v1/jobs/{job_id}/result", headers=self._headers(), timeout=120)
        dr.raise_for_status()
        # 결과가 진짜 이미지인지 검증 — 오류 JSON/HTML을 .png로 굽지 않게 한다.
        content = dr.content
        ctype = dr.headers.get("Content-Type", "")
        is_img = (
            content[:8].startswith(b"\x89PNG")
            or content[:3] == b"\xff\xd8\xff"
            or content[:4] == b"RIFF"
            or "image" in ctype
        )
        if not is_img:
            raise RuntimeError(f"마브 결과가 이미지가 아닙니다(content-type={ctype}, {len(content)}바이트)")
        with open(out_path, "wb") as f:
            f.write(content)
        return out_path
