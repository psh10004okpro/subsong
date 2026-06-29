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


def _is_video(path):
    return os.path.splitext(path or "")[1].lower() in _VIDEO_EXT


def _fit(w, h):
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )


def _fade_str(total, intro_fade, outro_fade):
    """인트로/아웃트로 페이드 필터 문자열(없으면 '')."""
    parts = []
    if intro_fade and intro_fade > 0:
        parts.append(f"fade=t=in:st=0:d={round(float(intro_fade), 3)}")
    if outro_fade and outro_fade > 0 and total and total > outro_fade:
        st = round(total - float(outro_fade), 3)
        parts.append(f"fade=t=out:st={st}:d={round(float(outro_fade), 3)}")
    return ",".join(parts)


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


def _cmd_single(audio_path, background_path, ass_name, w, h, bg_color, fade=""):
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
    if fade:
        vf += f",{fade}"
    cmd += ["-i", audio_path, "-map", "0:v", "-map", "1:a", "-vf", vf]
    return cmd


def _cmd_sections(audio_path, seg_bgs, ass_name, w, h, fade=""):
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
        if _is_video(img):
            cmd += ["-stream_loop", "-1", "-t", f"{dur}", "-i", img]  # 구간 영상은 길이만큼 반복
        else:
            cmd += ["-loop", "1", "-t", f"{dur}", "-i", img]
    cmd += ["-i", audio_path]  # 마지막 입력 = 오디오

    n = len(segments)
    fc = ""
    for k in range(n):
        fc += f"[{k}:v]{_fit(w, h)},fps=30[v{k}];"
    fc += "".join(f"[v{k}]" for k in range(n))
    fc += f"concat=n={n}:v=1:a=0[bg];"
    tail = f"ass={ass_name}"
    if fade:
        tail += f",{fade}"
    fc += f"[bg]{tail}[v]"

    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", f"{n}:a"]
    return cmd


def _cmd_sections_fx(audio_path, seg_bgs, ass_name, w, h, total,
                     transition, trans_dur, ken_burns, fade=""):
    """구간 배경에 연출(크로스페이드/Ken Burns)을 입힌 합성 명령.

    - 크로스페이드(xfade): 영상이 (n-1)*D만큼 짧아지므로 마지막 빼고 각 구간을
      D만큼 늘려 오디오 길이를 유지한다.
    - Ken Burns(zoompan): 정지 이미지에 느린 줌(짝/홀 줌인·줌아웃 교대).
    - 자막/페이드는 배경(xfade/zoompan) 완성 후 [bg] 위에 굽는다.
    """
    seg_bgs = sorted(seg_bgs, key=lambda s: float(s["start"]))
    duration = total or float(seg_bgs[-1]["end"])
    n = len(seg_bgs)

    base = []
    for i, s in enumerate(seg_bgs):
        seg_start = 0.0 if i == 0 else float(s["start"])
        seg_end = float(seg_bgs[i + 1]["start"]) if i + 1 < n else duration
        base.append(max(0.1, round(seg_end - seg_start, 3)))

    xfade_on = transition == "crossfade" and n >= 2 and (trans_dur or 0) > 0
    D = round(float(trans_dur), 3) if xfade_on else 0.0
    kb = float(ken_burns or 0)
    # 크로스페이드 보상: 마지막 구간 빼고 D만큼 길게.
    durs = [base[i] + (D if (xfade_on and i < n - 1) else 0.0) for i in range(n)]
    # xfade는 겹칠 여유분이 필요(정지 이미지라 길게 잡아도 무해). concat은 정확히,
    # 단 마지막 구간만 여유 — zoompan 프레임 미세 부족으로 끝이 잘리는 것 방지(앞 구간 드리프트 없음).
    extra = (D + 0.3) if xfade_on else 0.0

    def clip_len(k):
        if xfade_on:
            return durs[k] + extra
        return durs[k] + (0.5 if k == n - 1 else 0.0)

    cmd = ["ffmpeg", "-y"]
    for i in range(n):
        p = seg_bgs[i]["image_path"]
        if _is_video(p):
            cmd += ["-stream_loop", "-1", "-t", f"{round(clip_len(i), 3)}", "-i", p]  # 구간 영상 반복
        elif kb > 0:
            cmd += ["-i", p]  # 정지 이미지 한 프레임 → zoompan이 길이 생성
        else:
            cmd += ["-loop", "1", "-t", f"{round(clip_len(i), 3)}", "-i", p]
    cmd += ["-i", audio_path]

    fc = ""
    for k in range(n):
        is_vid = _is_video(seg_bgs[k]["image_path"])
        chain = _fit(w, h)
        if kb > 0 and not is_vid:  # Ken Burns 줌은 정지 이미지에만(영상은 그대로)
            up = 4 if w >= h else 3  # 지터 방지용 사전 업스케일(느린 줌엔 4배면 충분, 렌더 빠름)
            frames = max(1, round(clip_len(k) * 30))
            travel = max(1, round(durs[k] * 30))  # 줌은 표시 길이 동안 완료
            inc = round(kb / travel, 6)
            zmax = round(1.0 + kb, 4)
            if k % 2 == 0:
                z = f"min(zoom+{inc},{zmax})"       # 줌 인
            else:
                z = f"if(lte(zoom,1.0),{zmax},max(zoom-{inc},1.0))"  # 줌 아웃
            chain += (
                f",scale={w * up}:{h * up}"
                f",zoompan=z='{z}':d={frames}:fps=30:s={w}x{h}"
                f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            )
        chain += ",fps=30,format=yuv420p,setsar=1"  # xfade는 fps/format 일치 필수
        fc += f"[{k}:v]{chain}[v{k}];"

    if xfade_on:
        acc = durs[0]
        prev = "v0"
        for j in range(1, n):
            off = round(acc - D, 3)
            out = "bg" if j == n - 1 else f"x{j}"
            fc += (f"[{prev}][v{j}]xfade=transition=fade:"
                   f"duration={D}:offset={off}[{out}];")
            acc = round(acc - D + durs[j], 3)
            prev = out
    else:
        fc += "".join(f"[v{k}]" for k in range(n))
        fc += f"concat=n={n}:v=1:a=0[bg];"

    tail = f"ass={ass_name}"
    if fade:
        tail += f",{fade}"
    fc += f"[bg]{tail}[v]"

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
    transition: str = "none",      # "none"(하드컷) | "crossfade"
    transition_dur: float = 0.8,   # 크로스페이드 길이(초)
    ken_burns: float = 0.0,        # 0=정지, 0.06~0.10=약한 줌
    intro_fade: float = 0.0,       # 0=없음, 인트로 페이드인(초)
    outro_fade: float = 0.0,       # 0=없음, 아웃트로 페이드아웃(초)
    intro_title: str = "",         # 인트로 타이틀 카드 문구(빈 값=없음)
    intro_title_dur: float = 3.0,  # 타이틀 카드 표시 길이(초)
    text_color: str = "",          # 자막 기본 글자색(빈 값=프리셋)
    hi_color: str = "",            # 강조(부르는 단어) 색
    outline_color: str = "",       # 외곽선 색
    job=None,
    progress_range=(0.0, 1.0),
) -> str:
    w, h = ASPECTS.get(aspect, (1920, 1080))
    os.makedirs(out_dir, exist_ok=True)

    # ASS 문자열을 먼저 만든다(여기서 실패하면 파일을 만들지 않음 → 누수 방지).
    ass_text = ass_mod.build_ass(scenes, w, h, subtitle_style, font=font,
                                 font_size=font_size, position=subtitle_pos,
                                 intro_title=intro_title, intro_title_dur=intro_title_dur,
                                 text_color=text_color, hi_color=hi_color,
                                 outline_color=outline_color)
    ass_name = f"{uuid.uuid4().hex}.ass"
    out_name = f"{uuid.uuid4().hex}.mp4"
    ass_path = os.path.join(out_dir, ass_name)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_text)

    total = _probe_duration(audio_path)
    fade = _fade_str(total, intro_fade, outro_fade)

    seg_bgs = [
        s for s in (sections or [])
        if s.get("image_path") and os.path.exists(s["image_path"])
    ]
    # 연출 ON(전환 또는 켄번즈) + 구간 2개 이상일 때만 fx 경로. 그 외엔 기존 경로(+페이드).
    fx_on = (transition != "none" or (ken_burns or 0) > 0) and len(seg_bgs) >= 2
    if seg_bgs and fx_on:
        cmd = _cmd_sections_fx(audio_path, seg_bgs, ass_name, w, h, total,
                               transition, transition_dur, ken_burns, fade)
    elif seg_bgs:
        cmd = _cmd_sections(audio_path, seg_bgs, ass_name, w, h, fade)
    else:
        cmd = _cmd_single(audio_path, background_path, ass_name, w, h, bg_color, fade)

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
