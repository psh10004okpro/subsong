"""장면 목록 + 음악 + 배경 → ffmpeg로 유튜브용 MP4 합성.

자막은 ASS로 굽는다(단어 노래방 하이라이트 + 스타일 프리셋, backend/ass.py).
배경: 구간별 이미지(sections) 이어붙임 / 단일 이미지·영상·단색.

Windows 경로 주의: ass/subtitles 필터는 절대경로 콜론을 싫어하므로 자막 파일을
출력 폴더에 쓰고 cwd를 그 폴더로 둔 뒤 파일명만 넘긴다.
"""
import os
import subprocess
import uuid

from . import ass as ass_mod

ASPECTS = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
}

_VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}


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


def _cmd_single(audio_path, background_path, ass_name, w, h, bg_color):
    cmd = ["ffmpeg", "-y"]
    if background_path and os.path.exists(background_path):
        ext = os.path.splitext(background_path)[1].lower()
        if ext in _VIDEO_EXT:
            cmd += ["-stream_loop", "-1", "-i", background_path]
        else:
            cmd += ["-loop", "1", "-i", background_path]
    else:
        cmd += ["-f", "lavfi", "-i", f"color=c={bg_color}:s={w}x{h}:r=30"]
    vf = f"{_fit(w, h)},ass={ass_name}"
    cmd += ["-i", audio_path, "-map", "0:v", "-map", "1:a", "-vf", vf]
    return cmd


def _cmd_sections(audio_path, seg_bgs, ass_name, w, h):
    """구간별 이미지를 [0, 곡 길이] 전체에 타일처럼 이어 붙인 배경 + ASS 자막."""
    duration = _probe_duration(audio_path) or seg_bgs[-1]["end"]
    seg_bgs = sorted(seg_bgs, key=lambda s: float(s["start"]))

    segments = []
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
    fc += f"[bg]ass={ass_name}[v]"

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
    font_size: int = 48,
    subtitle_style: str = "ballad",
    subtitle_pos: str = "bottom",
    job=None,
    progress_range=(0.0, 1.0),
) -> str:
    w, h = ASPECTS.get(aspect, (1920, 1080))
    os.makedirs(out_dir, exist_ok=True)

    # ASS 문자열을 먼저 만든다(여기서 실패하면 파일을 만들지 않음 → 누수 방지).
    ass_text = ass_mod.build_ass(scenes, w, h, subtitle_style, font=font,
                                 font_size=font_size, position=subtitle_pos)
    ass_name = f"{uuid.uuid4().hex}.ass"
    out_name = f"{uuid.uuid4().hex}.mp4"
    ass_path = os.path.join(out_dir, ass_name)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_text)

    seg_bgs = [
        s for s in (sections or [])
        if s.get("image_path") and os.path.exists(s["image_path"])
    ]
    if seg_bgs:
        cmd = _cmd_sections(audio_path, seg_bgs, ass_name, w, h)
    else:
        cmd = _cmd_single(audio_path, background_path, ass_name, w, h, bg_color)

    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-profile:v", "high", "-bf", "2",
        "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "384k", "-ar", "48000",
        "-shortest", "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        out_name,
    ]

    total = _probe_duration(audio_path)
    proc = subprocess.Popen(cmd, cwd=out_dir, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace")
    if job is not None:
        job.proc = proc

    lo, hi = progress_range
    for line in proc.stdout:
        line = line.strip()
        if line.startswith("out_time_us=") and total > 0:
            try:
                us = int(line.split("=", 1)[1])
                if job is not None:
                    frac = min(1.0, max(0.0, us / 1_000_000 / total))
                    job.progress = min(0.999, lo + frac * (hi - lo))
            except ValueError:
                pass
        elif line.startswith("progress=") and line.endswith("end"):
            if job is not None:
                job.progress = hi
        if job is not None and job.cancelled:
            try:
                proc.terminate()
            except Exception:
                pass
            break

    proc.wait()
    err = proc.stderr.read() if proc.stderr else ""
    try:
        os.remove(ass_path)
    except OSError:
        pass

    out_path = os.path.join(out_dir, out_name)
    if job is not None and job.cancelled:
        try:
            os.remove(out_path)
        except OSError:
            pass
        return None
    if proc.returncode != 0:
        raise RuntimeError((err or "")[-2000:])
    return out_path
