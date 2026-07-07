"""롱폼 아바타 — 인물 talking_head 1개(전체 나레이션) + 가상 카메라 + B-roll 합성.

긴 아바타 영상이 '한 화면 고정'으로 지루해지지 않도록:
  1) presenter talking_head를 딱 1개만 생성(비싼 단계) → 연속 나레이션 오디오 확보.
  2) 대본을 문장 단위로 나눠 시간을 배분(문자수 비례).
  3) 구간마다 presenter 컷(시간대별 크롭/줌 = 가상 카메라) 또는 B-roll 컷(주제 이미지)으로 교차.
  4) 오디오는 presenter 원본을 그대로 깔아 립싱크(=presenter 구간)와 보이스오버(=B-roll)를 동시에.
ffmpeg로 한 번에 합성. 자막은 문장 텍스트로 굽는다.
"""
import os
import subprocess
import uuid

from . import ass as ass_mod
from . import images as images_mod
from . import render as render_mod
from . import story as story_mod

ASPECTS = render_mod.ASPECTS
FONT = os.environ.get("SUBSONG_FONT", "NanumGothic")

# 가상 카메라 프레이밍(정적 크롭) — presenter 구간마다 순환해 '컷 전환' 느낌을 준다.
# 캔버스=presenter 네이티브 해상도라, 여기선 '살짝 확대'만(머리 잘림 방지, 위쪽 유지).
# (zoom, y_center) — y_center 0=위(얼굴)/0.5=중앙. None=원본 그대로(풀샷).
CAM = [None, (1.12, 0.15), (1.22, 0.1), (1.08, 0.2)]


def _cam_filter(idx, w, h):
    c = CAM[idx % len(CAM)]
    if not c:
        return f"scale={w}:{h},setsar=1"
    z, yc = c
    return (f"crop=iw/{z}:ih/{z}:(iw-iw/{z})/2:(ih-ih/{z})*{yc},scale={w}:{h},setsar=1")


def _probe_wh(path):
    import subprocess
    o = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True,
    )
    try:
        w, h = o.stdout.strip().split("x")
        return int(w), int(h)
    except (ValueError, AttributeError):
        return 0, 0


def _roles(n):
    """구간 역할: 처음·끝은 presenter, 가운데는 presenter/B-roll 교차."""
    roles = ["P"] * n
    for i in range(1, n - 1):
        roles[i] = "B" if (i % 2 == 1) else "P"
    return roles


def _timings(segs, total):
    """문장 → [start,end,text] (문자수 비례로 total 배분)."""
    lens = [max(1, len(s)) for s in segs]
    tot = sum(lens)
    out = []
    t = 0.0
    for i, s in enumerate(segs):
        dur = total * lens[i] / tot
        out.append([round(t, 3), round(t + dur, 3), s])
        t += dur
    out[-1][1] = round(total, 3)
    return out


def build(presenter_path, script, out_dir, aspect="9:16",
          subtitles=True, tone_style="", provider=None, job=None):
    """presenter mp4 + 대본 → 롱폼 합성 mp4 id."""
    # presenter 네이티브 해상도를 캔버스로 사용(talking_head는 16:9 가로로 나오는 경우가 많음).
    pw, ph = _probe_wh(presenter_path)
    if pw and ph:
        w, h = pw, ph
        broll_aspect = "16:9" if pw > ph * 1.2 else ("9:16" if ph > pw * 1.2 else "1:1")
    else:
        w, h = ASPECTS.get(aspect, (1080, 1920))
        broll_aspect = aspect
    duration = render_mod.probe_duration(presenter_path)
    if duration <= 0:
        raise RuntimeError("presenter 영상 길이를 읽지 못했습니다.")
    segs = story_mod.split_segments(script)
    if not segs:
        raise ValueError("대본이 비어 있습니다.")
    times = _timings(segs, duration)
    roles = _roles(len(times))

    # B-roll 이미지 생성 (실패 구간은 presenter로 대체)
    b_idx = [i for i, r in enumerate(roles) if r == "B"]
    imgs = {}
    if b_idx:
        if job is not None:
            job.message = f"B-roll 이미지 {len(b_idx)}장 생성 중"; job.progress = 0.9
        prompts = story_mod.visual_prompts([times[i][2] for i in b_idx], "knowledge", tone_style)
        for k, i in enumerate(b_idx):
            if job is not None and job.cancelled:
                raise RuntimeError("취소됨")
            try:
                res = images_mod.generate_candidates(prompts[k], out_dir, count=1,
                                                     aspect=broll_aspect, provider=provider)
                imgs[i] = os.path.join(out_dir, res[0]["image_id"])
            except Exception:
                roles[i] = "P"  # 이미지 실패 → presenter 컷으로

    if job is not None:
        job.message = "영상 합성 중"; job.progress = 0.95

    # ffmpeg 입력: 0 = presenter, 이후 B-roll 이미지들(-loop)
    cmd = ["ffmpeg", "-y", "-i", presenter_path]
    b_input = {}
    ni = 1
    for i, r in enumerate(roles):
        if r == "B":
            dur = round(times[i][1] - times[i][0], 3)
            cmd += ["-loop", "1", "-t", f"{dur}", "-i", imgs[i]]
            b_input[i] = ni
            ni += 1

    n_pres = roles.count("P")
    fc = f"[0:v]split={n_pres}" + "".join(f"[p{k}]" for k in range(n_pres)) + ";"
    p_used = 0
    for i, (s, e, _txt) in enumerate(times):
        if roles[i] == "P":
            fc += (f"[p{p_used}]trim=start={s}:end={e},setpts=PTS-STARTPTS,"
                   f"{_cam_filter(p_used, w, h)},fps=30,format=yuv420p,setsar=1[v{i}];")
            p_used += 1
        else:
            j = b_input[i]
            up = 4
            frames = max(1, round((times[i][1] - times[i][0]) * 30))
            fc += (f"[{j}:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                   f"scale={w * up}:{h * up},"
                   f"zoompan=z='min(zoom+0.0009,1.12)':d={frames}:fps=30:s={w}x{h}"
                   f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',"
                   f"fps=30,format=yuv420p,setsar=1[v{i}];")
    fc += "".join(f"[v{i}]" for i in range(len(times)))
    fc += f"concat=n={len(times)}:v=1:a=0[vc]"

    ass_name = None
    if subtitles:
        scenes = [{"start": s, "end": e, "text": txt, "words": []} for s, e, txt in times]
        ass_text = ass_mod.build_ass(scenes, w, h, "simple", font=FONT, font_size=48,
                                     position="bottom", total_duration=duration)
        ass_name = f"{uuid.uuid4().hex}.ass"
        with open(os.path.join(out_dir, ass_name), "w", encoding="utf-8") as f:
            f.write(ass_text)
        fc += f";[vc]{render_mod._ass_filter(ass_name, out_dir)}[vo]"
        vmap = "[vo]"
    else:
        vmap = "[vc]"

    out_name = f"{uuid.uuid4().hex}.mp4"
    cmd += ["-filter_complex", fc, "-map", vmap, "-map", "0:a",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-shortest", "-movflags", "+faststart", "-loglevel", "error", out_name]

    proc = subprocess.run(cmd, cwd=out_dir, capture_output=True, text=True)
    if ass_name:
        try:
            os.remove(os.path.join(out_dir, ass_name))
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "")[-1500:])
    if job is not None:
        job.message = "완료"; job.progress = 1.0
    return out_name
