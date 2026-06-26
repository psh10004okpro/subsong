"""subsong — AI 음악 가사 싱크 / 뮤직비디오 생성기 (1차 버전).

흐름:  음성 + 가사  →  /api/align (자동 싱크)  →  화면에서 수정
                    →  /api/srt (SRT 내보내기)  /  /api/render (MP4 출력)
"""
import json
import os
import re
import shutil
import uuid
from datetime import datetime

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import align as align_mod
from . import images as images_mod
from . import render as render_mod
from .srt import scenes_to_srt

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
FRONT = os.path.join(BASE, "frontend")
PROJECTS = os.path.join(DATA, "projects")
os.makedirs(DATA, exist_ok=True)
os.makedirs(PROJECTS, exist_ok=True)

app = FastAPI(title="subsong")


class Scene(BaseModel):
    id: int = 0
    start: float
    end: float
    text: str
    section: str = ""
    image_prompt: str = ""
    image_path: str = ""
    video_path: str = ""


class SrtReq(BaseModel):
    scenes: list[Scene]


class ImagesReq(BaseModel):
    scenes: list[Scene]
    style: str = ""
    aspect: str = "16:9"


class CandidatesReq(BaseModel):
    prompt: str
    aspect: str = "16:9"
    count: int = 4
    label: str = ""


class SectionBg(BaseModel):
    start: float
    end: float
    image_id: str = ""


class RenderReq(BaseModel):
    audio_id: str
    scenes: list[Scene]
    aspect: str = "16:9"
    bg_id: str | None = None
    bg_color: str = "black"
    font: str = "Malgun Gothic"
    font_size: int = 28
    sections: list[SectionBg] = []


class ProjectReq(BaseModel):
    name: str
    state: dict


def _save_upload(file: UploadFile, default_ext: str) -> str:
    ext = os.path.splitext(file.filename or "")[1].lower() or default_ext
    name = uuid.uuid4().hex + ext
    with open(os.path.join(DATA, name), "wb") as f:
        shutil.copyfileobj(file.file, f)
    return name


@app.post("/api/align")
async def api_align(
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
    return {"audio_id": audio_id, "audio_url": f"/data/{audio_id}", "scenes": scenes}


@app.post("/api/upload-bg")
async def api_upload_bg(file: UploadFile = File(...)):
    bg_id = _save_upload(file, ".jpg")
    return {"bg_id": bg_id, "bg_url": f"/data/{bg_id}"}


@app.post("/api/images")
def api_images(req: ImagesReq):
    """장면 → 구간 묶기 (이미지는 아직 생성하지 않음)."""
    secs = images_mod.group_only([s.model_dump() for s in req.scenes], req.style)
    for s in secs:
        s.pop("image_path", None)
        s["image_id"] = ""
        s["image_url"] = ""
        s["subtitle"] = True
    return {"sections": secs}


@app.post("/api/candidates")
def api_candidates(req: CandidatesReq):
    """한 구간 프롬프트로 후보 이미지 N장 생성 (사용자가 1장 선택)."""
    try:
        cands = images_mod.generate_candidates(
            req.prompt, DATA, count=req.count, aspect=req.aspect, label=req.label,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"이미지 생성 실패: {e}")
    for c in cands:
        c["image_url"] = f"/data/{c['image_id']}"
        c.pop("path", None)
    return {"candidates": cands}


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
    try:
        out = render_mod.render(
            audio_path,
            [s.model_dump() for s in req.scenes],
            DATA,
            sections=sections,
            background_path=bg_path,
            aspect=req.aspect,
            bg_color=req.bg_color,
            font=req.font,
            font_size=req.font_size,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"영상 합성 실패: {e}")
    return {"video_url": f"/data/{os.path.basename(out)}"}


# ----- 프로젝트 저장/불러오기 (작업 내용 기억) -----
def _slug(name: str) -> str:
    s = re.sub(r"[^\w가-힣 .-]", "", name or "").strip().replace(" ", "_")
    return (s[:60] or "project")


@app.post("/api/projects")
def api_save_project(req: ProjectReq):
    slug = _slug(req.name)
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
app.mount("/data", StaticFiles(directory=DATA), name="data")
app.mount("/", StaticFiles(directory=FRONT, html=True), name="front")
