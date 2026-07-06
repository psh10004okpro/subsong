"""subsong — AI 음악 가사 싱크 / 뮤직비디오 생성기 (1차 버전).

흐름:  음성 + 가사  →  /api/align (자동 싱크)  →  화면에서 수정
                    →  /api/srt (SRT 내보내기)  /  /api/render (MP4 출력)
"""
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime

from PIL import ImageFont
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import align as align_mod
from . import beats as beats_mod
from . import images as images_mod
from . import jobs as jobs_mod
from . import prompts as prompts_mod
from . import render as render_mod
from .srt import scenes_to_srt

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 배포 시 영속 볼륨을 가리키도록 환경변수로 교체 가능 (예: /data)
DATA = os.environ.get("SUBSONG_DATA_DIR") or os.path.join(BASE, "data")
FRONT = os.path.join(BASE, "frontend")
PROJECTS = os.path.join(DATA, "projects")
FONTS = os.path.join(DATA, "fonts")
FONTS_META = os.path.join(FONTS, "fonts.json")
os.makedirs(DATA, exist_ok=True)
os.makedirs(PROJECTS, exist_ok=True)
os.makedirs(FONTS, exist_ok=True)

# 서브패스 배포(예: 리버스 프록시 뒤 /subsong). 빈 값이면 루트(/)에서 서빙.
# Cloudflare 터널 등 "접두사를 떼지 않는" 프록시를 위해, 설정 시 앱 전체를 이 경로
# 아래에 마운트하고(파일 끝), 서버가 돌려주는 /data URL에도 이 접두사를 붙인다.
BASE_PATH = (os.environ.get("SUBSONG_BASE_PATH") or "").rstrip("/")


def _data_url(name: str) -> str:
    """업로드/출력 파일의 공개 URL. 서브패스 배포 시 접두사를 포함한다."""
    return f"{BASE_PATH}/data/{name}"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("subsong")

app = FastAPI(title="subsong")


@app.exception_handler(OSError)
async def _oserror_handler(request: Request, exc: OSError):
    """디스크 풀·권한 등 파일 오류 → 생짜 500 대신 한국어 안내."""
    logger.exception("OSError on %s", request.url.path)
    return JSONResponse(
        status_code=507,
        content={"detail": "파일을 저장/처리할 수 없습니다. 저장 공간이 부족할 수 있습니다."},
    )


@app.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception):
    """미처리 예외도 서버 로그에 트레이스백을 남기고 한국어 메시지로 응답."""
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"서버 오류가 발생했습니다: {exc}"},
    )


class Scene(BaseModel):
    id: int = 0
    start: float
    end: float
    text: str
    section: str = ""
    words: list[dict] = []
    image_prompt: str = ""
    image_path: str = ""
    video_path: str = ""


class SrtReq(BaseModel):
    scenes: list[Scene]


class ImagesReq(BaseModel):
    scenes: list[Scene]
    style: str = ""
    aspect: str = "16:9"
    gap: float = 1.6  # 예전 저장 상태/API 호환용. 현재는 가사 1줄당 슬롯 1개.


class CandidatesReq(BaseModel):
    prompt: str
    aspect: str = "16:9"
    count: int = 4
    label: str = ""
    ref_image_id: str = ""
    provider: str = ""


class AutoPromptReq(BaseModel):
    sections: list[dict] = []  # [{label, lines}]
    style: str = ""


class BeatsReq(BaseModel):
    audio_id: str


class ThumbReq(BaseModel):
    title: str
    subtitle: str = ""
    image_id: str = ""


class SectionBg(BaseModel):
    start: float
    end: float
    image_id: str = ""


class RenderReq(BaseModel):
    audio_id: str
    scenes: list[Scene]
    aspect: str = "16:9"
    aspects: list[str] = []  # 여러 비율 동시 렌더 (예: ["16:9","9:16"])
    bg_id: str | None = None
    bg_color: str = "black"
    font: str = os.environ.get("SUBSONG_FONT", "Malgun Gothic")
    font_size: int = 48
    subtitle_style: str = "ballad"
    subtitle_pos: str = "bottom"
    subtitle_align: str = "center"
    subtitle_offset_x: float = 0.0
    subtitle_offset_y: float = 0.0
    karaoke_enabled: bool = False   # 노래방처럼 단어 색상이 따라가는 효과. 기본 꺼짐.
    transition: str = "none"        # "none"(하드컷) | "crossfade"
    transition_dur: float = 0.8     # 크로스페이드 길이(초)
    ken_burns: float = 0.0          # 배경 줌 모션 강도 (0=정지)
    intro_fade: float = 0.0         # 인트로 페이드인(초, 0=없음)
    outro_fade: float = 0.0         # 아웃트로 페이드아웃(초, 0=없음)
    intro_title: str = ""           # 인트로 타이틀 카드 문구(빈 값=없음)
    intro_title_dur: float = 3.0    # 타이틀 카드 표시 길이(초)
    outro_title: str = ""           # 마지막 타이틀 카드 문구(빈 값=없음)
    outro_title_dur: float = 3.0    # 마지막 타이틀 카드 표시 길이(초)
    audio_delay_sec: float = 0.0    # 영상 시작 후 실제 음원이 시작되는 시간(앞 무음)
    text_color: str = ""            # 자막 기본 글자색(빈 값=프리셋)
    hi_color: str = ""              # 강조(부르는 단어) 색
    outline_color: str = ""         # 외곽선 색
    sections: list[SectionBg] = []
    preview: bool = False           # 최종 내보내기 전 확인용 저해상도 렌더


class ProjectReq(BaseModel):
    name: str
    state: dict


def _save_upload(file: UploadFile, default_ext: str) -> str:
    ext = os.path.splitext(file.filename or "")[1].lower() or default_ext
    name = uuid.uuid4().hex + ext
    with open(os.path.join(DATA, name), "wb") as f:
        shutil.copyfileobj(file.file, f)
    return name


def _load_fonts_meta():
    try:
        with open(FONTS_META, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save_fonts_meta(fonts):
    with open(FONTS_META, "w", encoding="utf-8") as f:
        json.dump(fonts, f, ensure_ascii=False, indent=2)


def _font_family(path, fallback):
    try:
        font = ImageFont.truetype(path, 16)
        family, style = font.getname()
        return (family or fallback).strip(), (style or "").strip()
    except Exception:
        return fallback, ""


def _font_label(family, style):
    if style and style.lower() not in {"regular", "normal"}:
        return f"{family} {style} (업로드)"
    return f"{family} (업로드)"


@app.get("/api/fonts")
def api_fonts():
    fonts = []
    changed = False
    for item in _load_fonts_meta():
        font_id = item.get("font_id") or ""
        if not font_id or not os.path.exists(os.path.join(DATA, font_id)):
            changed = True
            continue
        item["font_url"] = _data_url(font_id)
        fonts.append(item)
    if changed:
        _save_fonts_meta([{k: v for k, v in item.items() if k != "font_url"} for item in fonts])
    return {"fonts": fonts}


@app.post("/api/upload-font")
def api_upload_font(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in {".ttf", ".otf", ".ttc"}:
        raise HTTPException(400, "TTF, OTF, TTC 폰트 파일만 업로드할 수 있습니다.")
    font_id = f"fonts/{uuid.uuid4().hex}{ext}"
    path = os.path.join(DATA, font_id)
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    stem = os.path.splitext(os.path.basename(file.filename or "uploaded-font"))[0]
    family, style = _font_family(path, stem)
    item = {
        "font_id": font_id,
        "font_url": _data_url(font_id),
        "family": family,
        "style": style,
        "label": _font_label(family, style),
        "filename": file.filename or os.path.basename(font_id),
        "uploaded_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    fonts = _load_fonts_meta()
    fonts = [f for f in fonts if f.get("font_id") != font_id]
    fonts.append({k: v for k, v in item.items() if k != "font_url"})
    _save_fonts_meta(fonts)
    return item


@app.post("/api/align")
def api_align(
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    language: str = Form("ko"),
):
    audio_id = _save_upload(audio, ".mp3")
    audio_path = os.path.join(DATA, audio_id)
    try:
        scenes = align_mod.align(audio_path, lyrics, language=language)
    except Exception as e:  # noqa: BLE001 - 사용자에게 메시지로 전달
        raise HTTPException(500, f"정렬 실패: {e}")
    return {"audio_id": audio_id, "audio_url": _data_url(audio_id), "scenes": scenes}


@app.post("/api/upload-bg")
def api_upload_bg(file: UploadFile = File(...)):
    bg_id = _save_upload(file, ".jpg")
    return {"bg_id": bg_id, "bg_url": _data_url(bg_id)}


@app.post("/api/images")
def api_images(req: ImagesReq):
    """장면 → 가사별 배경 슬롯 만들기 (이미지는 아직 생성하지 않음)."""
    secs = images_mod.group_only([s.model_dump() for s in req.scenes], req.style, gap=req.gap)
    for s in secs:
        s.pop("image_path", None)
        s["image_id"] = ""
        s["image_url"] = ""
        s["subtitle"] = True
    return {"sections": secs}


@app.post("/api/auto-prompts")
def api_auto_prompts(req: AutoPromptReq):
    """구간 가사(+전체 분위기) → 영화 같은 영어 이미지 프롬프트 자동작성.

    가사는 바꾸지 않는다 — 배경 그림용 설명문(positive/negative)만 만든다.
    마브 어댑터 실패 시 입력 텍스트를 그대로 돌려준다(폴백).
    """
    items = []
    for s in req.sections:
        lines = [l for l in (s.get("lines") or []) if (l or "").strip()]
        items.append({"label": s.get("label", ""), "base": " / ".join(lines)[:200]})
    try:
        results = prompts_mod.auto_prompts(items, req.style)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"프롬프트 생성 실패: {e}")
    return {"prompts": results}


@app.post("/api/beats")
def api_beats(req: BeatsReq):
    """음원 비트 시각 검출 → 구간 경계를 박자에 스냅하는 데 사용."""
    path = os.path.join(DATA, req.audio_id)
    if not os.path.exists(path):
        raise HTTPException(404, "오디오를 찾을 수 없습니다. 다시 정렬해 주세요.")
    bts = beats_mod.detect_beats(path)
    if not bts:
        raise HTTPException(503, "비트를 검출하지 못했습니다(분석 실패 또는 librosa 미설치).")
    return {"beats": bts}


@app.post("/api/candidates")
def api_candidates(req: CandidatesReq):
    """한 가사 프롬프트로 선택한 프록시 이미지 생성."""
    try:
        cands = images_mod.generate_candidates(
            req.prompt, DATA, count=req.count, aspect=req.aspect, label=req.label,
            ref_image_id=req.ref_image_id or None,
            provider=req.provider or None,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, str(e))
    for c in cands:
        c["image_url"] = _data_url(c['image_id'])
        c.pop("path", None)
    return {"candidates": cands}


@app.post("/api/thumbnail")
def api_thumbnail(req: ThumbReq):
    """대표 이미지 + 제목으로 1280×720 유튜브 썸네일 생성."""
    try:
        tid = images_mod.make_thumbnail(DATA, req.title, req.subtitle, req.image_id or None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"썸네일 생성 실패: {e}")
    return {"image_id": tid, "image_url": _data_url(tid)}


@app.post("/api/srt")
def api_srt(req: SrtReq):
    srt = scenes_to_srt([s.model_dump() for s in req.scenes])
    return PlainTextResponse(
        srt, headers={"Content-Disposition": "attachment; filename=lyrics.srt"}
    )


@app.post("/api/render")
def api_render(req: RenderReq):
    audio_path = os.path.join(DATA, req.audio_id)
    if not os.path.exists(audio_path):
        raise HTTPException(404, "오디오를 찾을 수 없습니다. 다시 정렬해 주세요.")
    bg_path = os.path.join(DATA, req.bg_id) if req.bg_id else None
    sections = [
        {"start": sb.start, "end": sb.end,
         "image_path": os.path.join(DATA, sb.image_id)}
        for sb in req.sections if sb.image_id
    ] or None
    scenes_render = [s.model_dump() for s in req.scenes]
    aspects = [req.aspect] if req.preview else list(dict.fromkeys(req.aspects or [req.aspect]))
    job = jobs_mod.create("preview" if req.preview else "render")

    def run():
        try:
            videos = []
            n = len(aspects)
            for i, asp in enumerate(aspects):
                if job.cancelled:
                    break
                out = render_mod.render(
                    audio_path, scenes_render, DATA,
                    sections=sections, background_path=bg_path,
                    aspect=asp, bg_color=req.bg_color,
                    font=req.font, font_size=req.font_size,
                    subtitle_style=req.subtitle_style, subtitle_pos=req.subtitle_pos,
                    subtitle_align=req.subtitle_align,
                    subtitle_offset_x=req.subtitle_offset_x,
                    subtitle_offset_y=req.subtitle_offset_y,
                    karaoke_enabled=req.karaoke_enabled,
                    transition=req.transition, transition_dur=req.transition_dur,
                    ken_burns=req.ken_burns,
                    intro_fade=req.intro_fade, outro_fade=req.outro_fade,
                    intro_title=req.intro_title, intro_title_dur=req.intro_title_dur,
                    outro_title=req.outro_title, outro_title_dur=req.outro_title_dur,
                    audio_delay_sec=req.audio_delay_sec,
                    text_color=req.text_color, hi_color=req.hi_color,
                    outline_color=req.outline_color,
                    preview=req.preview,
                    job=job, progress_range=(i / n, (i + 1) / n),
                )
                if job.cancelled or out is None:
                    break
                videos.append({
                    "aspect": asp,
                    "video_url": _data_url(os.path.basename(out)),
                    "preview": req.preview,
                })
            if job.cancelled:
                job.status, job.message = "cancelled", "취소됨"
            else:
                job.progress = 1.0
                job.result = {"videos": videos,
                              "video_url": videos[0]["video_url"] if videos else None}
                job.status = "done"
        except Exception as e:  # noqa: BLE001
            # 트레이스백은 서버 로그로(원인 추적), 사용자에겐 요약 메시지.
            logger.exception("render job %s failed", job.id)
            job.status, job.error = "error", str(e)

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job.id}


@app.get("/api/jobs/{jid}")
def api_job_get(jid: str):
    j = jobs_mod.get(jid)
    if not j:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return jobs_mod.snapshot(j)


@app.post("/api/jobs/{jid}/cancel")
def api_job_cancel(jid: str):
    if not jobs_mod.cancel(jid):
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return {"ok": True}


@app.get("/api/jobs/{jid}/events")
def api_job_events(jid: str):
    if not jobs_mod.get(jid):
        raise HTTPException(404, "작업을 찾을 수 없습니다.")

    def gen():
        last = None
        try:
            while True:
                j = jobs_mod.get(jid)
                if j is None:
                    break
                data = json.dumps(jobs_mod.snapshot(j), ensure_ascii=False)
                if data != last:
                    yield f"data: {data}\n\n"
                    last = data
                if j.status in ("done", "error", "cancelled"):
                    break
                time.sleep(0.4)
        except Exception:  # noqa: BLE001
            # 직렬화/전송 오류 시 클라이언트가 종료를 인지하도록 error 이벤트를 보낸다.
            logger.exception("SSE stream failed for job %s", jid)
            yield f'data: {json.dumps({"status": "error", "error": "상태 전송 오류"})}\n\n'

    return StreamingResponse(gen(), media_type="text/event-stream")


# ----- 프로젝트 저장/불러오기 (작업 내용 기억) -----
def _slug(name: str) -> str:
    s = re.sub(r"[^\w가-힣 .-]", "", name or "").strip().replace(" ", "_")
    return (s[:60] or "project")


@app.post("/api/projects")
def api_save_project(req: ProjectReq):
    base = _slug(req.name)
    # 서로 다른 이름이 같은 슬러그로 충돌할 때 남의 작업물을 덮어쓰지 않도록
    # 일련번호를 붙인다. 같은 이름의 재저장(자동저장 포함)이면 덮어쓴다.
    slug = base
    n = 2
    while os.path.exists(os.path.join(PROJECTS, slug + ".json")):
        try:
            with open(os.path.join(PROJECTS, slug + ".json"), encoding="utf-8") as f:
                if json.load(f).get("name") == req.name:
                    break  # 같은 프로젝트 → 덮어쓰기 허용
        except (OSError, ValueError):
            break
        slug = f"{base}-{n}"
        n += 1
    doc = {
        "name": req.name,
        "slug": slug,
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "state": req.state,
    }
    with open(os.path.join(PROJECTS, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    return {"ok": True, "slug": slug, "name": req.name, "saved_at": doc["saved_at"]}


@app.get("/api/projects")
def api_list_projects():
    out = []
    for fn in os.listdir(PROJECTS):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(PROJECTS, fn), encoding="utf-8") as f:
                d = json.load(f)
            out.append({"slug": d.get("slug", fn[:-5]), "name": d.get("name"),
                        "saved_at": d.get("saved_at")})
        except (OSError, ValueError):
            pass
    out.sort(key=lambda x: x.get("saved_at") or "", reverse=True)
    return {"projects": out}


@app.get("/api/projects/{slug}")
def api_get_project(slug: str):
    path = os.path.join(PROJECTS, _slug(slug) + ".json")
    if not os.path.exists(path):
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@app.delete("/api/projects/{slug}")
def api_delete_project(slug: str):
    path = os.path.join(PROJECTS, _slug(slug) + ".json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


# /data: 업로드·출력 파일.  "/": 프론트엔드(index.html, style.css, app.js).
# API 라우트가 먼저 등록되므로 우선 매칭되고, 나머지는 정적 파일로 처리된다.
class NoCacheStatic(StaticFiles):
    """프론트엔드 파일은 캐시 금지 — 코드 수정이 항상 즉시 반영되게."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(
        os.path.join(FRONT, "favicon.ico"),
        media_type="image/x-icon",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


app.mount("/data", StaticFiles(directory=DATA), name="data")
app.mount("/", NoCacheStatic(directory=FRONT, html=True), name="front")


# 서브패스 배포: 앱 전체를 BASE_PATH 아래로 마운트한다. Cloudflare 터널처럼 경로
# 접두사를 떼지 않는 프록시가 /subsong/... 를 그대로 넘겨도 내부 라우트(/api, /data, /)
# 가 그대로 동작한다(마운트가 접두사를 벗겨 내부 앱에 전달). BASE_PATH 미설정 시 그대로 루트.
if BASE_PATH:
    _root = FastAPI()

    @_root.get(BASE_PATH)
    def _base_redirect():
        # /subsong → /subsong/ (상대경로 자산이 올바로 풀리도록 슬래시 보정)
        return RedirectResponse(url=BASE_PATH + "/", status_code=307)

    @_root.get("/favicon.ico", include_in_schema=False)
    def _root_favicon():
        return FileResponse(
            os.path.join(FRONT, "favicon.ico"),
            media_type="image/x-icon",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    _root.mount(BASE_PATH, app)
    app = _root
