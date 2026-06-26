"""장면 목록 + 음악 + 배경 → ffmpeg로 유튜브용 MP4 합성.

배경은 두 가지 방식:
  - sections(구간별 이미지)가 있으면 → 구간마다 이미지를 시간순으로 이어 붙인
    배경 위에 자막을 얹는다. (2차: AI 이미지 배경)
  - 없으면 → 이미지 한 장 / 영상 클립 / 단색 중 하나를 전체 배경으로. (1차)

Windows 경로 주의: subtitles 필터는 절대경로의 콜론을 싫어하므로 SRT를
출력 폴더에 쓰고 cwd를 그 폴더로 둔 뒤 파일명만 넘긴다.
"""
import os
import subprocess
import uuid

from .srt import scenes_to_srt

ASPECTS = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
}

_VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}


def _style(font, font_size):
    return (
        f"FontName={font},FontSize={font_size},"
        "PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,"
        "BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=60"
    )


def _fit(w, h):
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )


def _probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except (ValueError, AttributeError):
        return 0.0


def _cmd_single(audio_path, background_path, srt_name, w, h, style, bg_color, out_name):
    cmd = ["ffmpeg", "-y"]
    if background_path and os.path.exists(background_path):
        ext = os.path.splitext(background_path)[1].lower()
        if ext in _VIDEO_EXT:
            cmd += ["-stream_loop", "-1", "-i", background_path]
        else:
            cmd += ["-loop", "1", "-i", background_path]
    else:
        cmd += ["-f", "lavfi", "-i", f"color=c={bg_color}:s={w}x{h}:r=30"]
    vf = f"{_fit(w, h)},subtitles={srt_name}:force_style='{style}'"
    cmd += ["-i", audio_path, "-map", "0:v", "-map", "1:a", "-vf", vf]
    return cmd


def _cmd_sections(audio_path, seg_bgs, srt_name, w, h, style, out_name):
    """구간별 이미지를 [0, 곡 길이] 전체에 타일처럼 이어 붙인 배경."""
    duration = _probe_duration(audio_path) or seg_bgs[-1]["end"]
    seg_bgs = sorted(seg_bgs, key=lambda s: float(s["start"]))

    segments = []  # (image_path, dur)
    for i, s in enumerate(seg_bgs):
        seg_start = 0.0 if i == 0 else float(s["start"])
        seg_end = float(seg_bgs[i + 1]["start"]) if i + 1 < len(seg_bgs) else duration
        dur = max(0.1, round(seg_end - seg_start, 3))
        segments.append((s["image_path"], dur))

    cmd = ["ffmpeg", "-y"]
    for img, dur in segments:
        cmd += ["-loop", "1", "-t", f"{dur}", "-i", img]
    cmd += ["-i", audio_path]  # 마지막 입력 = 오디오

    n = len(segments)
    fc = ""
    for k in range(n):
        fc += f"[{k}:v]{_fit(w, h)},fps=30[v{k}];"
    fc += "".join(f"[v{k}]" for k in range(n))
    fc += f"concat=n={n}:v=1:a=0[bg];"
    fc += f"[bg]subtitles={srt_name}:force_style='{style}'[v]"

    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", f"{n}:a"]
    return cmd


def render(
    audio_path: str,
    scenes,
    out_dir: str,
    sections=None,
    background_path: str | None = None,
    aspect: str = "16:9",
    bg_color: str = "black",
    font: str = "Malgun Gothic",
    font_size: int = 28,
) -> str:
    w, h = ASPECTS.get(aspect, (1920, 1080))
    os.makedirs(out_dir, exist_ok=True)

    srt_name = f"{uuid.uuid4().hex}.srt"
    out_name = f"{uuid.uuid4().hex}.mp4"
    srt_path = os.path.join(out_dir, srt_name)
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(scenes_to_srt(scenes))

    style = _style(font, font_size)

    seg_bgs = [
        s for s in (sections or [])
        if s.get("image_path") and os.path.exists(s["image_path"])
    ]
    if seg_bgs:
        cmd = _cmd_sections(audio_path, seg_bgs, srt_name, w, h, style, out_name)
    else:
        cmd = _cmd_single(audio_path, background_path, srt_name, w, h, style, bg_color, out_name)

    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "384k", "-ar", "48000",
        "-shortest", "-movflags", "+faststart",
        out_name,
    ]

    proc = subprocess.run(cmd, cwd=out_dir, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    try:
        os.remove(srt_path)
    except OSError:
        pass
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "")[-2000:])
    return os.path.join(out_dir, out_name)
