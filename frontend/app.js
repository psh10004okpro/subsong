let scenes = [];
let audioId = null;
let bgId = null;
let sectionsState = [];
let stopAt = null;
let statusTimer = null;
let isAligning = false;
let localAudioUrl = null;
let anchor = null; // 일관성 참조 { image_id, image_url, has_face }
let useRef = true;

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const sampleLyrics = [
  "어두운 밤하늘 아래",
  "너의 이름을 불러본다",
  "바람이 스쳐 지나가도",
  "이 노래는 남아 있을 거야",
].join("\n");

function fmt(t) {
  t = Math.max(0, +t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + s.toFixed(1).padStart(4, "0");
}

function parseTime(v) {
  v = ("" + v).trim();
  if (!v) return 0;
  if (v.includes(":")) {
    const [m, s] = v.split(":");
    return (parseFloat(m) || 0) * 60 + (parseFloat(s) || 0);
  }
  return parseFloat(v) || 0;
}

function round2(n) {
  return Math.round((+n || 0) * 100) / 100;
}

function status(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
  if (statusTimer) clearTimeout(statusTimer);
  if (kind === "ok" || kind === "err") {
    statusTimer = setTimeout(() => el.classList.add("hidden"), 4200);
  }
}

function busy(msg) {
  status(msg);
}

// 전역 안전망 — try/catch 밖에서 터지는 예외·미처리 프라미스도 사용자에게 알린다.
window.addEventListener("error", (e) => {
  if (e.target && e.target !== window) return; // 리소스(img 등) 로드 실패는 제외
  status("예기치 못한 오류가 발생했습니다: " +
    (e.message || (e.error && e.error.message) || "알 수 없음"), "err");
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  status("처리되지 않은 오류: " + (r && r.message ? r.message : String(r)), "err");
});

function lyricLines() {
  return $("lyrics").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function updateLyricStats() {
  const value = $("lyrics").value;
  $("lyricStats").textContent = `${lyricLines().length}줄 · ${value.length}자`;
  updateActionState();
}

function updateActionState() {
  const hasSource = Boolean($("audioFile").files[0]);
  const hasLyrics = lyricLines().length > 0;
  const hasScenes = scenes.length > 0;
  const timingOk = !hasTimingIssues();

  $("alignBtn").disabled = isAligning || !hasSource || !hasLyrics;
  $("srtBtn").disabled = !hasScenes || !timingOk;
  $("renderBtn").disabled = !audioId || !hasScenes || !timingOk;
  $("genImagesBtn").disabled = !hasScenes;
  $("editorEmpty").classList.toggle("hidden", hasScenes);
  $("editorTools").classList.toggle("hidden", !hasScenes);
  $("lineSummary").textContent = hasScenes
    ? `${scenes.length}줄 · ${timingOk ? "시간 정상" : "시간 확인 필요"}`
    : "0줄";
}

function hasTimingIssues() {
  return scenes.some((sc) => Number(sc.end) <= Number(sc.start));
}

let currentStep = 1;
function goStep(n) {
  currentStep = Math.max(1, Math.min(4, n));
  document.querySelectorAll(".steps li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === currentStep);
    li.classList.toggle("done", s < currentStep);
    if (s === currentStep) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  document.querySelectorAll(".step").forEach((p) => {
    p.classList.remove("hidden");
    p.classList.toggle("active", Number(p.dataset.step) === currentStep);
  });
  const withStage = currentStep >= 2;
  $("stage").classList.toggle("hidden", !withStage);
  document.querySelector(".studio").classList.toggle("with-stage", withStage);
  $("prevStep").classList.toggle("hidden", currentStep === 1);
  $("nextStep").classList.toggle("hidden", currentStep === 4);
  if (withStage) {
    setPreviewAspect();
    updatePreview();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function getAspect() {
  const checked = document.querySelector('input[name="aspect"]:checked');
  return checked ? checked.value : "16:9";
}

function normalizeScenes(input) {
  return input.map((sc, i) => ({
    id: Number.isFinite(sc.id) ? sc.id : i,
    start: round2(sc.start),
    end: round2(sc.end),
    text: sc.text || "",
    section: sc.section || "",
    words: sc.words || [],
    confidence: Number.isFinite(sc.confidence) ? sc.confidence : null,
    image_prompt: sc.image_prompt || "",
    image_path: sc.image_path || "",
    video_path: sc.video_path || "",
  }));
}

async function doAlign() {
  const file = $("audioFile").files[0];
  const lyrics = $("lyrics").value.trim();
  if (!file) return status("음원 파일을 선택하세요.", "err");
  if (!lyrics) return status("가사를 입력하세요.", "err");

  isAligning = true;
  updateActionState();
  $("alignBtn").textContent = "정렬 중…";
  busy("자동 정렬 중입니다. 첫 실행이면 모델 다운로드 때문에 오래 걸릴 수 있습니다.");

  const fd = new FormData();
  fd.append("audio", file);
  fd.append("lyrics", lyrics);
  fd.append("language", $("language").value);

  try {
    const res = await fetch("/api/align", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);

    audioId = data.audio_id;
    scenes = normalizeScenes(data.scenes || []);
    audio.src = data.audio_url;
    stopAt = null;
    sectionsState = [];
    renderRows();
    renderSectionCards();
    resetHistory(); // 정렬 결과를 되돌리기 시작점으로
    goStep(2);
    status(`정렬 완료: ${scenes.length}줄. 미리보기로 확인하며 고치세요.`, "ok");
  } catch (e) {
    status("정렬 실패: " + e.message, "err");
  } finally {
    isAligning = false;
    $("alignBtn").textContent = "자동 정렬 시작";
    updateActionState();
  }
}

function renderRows() {
  const box = $("lines");
  box.innerHTML = "";

  scenes.forEach((scene, index) => {
    const row = document.createElement("div");
    row.className = "line";
    row.dataset.i = index;
    row.classList.toggle("invalid", scene.end <= scene.start);

    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(index + 1);
    // 정렬 신뢰도 낮음 / 긴 줄 경고
    const flags = [];
    if (scene.confidence != null && scene.confidence < 0.45)
      flags.push(`정렬 신뢰도 낮음 (${Math.round(scene.confidence * 100)}%) — 타이밍 확인 권장`);
    if ((scene.text || "").length > 40)
      flags.push("긴 줄 — 자막이 자동으로 두 줄 줄바꿈됩니다");
    if (flags.length) {
      row.classList.add("flagged");
      const flag = document.createElement("span");
      flag.className = "line-flag";
      flag.textContent = "⚠";
      flag.title = flags.join(" · ");
      number.appendChild(flag);
    }

    const start = makeInput("start time-input", fmt(scene.start), "시작 시간");
    const end = makeInput("end time-input", fmt(scene.end), "끝 시간");
    const lyric = makeInput("lyric", scene.text, "가사");

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.append(
      makeButton("setstart", "시작", "현재 재생 위치를 시작 시간으로 적용"),
      makeButton("setend", "끝", "현재 재생 위치를 끝 시간으로 적용"),
      makeButton("play", "재생", "이 줄만 재생"),
      makeButton("del", "삭제", "이 줄 삭제", "danger"),
    );

    row.append(number, start, end, lyric, actions);
    box.appendChild(row);
  });

  updateCurrentLine();
  updateActionState();
  recordHistorySoon();
}

function makeInput(className, value, label) {
  const input = document.createElement("input");
  input.className = className;
  input.value = value;
  input.setAttribute("aria-label", label);
  return input;
}

function makeButton(action, text, label, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-btn ${extraClass}`.trim();
  button.dataset.act = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

// 구간(section)의 start/end는 소속 장면들에서 파생된 값이라, 장면 시간을 고치면
// 같이 갱신해 줘야 미리보기·렌더의 배경 타이밍이 어긋나지 않는다.
function syncSectionTimes() {
  if (!sectionsState.length) return;
  const byId = new Map(scenes.map((s) => [s.id, s]));
  sectionsState.forEach((sec) => {
    const members = (sec.scene_ids || []).map((id) => byId.get(id)).filter(Boolean);
    if (members.length) {
      sec.start = round2(Math.min(...members.map((m) => m.start)));
      sec.end = round2(Math.max(...members.map((m) => m.end)));
    }
  });
}

function updateRowFromInput(target) {
  const row = target.closest(".line");
  if (!row) return;
  const i = Number(row.dataset.i);
  const scene = scenes[i];
  if (!scene) return;

  if (target.classList.contains("start")) {
    scene.start = round2(parseTime(target.value));
    target.value = fmt(scene.start);
  } else if (target.classList.contains("end")) {
    scene.end = round2(parseTime(target.value));
    target.value = fmt(scene.end);
  } else if (target.classList.contains("lyric")) {
    scene.text = target.value;
  }

  row.classList.toggle("invalid", scene.end <= scene.start);
  if (scene.end <= scene.start) {
    status("끝 시간은 시작 시간보다 커야 합니다.", "err");
  }
  syncSectionTimes();
  updateActionState();
  updatePreview();
}

function updateCurrentLine() {
  const t = audio.currentTime || 0;
  $("playhead").textContent = fmt(t);
  document.querySelectorAll(".line").forEach((row) => {
    const sc = scenes[Number(row.dataset.i)];
    row.classList.toggle("current", Boolean(sc && t >= sc.start && t < sc.end));
  });
}

function setAudioPreview(file) {
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  localAudioUrl = file ? URL.createObjectURL(file) : null;
  if (localAudioUrl && !audioId) audio.src = localAudioUrl;
}

$("audioFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  audioId = null;
  scenes = [];
  sectionsState = [];
  anchor = null;
  renderRows();
  renderSectionCards();
  renderAnchor();
  goStep(1);
  setAudioPreview(file);
  $("audioName").textContent = file ? file.name : "MP3, WAV 등 오디오 파일 선택";
  $("audioMeta").textContent = file ? "정렬 전 미리듣기" : "음원을 선택하면 재생할 수 있습니다.";
  updateActionState();
});

$("lyrics").addEventListener("input", updateLyricStats);

$("sampleBtn").addEventListener("click", () => {
  if (!$("lyrics").value.trim()) {
    $("lyrics").value = sampleLyrics;
  } else {
    $("lyrics").value += "\n" + sampleLyrics;
  }
  updateLyricStats();
  $("lyrics").focus();
});

$("lines").addEventListener("change", (e) => {
  if (e.target.matches("input")) updateRowFromInput(e.target);
});

$("lines").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  const row = button.closest(".line");
  const i = Number(row.dataset.i);
  const scene = scenes[i];
  if (!scene) return;

  if (button.dataset.act === "setstart") {
    scene.start = round2(audio.currentTime || 0);
    row.querySelector(".start").value = fmt(scene.start);
  } else if (button.dataset.act === "setend") {
    scene.end = round2(audio.currentTime || 0);
    row.querySelector(".end").value = fmt(scene.end);
  } else if (button.dataset.act === "play") {
    if (!audio.paused) { // 재생 중이면 정지(토글)
      audio.pause();
      stopAt = null;
    } else {
      audio.currentTime = scene.start;
      stopAt = scene.end;
      audio.play().catch((err) =>
        status("이 줄을 재생할 수 없습니다(오디오 미로드일 수 있음): " + err.message, "err"));
    }
  } else if (button.dataset.act === "del") {
    scenes.splice(i, 1);
    syncSectionTimes();
    renderRows();
    updatePreview();
    return;
  }

  row.classList.toggle("invalid", scene.end <= scene.start);
  syncSectionTimes();
  updateActionState();
  updatePreview();
});

$("addRow").addEventListener("click", () => {
  const t = round2(audio.currentTime || 0);
  // scenes.length는 줄을 지운 뒤 기존 id와 충돌할 수 있다 → 최대 id + 1로 발급.
  const nextId = scenes.reduce((m, s) => Math.max(m, s.id), -1) + 1;
  scenes.push({
    id: nextId,
    start: t,
    end: round2(t + 2),
    text: "",
    image_prompt: "",
    image_path: "",
    video_path: "",
  });
  renderRows();
});

audio.addEventListener("loadedmetadata", () => {
  $("audioMeta").textContent = Number.isFinite(audio.duration)
    ? `길이 ${fmt(audio.duration)}`
    : "재생 준비 완료";
});

audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime || 0;
  if (stopAt !== null && t >= stopAt) {
    audio.pause();
    stopAt = null;
  }
  updateCurrentLine();
  updatePreview();
});
audio.addEventListener("seeked", updatePreview);
audio.addEventListener("error", () => {
  // 빈 src(초기 상태)에서의 무해한 이벤트는 무시.
  if (!audio.currentSrc) return;
  status("오디오를 불러오지 못했습니다. 음원 파일을 다시 선택하거나 프로젝트를 다시 정렬하세요.", "err");
});

$("bgFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  busy("배경 파일 업로드 중입니다.");

  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload-bg", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    bgId = data.bg_id;
    bgName = file.name;
    updateBgNote();
    status("배경 업로드 완료", "ok");
  } catch (err) {
    status("배경 업로드 실패: " + err.message, "err");
  }
});

// 공통 배경은 '구간 배경이 하나도 없을 때만' 적용됨 — 상태에 맞게 안내(조용한 무시 방지)
let bgName = "";
function updateBgNote() {
  const el = $("bgName");
  if (!el) return;
  const hasSecImg = sectionsState.some((s) => s.image_id);
  if (bgId) {
    el.textContent = hasSecImg
      ? `⚠ ${bgName || "공통 배경"} — 구간 배경이 있어 이 공통 배경은 사용되지 않습니다.`
      : `${bgName || "업로드된 배경"} 적용됨.`;
  } else {
    el.textContent = hasSecImg
      ? "구간 배경을 사용합니다. (공통 배경은 구간 이미지가 하나도 없을 때만 적용)"
      : "선택하지 않으면 구간 이미지 또는 배경색을 씁니다.";
  }
}

$("srtBtn").addEventListener("click", async () => {
  if (!scenes.length) return status("먼저 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");

  try {
    const res = await fetch("/api/srt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lyrics.srt";
    a.click();
    URL.revokeObjectURL(a.href);
    status("SRT 저장 완료", "ok");
  } catch (e) {
    status("SRT 내보내기 실패: " + e.message, "err");
  }
});

let renderJobId = null;
let renderES = null;

function showRenderProgress(frac) {
  $("renderProgress").classList.remove("hidden");
  const pct = Math.round((frac || 0) * 100);
  $("renderBar").style.width = pct + "%";
  $("renderPct").textContent = pct + "%";
}
function hideRenderProgress() {
  $("renderProgress").classList.add("hidden");
  $("renderBar").style.width = "0%";
}
function endRender() {
  if (renderES) {
    renderES.close();
    renderES = null;
  }
  renderJobId = null;
  $("renderBtn").disabled = false;
  updateActionState();
}

function renderResults(videos) {
  const box = $("result");
  box.innerHTML = "";
  if (!videos.length) {
    box.classList.add("hidden");
    return;
  }
  videos.forEach((v) => {
    const item = document.createElement("div");
    item.className = "result-item";
    if (v.aspect) {
      const tag = document.createElement("div");
      tag.className = "muted";
      tag.textContent = v.aspect;
      item.appendChild(tag);
    }
    const vid = document.createElement("video");
    vid.controls = true;
    vid.src = v.video_url;
    const a = document.createElement("a");
    a.className = "download-link";
    a.href = v.video_url;
    a.download = "music_video" + (v.aspect ? "_" + v.aspect.replace(":", "x") : "") + ".mp4";
    a.textContent = "영상 다운로드";
    item.append(vid, a);
    box.appendChild(item);
  });
  box.classList.remove("hidden");
}

function listenRenderJob(jid) {
  if (renderES) renderES.close();
  renderES = new EventSource(`/api/jobs/${jid}/events`);
  renderES.onmessage = (ev) => {
    let j;
    try {
      j = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    showRenderProgress(j.progress || 0);
    if (j.status === "done") {
      const r = j.result || {};
      const vids = r.videos && r.videos.length
        ? r.videos
        : (r.video_url ? [{ aspect: "", video_url: r.video_url }] : []);
      renderResults(vids);
      hideRenderProgress();
      endRender();
      status(`영상 생성 완료 (${vids.length}개). 아래에서 확인하세요.`, "ok");
    } else if (j.status === "error") {
      hideRenderProgress();
      endRender();
      status("영상 생성 실패: " + (j.error || ""), "err");
    } else if (j.status === "cancelled") {
      hideRenderProgress();
      endRender();
      status("렌더를 취소했습니다.", "ok");
    } else {
      busy(`영상 합성 중… ${Math.round((j.progress || 0) * 100)}%`);
    }
  };
  renderES.onerror = () => {
    // 일시 끊김은 EventSource가 자동 재연결하므로 CLOSED(완전 종료)일 때만 복구한다.
    if (!renderES || renderES.readyState !== EventSource.CLOSED) return;
    // 스피너가 영구히 멈추지 않도록: 서버에 작업 상태를 한 번 더 물어 결과를 반영하고 UI를 정리.
    fetch(`/api/jobs/${jid}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("상태 조회 실패"))))
      .then((j) => {
        if (j.status === "done") {
          const r = j.result || {};
          const vids = r.videos && r.videos.length
            ? r.videos
            : (r.video_url ? [{ aspect: "", video_url: r.video_url }] : []);
          renderResults(vids);
          status(`영상 생성 완료 (${vids.length}개).`, "ok");
        } else if (j.status === "error") {
          status("영상 생성 실패: " + (j.error || ""), "err");
        } else {
          status("진행 상황 연결이 끊겼습니다. 작업은 서버에서 계속되니 잠시 후 새로고침해 결과를 확인하세요.", "err");
        }
      })
      .catch(() => status("진행 상황 연결이 끊겼습니다. 잠시 후 새로고침해 결과를 확인하세요.", "err"))
      .finally(() => { hideRenderProgress(); endRender(); });
  };
}

$("cancelRenderBtn").addEventListener("click", async () => {
  if (!renderJobId) return;
  try {
    await fetch(`/api/jobs/${renderJobId}/cancel`, { method: "POST" });
    status("취소 요청을 보냈습니다…", "ok");
  } catch (e) {
    status("취소 실패: " + e.message, "err");
  }
});

$("renderBtn").addEventListener("click", async () => {
  if (!audioId || !scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");

  $("renderBtn").disabled = true;
  showRenderProgress(0);
  busy("영상 합성 준비 중…");

  // 자막 off 구간의 줄은 자막에서 제외
  const offIds = new Set();
  sectionsState.forEach((s) => {
    if (s.subtitle === false) (s.scene_ids || []).forEach((id) => offIds.add(id));
  });
  const subScenes = scenes.filter((s) => !offIds.has(s.id));
  const primary = getAspect();
  const aspects = $("alsoShorts").checked ? [...new Set([primary, "9:16"])] : [primary];

  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_id: audioId,
        scenes: subScenes,
        aspect: primary,
        aspects,
        bg_id: bgId,
        bg_color: $("bgColor").value,
        font_size: Number($("fontSize").value) || 48,
        subtitle_style: $("subtitleStyle").value,
        subtitle_pos: $("subtitlePos").value,
        font: $("fontSelect").value,
        text_color: $("textColor").value,
        hi_color: $("hiColor").value,
        outline_color: $("outlineColor").value,
        transition: $("transition").value,
        transition_dur: Number($("transitionDur").value) || 0.8,
        ken_burns: Number($("kenBurns").value) || 0,
        intro_fade: $("introOutro").checked ? (Number($("introFade").value) || 0) : 0,
        outro_fade: $("introOutro").checked ? (Number($("outroFade").value) || 0) : 0,
        intro_title: $("introTitle").checked ? $("songTitle").value.trim() : "",
        intro_title_dur: Number($("introTitleDur").value) || 3.0,
        sections: sectionsState
          .filter((s) => s.image_id)
          .map((s) => ({ start: s.start, end: s.end, image_id: s.image_id })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    renderJobId = data.job_id;
    listenRenderJob(renderJobId);
  } catch (e) {
    status("영상 생성 실패: " + e.message, "err");
    hideRenderProgress();
    endRender();
  }
});

$("alignBtn").addEventListener("click", doAlign);

window.addEventListener("beforeunload", (e) => {
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  // 렌더 진행 중이거나 정렬 중이면 새로고침/닫기 전에 경고(작업·결과 유실 방지).
  if (renderJobId || isAligning) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---- 2차: 구간별 배경 이미지 (후보 N장 생성 → 1장 선택) ----
const CANDIDATE_COUNT = 4;

function isVideoUrl(u) {
  return /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(u || "");
}

function renderSectionCards() {
  const box = $("sections");
  box.innerHTML = "";
  if (!sectionsState.length) {
    const empty = document.createElement("div");
    empty.className = "sections-empty";
    empty.textContent = scenes.length
      ? "‘구간 나누기’를 눌러 시작하세요. 구간마다 AI 배경을 만들거나 이미지를 올립니다."
      : "먼저 1단계에서 자동 정렬을 완료하세요.";
    box.appendChild(empty);
    recordHistorySoon();
    return;
  }
  sectionsState.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "section-card" + (s._generating ? " loading" : "");
    card.dataset.i = i;

    const thumb = document.createElement("div");
    thumb.className = "section-thumb";
    if (s.image_url) {
      if (isVideoUrl(s.image_url)) {
        thumb.classList.add("is-video");
        const vb = document.createElement("span");
        vb.className = "video-badge";
        vb.textContent = "🎬 영상";
        thumb.appendChild(vb);
      } else {
        thumb.style.backgroundImage = `url('${s.image_url}?t=${Date.now()}')`;
      }
    }

    const head = document.createElement("div");
    head.className = "section-head";
    const label = document.createElement("b");
    label.textContent = s.label || "";
    const right = document.createElement("span");
    right.className = "section-head-right";
    const subLabel = document.createElement("label");
    subLabel.className = "sub-toggle";
    subLabel.title = "체크 해제 시 이 구간 자막을 넣지 않습니다";
    const subChk = document.createElement("input");
    subChk.type = "checkbox";
    subChk.className = "subtitle-toggle";
    subChk.checked = s.subtitle !== false;
    const subText = document.createElement("span");
    subText.textContent = "자막";
    subLabel.append(subChk, subText);
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = `${fmt(s.start)}–${fmt(s.end)}`;
    right.append(subLabel, time);
    head.append(label, right);

    const rowEl = document.createElement("div");
    rowEl.className = "section-row";
    const input = document.createElement("input");
    input.className = "prompt";
    input.value = s.image_prompt || "";
    input.setAttribute("aria-label", "이미지 프롬프트");
    const gen = document.createElement("button");
    gen.type = "button";
    gen.className = "mini-btn gen";
    gen.textContent = `AI ${CANDIDATE_COUNT}장`;
    const up = document.createElement("button");
    up.type = "button";
    up.className = "mini-btn upload";
    up.textContent = "업로드";
    up.title = "내 이미지/영상을 이 구간 배경으로";
    const setRef = document.createElement("button");
    setRef.type = "button";
    setRef.className = "mini-btn anchor-set";
    setRef.textContent = "참조로";
    setRef.title = "이 구간의 선택 이미지를 일관성 참조로 지정";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*,video/*";
    file.className = "sec-file";
    file.hidden = true;
    rowEl.append(input, gen, up, setRef, file);

    const body = document.createElement("div");
    body.className = "section-body";
    body.append(head, rowEl);

    if (s.candidates && s.candidates.length) {
      const cands = document.createElement("div");
      cands.className = "candidates";
      s.candidates.forEach((c) => {
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "candidate" + (c.image_id === s.image_id ? " selected" : "");
        pick.dataset.imageId = c.image_id;
        pick.dataset.imageUrl = c.image_url;
        pick.dataset.hasFace = c.has_face ? "1" : "";
        if (isVideoUrl(c.image_url)) {
          pick.classList.add("is-video");
          const vb = document.createElement("span");
          vb.className = "video-badge";
          vb.textContent = "🎬";
          pick.appendChild(vb);
        } else {
          pick.style.backgroundImage = `url('${c.image_url}')`;
        }
        pick.setAttribute("aria-label", "이 배경 선택");
        if (c.has_face) {
          const badge = document.createElement("span");
          badge.className = "face-badge";
          badge.textContent = "얼굴";
          pick.appendChild(badge);
        }
        cands.append(pick);
      });
      body.append(cands);
    }

    card.append(thumb, body);
    box.appendChild(card);
  });
  scheduleAutosave();
  updatePreview();
  updateBgNote();
  recordHistorySoon();
}

async function groupSections() {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  const btn = $("genImagesBtn");
  btn.disabled = true;
  busy("구간을 나누는 중입니다.");
  try {
    const res = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenes, style: $("imgStyle").value, aspect: getAspect(),
        gap: Number($("gapThreshold").value) || 1.6,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    sectionsState = (data.sections || []).map((s) => ({
      ...s,
      candidates: [],
      subtitle: s.subtitle !== false,
    }));
    renderSectionCards();
    renderAnchor();
    renderChapters();
    status(`${sectionsState.length}개 구간으로 나눴습니다. 가사로 프롬프트를 자동 작성합니다…`, "ok");
    // 구간 구조는 즉시 보여준다. 프롬프트 자동작성은 블로킹하지 않고 백그라운드로 진행
    // (실패해도 기본 프롬프트 유지). 그래서 '구간 나누기' 버튼이 어댑터 왕복에 묶이지 않는다.
    autoWritePrompts(true);
  } catch (e) {
    status("구간 나누기 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function genCandidates(card, s, genBtn) {
  s._generating = true;
  renderSectionCards(); // 카드에 'AI 생성 중…' 오버레이 표시
  busy(`${s.label} 배경 후보 ${CANDIDATE_COUNT}장 생성 중입니다.`);
  try {
    const res = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: s.image_prompt,
        aspect: getAspect(),
        count: CANDIDATE_COUNT,
        label: s.label,
        ref_image_id: useRef && anchor ? anchor.image_id : "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    s.candidates = data.candidates || [];
    if (s.candidates[0]) {
      const c0 = s.candidates[0];
      s.image_id = c0.image_id;
      s.image_url = c0.image_url;
      s.has_face = !!c0.has_face;
      if (!anchor) setAnchor(s);
    }
    const refNote = useRef && anchor ? " (참조 적용)" : "";
    status(`${s.label} 후보 ${s.candidates.length}장 생성 완료${refNote}. 1장을 클릭해 선택하세요.`, "ok");
  } catch (err) {
    status("이미지 생성 실패: " + err.message, "err");
  } finally {
    s._generating = false;
    renderSectionCards();
    renderAnchor();
  }
}

function setAnchor(s) {
  anchor = { image_id: s.image_id, image_url: s.image_url, has_face: !!s.has_face };
  renderAnchor();
}

function renderAnchor() {
  const bar = $("anchorBar");
  if (!sectionsState.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const thumb = $("anchorThumb");
  if (anchor && anchor.image_url) {
    thumb.style.backgroundImage = `url('${anchor.image_url}')`;
    $("anchorLabel").textContent = anchor.has_face ? "인물 참조 · 얼굴 감지됨" : "컨셉 참조";
    $("anchorHint").textContent = anchor.has_face
      ? "이후 생성에 이 인물을 참조해 일관성을 유지합니다."
      : "이후 생성에 이 컨셉/분위기를 참조해 유지합니다.";
  } else {
    thumb.style.backgroundImage = "";
    $("anchorLabel").textContent = "참조 없음";
    $("anchorHint").textContent = "이미지를 선택하면 자동으로 참조가 됩니다.";
  }
  $("useRefChk").checked = useRef;
}

$("useRefChk").addEventListener("change", (e) => {
  useRef = e.target.checked;
});

$("clearAnchorBtn").addEventListener("click", () => {
  anchor = null;
  renderAnchor();
  status("참조를 해제했습니다.", "ok");
});

$("genImagesBtn").addEventListener("click", groupSections);

let genAllAborted = false;
async function genAllCandidates() {
  if (!sectionsState.length) return status("먼저 구간을 나누세요.", "err");
  const btn = $("genAllBtn");
  genAllAborted = false;
  btn.textContent = "중지";
  btn.dataset.mode = "abort"; // 생성 중엔 같은 버튼이 '중지'로
  $("genImagesBtn").disabled = true;
  $("genAllProgress").classList.remove("hidden");
  setGenAllProgress(0);
  let ok = 0;
  try {
    for (let i = 0; i < sectionsState.length; i++) {
      if (genAllAborted) break;
      const s = sectionsState[i];
      s._generating = true;
      renderSectionCards();
      busy(`전체 배경 생성 중… ${i + 1}/${sectionsState.length} · ${s.label}`);
      try {
        const res = await fetch("/api/candidates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: s.image_prompt,
            aspect: getAspect(),
            count: CANDIDATE_COUNT,
            label: s.label,
            ref_image_id: useRef && anchor ? anchor.image_id : "",
          }),
        });
        const data = await res.json();
        if (res.ok && (data.candidates || []).length) {
          s.candidates = data.candidates;
          const c0 = s.candidates[0];
          s.image_id = c0.image_id;
          s.image_url = c0.image_url;
          s.has_face = !!c0.has_face;
          if (!anchor) setAnchor(s);
          ok++;
        }
      } catch (e) {
        /* 개별 구간 실패는 건너뜀(아래 집계에 반영) */
      }
      s._generating = false;
      setGenAllProgress((i + 1) / sectionsState.length);
      renderSectionCards(); // 각 구간 완료 즉시 표시
      renderAnchor();
    }
    const total = sectionsState.length;
    if (genAllAborted) {
      status(`전체 생성을 중지했습니다. (${ok}/${total} 구간 완료)`, "ok");
    } else if (ok === 0) {
      status("배경을 한 장도 생성하지 못했습니다. 프롬프트·네트워크를 확인하고 다시 시도하세요.", "err");
    } else if (ok < total) {
      status(`${ok}/${total} 구간만 생성됐습니다. 실패한 구간은 ‘AI ${CANDIDATE_COUNT}장’으로 다시 시도하세요.`, "err");
    } else {
      status("전체 구간 배경 생성 완료. 마음에 안 드는 구간만 다시 고르세요.", "ok");
    }
  } catch (e) {
    status("전체 배경 생성 중 오류: " + e.message, "err");
  } finally {
    btn.textContent = "전체 생성";
    btn.dataset.mode = "";
    $("genImagesBtn").disabled = false;
    $("genAllProgress").classList.add("hidden");
  }
}
function setGenAllProgress(frac) {
  const pct = Math.round((frac || 0) * 100);
  $("genAllBar").style.width = pct + "%";
  $("genAllPct").textContent = pct + "%";
}
$("genAllBtn").addEventListener("click", () => {
  if ($("genAllBtn").dataset.mode === "abort") {
    genAllAborted = true;
    busy("중지하는 중… 현재 구간까지 마치고 멈춥니다.");
    return;
  }
  genAllCandidates();
});

// 가사 → AI 이미지 프롬프트 자동작성 (마브 어댑터). 가사는 그대로, 배경 설명만 생성.
async function autoWritePrompts(silent) {
  if (!sectionsState.length) {
    if (!silent) status("먼저 구간을 나누세요.", "err");
    return;
  }
  const btn = $("autoPromptBtn");
  if (btn) btn.disabled = true;
  // 응답이 도착할 때까지(최대 수십 초) 사용자가 재그룹화하거나 프롬프트를 직접 고칠 수 있다.
  // 대상 배열을 고정하고, 각 구간의 현재 프롬프트를 스냅샷해 두었다가 적용 시점에 검증한다.
  const target = sectionsState;
  const snapshot = target.map((s) => s.image_prompt || "");
  busy("가사로 배경 이미지 프롬프트를 자동 작성 중입니다…");
  try {
    const res = await fetch("/api/auto-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sections: target.map((s) => ({ label: s.label, lines: s.lines || [] })),
        style: $("imgStyle").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    if (sectionsState !== target) return; // 그 사이 다시 구간을 나눔 → 낡은 응답 폐기
    let n = 0;
    let kept = 0;
    (data.prompts || []).forEach((p, i) => {
      if (!target[i] || !p.positive) return;
      if ((target[i].image_prompt || "") !== snapshot[i]) {
        kept++; // 대기 중 사용자가 직접 수정함 → 덮어쓰지 않고 보존
        return;
      }
      target[i].image_prompt = p.positive;
      n++;
    });
    renderSectionCards();
    const extra = kept ? ` (직접 수정한 ${kept}개는 유지)` : "";
    status(`${n}개 구간 프롬프트를 자동 작성했습니다${extra}. 수정 후 ‘AI ${CANDIDATE_COUNT}장’으로 생성하세요.`, "ok");
  } catch (e) {
    // 실패해도 기본(한국어) 프롬프트가 그대로라 진행 가능. 자동 경로에선 스피너만 정리.
    if (!silent) status("프롬프트 자동작성 실패: " + e.message, "err");
    else status("프롬프트 자동작성을 건너뜀 — 기본 프롬프트로 진행합니다.", "ok");
  } finally {
    if (btn) btn.disabled = false;
  }
}
$("autoPromptBtn").addEventListener("click", () => autoWritePrompts(false));

// 구간 경계를 음원 박자에 스냅 (librosa 비트 검출). 0.5초 이내 비트로만 당겨 가사와 어긋남 방지.
async function beatSnap() {
  if (sectionsState.length < 2) return status("구간이 2개 이상일 때 사용할 수 있습니다.", "err");
  if (!audioId) return status("먼저 자동 정렬을 완료하세요.", "err");
  const btn = $("beatSnapBtn");
  btn.disabled = true;
  busy("음원 박자를 분석해 구간 경계를 맞추는 중…");
  try {
    const res = await fetch("/api/beats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_id: audioId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    const beats = data.beats || [];
    if (!beats.length) throw new Error("비트를 찾지 못했습니다.");
    let moved = 0;
    for (let i = 1; i < sectionsState.length; i++) {
      const s = sectionsState[i];
      const nearest = beats.reduce((a, b) =>
        Math.abs(b - s.start) < Math.abs(a - s.start) ? b : a, beats[0]);
      const delta = Math.abs(nearest - s.start);
      if (delta > 0.02 && delta <= 0.5) { // 0.5초 이내만 스냅(큰 이동 금지)
        s.start = round2(nearest);
        sectionsState[i - 1].end = s.start; // 이전 구간 끝도 경계에 맞춤
        moved++;
      }
    }
    renderSectionCards();
    updatePreview();
    status(moved
      ? `비트에 맞춰 ${moved}개 구간 경계를 조정했습니다.`
      : "이미 모든 경계가 박자에 가깝습니다.", "ok");
  } catch (e) {
    status("비트 맞추기 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}
$("beatSnapBtn").addEventListener("click", beatSnap);

$("sections").addEventListener("change", (e) => {
  const card = e.target.closest(".section-card");
  if (!card) return;
  const s = sectionsState[Number(card.dataset.i)];
  if (!s) return;
  if (e.target.classList.contains("prompt")) s.image_prompt = e.target.value;
  else if (e.target.classList.contains("subtitle-toggle")) {
    s.subtitle = e.target.checked;
    updatePreview();
  } else if (e.target.classList.contains("sec-file")) {
    uploadSectionImage(s, e.target.files[0]);
  }
});

$("sections").addEventListener("click", (e) => {
  const card = e.target.closest(".section-card");
  if (!card) return;
  const s = sectionsState[Number(card.dataset.i)];
  if (!s) return;

  const pick = e.target.closest(".candidate");
  if (pick) {
    s.image_id = pick.dataset.imageId;
    s.image_url = pick.dataset.imageUrl;
    s.has_face = pick.dataset.hasFace === "1";
    if (!anchor) setAnchor(s); // 첫 선택을 자동 참조로 지정
    renderSectionCards();
    return;
  }

  const upBtn = e.target.closest(".upload");
  if (upBtn) {
    card.querySelector(".sec-file").click();
    return;
  }

  const setRefBtn = e.target.closest(".anchor-set");
  if (setRefBtn) {
    if (!s.image_id) return status("먼저 이 구간 이미지를 선택하세요.", "err");
    setAnchor(s);
    status(anchor.has_face ? "인물 참조로 지정했습니다." : "컨셉 참조로 지정했습니다.", "ok");
    return;
  }

  const genBtn = e.target.closest(".gen");
  if (genBtn) genCandidates(card, s, genBtn);
});

// ---- 프로젝트 저장 / 불러오기 (작업 내용 기억) ----
function collectState() {
  return {
    audio_id: audioId,
    audio_url: audioId ? `/data/${audioId}` : "",
    language: $("language").value,
    lyrics: $("lyrics").value,
    scenes,
    sections: sectionsState,
    style: $("imgStyle").value,
    gap: Number($("gapThreshold").value) || 1.6,
    aspect: getAspect(),
    font_size: Number($("fontSize").value) || 48,
    subtitle_style: $("subtitleStyle").value,
    subtitle_pos: $("subtitlePos").value,
    font: $("fontSelect").value,
    text_color: $("textColor").value,
    hi_color: $("hiColor").value,
    outline_color: $("outlineColor").value,
    transition: $("transition").value,
    transition_dur: Number($("transitionDur").value) || 0.8,
    ken_burns: Number($("kenBurns").value) || 0,
    intro_outro: $("introOutro").checked,
    intro_fade: Number($("introFade").value) || 0,
    outro_fade: Number($("outroFade").value) || 0,
    intro_title: $("introTitle").checked,
    intro_title_dur: Number($("introTitleDur").value) || 3,
    also_shorts: $("alsoShorts").checked,
    song_title: $("songTitle").value,
    bg_color: $("bgColor").value,
    bg_id: bgId,
    bg_name: bgName,
    anchor,
    use_ref: useRef,
  };
}

function applyState(st) {
  audioId = st.audio_id || null;
  scenes = normalizeScenes(st.scenes || []);
  sectionsState = st.sections || [];
  bgId = st.bg_id || null;
  bgName = st.bg_name || (bgId ? "업로드된 배경" : "");
  anchor = st.anchor || null;
  useRef = st.use_ref !== false;
  $("lyrics").value = st.lyrics || "";
  $("language").value = st.language || "ko";
  $("imgStyle").value = st.style || "";
  if (st.gap) $("gapThreshold").value = st.gap;
  $("fontSize").value = st.font_size || 48;
  $("subtitleStyle").value = st.subtitle_style || "ballad";
  $("subtitlePos").value = st.subtitle_pos || "bottom";
  $("fontSelect").value = st.font || "Malgun Gothic";
  if (st.hi_color) { // 저장된 커스텀 색이 있으면 복원, 없으면 프리셋 색
    $("textColor").value = st.text_color || "#FFFFFF";
    $("hiColor").value = st.hi_color;
    $("outlineColor").value = st.outline_color || "#101010";
  } else {
    presetColorsToPickers();
  }
  $("transition").value = st.transition || "crossfade";
  $("transitionDur").value = st.transition_dur || 0.8;
  $("kenBurns").value = st.ken_burns || 0;
  $("introOutro").checked = st.intro_outro !== false;
  if (st.intro_fade != null) $("introFade").value = st.intro_fade;
  if (st.outro_fade != null) $("outroFade").value = st.outro_fade;
  $("introTitle").checked = !!st.intro_title;
  if (st.intro_title_dur) $("introTitleDur").value = st.intro_title_dur;
  $("alsoShorts").checked = !!st.also_shorts;
  $("songTitle").value = st.song_title || "";
  $("bgColor").value = st.bg_color || "#101114";
  $("fontSizeVal").textContent = $("fontSize").value;
  updateFxLabels();
  updateStylePreview();
  const asp = document.querySelector(`input[name="aspect"][value="${st.aspect || "16:9"}"]`);
  if (asp) asp.checked = true;
  if (st.audio_url) audio.src = st.audio_url;
  stopAt = null;
  renderRows();
  renderSectionCards();
  renderAnchor();
  renderChapters();
  updateStylePreview();
  updateLyricStats();
  goStep(scenes.length ? 2 : 1);
  updateActionState();
  resetHistory(); // 불러온 상태를 되돌리기 시작점으로
}

async function refreshProjects(selectSlug, notify) {
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const sel = $("projectSelect");
    sel.innerHTML = '<option value="">저장된 프로젝트…</option>';
    (data.projects || []).forEach((p) => {
      const o = document.createElement("option");
      o.value = p.slug;
      o.textContent = `${p.name} · ${(p.saved_at || "").replace("T", " ")}`;
      sel.appendChild(o);
    });
    if (selectSlug) sel.value = selectSlug;
  } catch (e) {
    // 시작 시 자동 호출은 조용히, 저장 직후 등 명시 호출(notify)은 사용자에게 알린다.
    if (notify) status("프로젝트 목록을 불러오지 못했습니다: " + e.message, "err");
  }
}

async function saveProject() {
  const name = prompt("프로젝트 이름", "내 뮤직비디오");
  if (!name) return;
  busy("저장 중입니다.");
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, state: collectState() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    await refreshProjects(data.slug, true);
    status(`저장 완료: ${name}`, "ok");
  } catch (e) {
    status("저장 실패: " + e.message, "err");
  }
}

async function loadProject() {
  const slug = $("projectSelect").value;
  if (!slug) return status("불러올 프로젝트를 선택하세요.", "err");
  busy("불러오는 중입니다.");
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(slug));
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    applyState(data.state || {});
    status(`불러옴: ${data.name}`, "ok");
  } catch (e) {
    status("불러오기 실패: " + e.message, "err");
  }
}

async function deleteProject() {
  const sel = $("projectSelect");
  const slug = sel.value;
  if (!slug) return status("삭제할 프로젝트를 선택하세요.", "err");
  const name = (sel.selectedOptions[0] && sel.selectedOptions[0].textContent) || slug;
  if (!confirm(`'${name}' 프로젝트를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(slug), { method: "DELETE" });
    if (!res.ok) throw new Error(res.statusText);
    await refreshProjects(null, true);
    status("프로젝트를 삭제했습니다.", "ok");
  } catch (e) {
    status("삭제 실패: " + e.message, "err");
  }
}

$("saveProjectBtn").addEventListener("click", saveProject);
$("loadProjectBtn").addEventListener("click", loadProject);
$("deleteProjectBtn").addEventListener("click", deleteProject);

// ---- YouTube 설명란 챕터 (구간 타임스탬프 재활용) ----
function fmtClock(t) {
  t = Math.max(0, Math.round(+t || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function buildChapters() {
  if (!sectionsState.length) return "";
  return sectionsState
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${fmtClock(i === 0 ? 0 : s.start)} ${s.label || "구간 " + (i + 1)}`)
    .join("\n");
}

function renderChapters() {
  const box = $("ytExport");
  if (!box) return;
  const ga = $("genAllBtn");
  if (ga) ga.classList.toggle("hidden", !sectionsState.length);
  const ap = $("autoPromptBtn");
  if (ap) ap.classList.toggle("hidden", !sectionsState.length);
  const bs = $("beatSnapBtn");
  if (bs) bs.classList.toggle("hidden", sectionsState.length < 2);
  if (sectionsState.length) {
    box.classList.remove("hidden");
    $("chaptersBox").value = buildChapters();
  } else {
    box.classList.add("hidden");
    $("chaptersBox").value = "";
  }
}

function flashCopied(btn) {
  if (!btn || btn._copyTimer) return;
  const orig = btn.textContent;
  btn.textContent = "복사됨 ✓";
  btn._copyTimer = setTimeout(() => {
    btn.textContent = orig;
    btn._copyTimer = null;
  }, 1400);
}

$("copyChaptersBtn").addEventListener("click", async (e) => {
  const txt = $("chaptersBox").value;
  if (!txt) return status("먼저 구간을 나누세요.", "err");
  try {
    await navigator.clipboard.writeText(txt);
  } catch (err) {
    $("chaptersBox").select();
    document.execCommand("copy");
  }
  flashCopied(e.currentTarget);
  status("챕터를 복사했습니다. 유튜브 설명란에 붙여넣으세요.", "ok");
});

// ---- 자동 썸네일 ----
$("thumbBtn").addEventListener("click", async () => {
  const title = $("songTitle").value.trim();
  if (!title) return status("영상 제목을 입력하세요.", "err");
  // 썸네일 배경은 이미지 구간에서만(영상 파일은 Image.open 불가)
  const bg = (sectionsState.find((s) => s.image_id && !isVideoUrl(s.image_url)) || {}).image_id || "";
  busy("썸네일 생성 중…");
  try {
    const res = await fetch("/api/thumbnail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, subtitle: "AI Lyric Video", image_id: bg }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    $("thumbPreview").src = data.image_url + "?t=" + Date.now();
    $("thumbDownload").href = data.image_url;
    $("thumbResult").classList.remove("hidden");
    status("썸네일 생성 완료.", "ok");
  } catch (e) {
    status("썸네일 실패: " + e.message, "err");
  }
});

// ---- 업로드 메타데이터 ----
function buildMetadata() {
  const title = $("songTitle").value.trim() || "제목 없는 노래";
  const chapters = buildChapters();
  const hook = (lyricLines()[0] || "").slice(0, 40);
  const hashtags = "#가사 #lyrics #AI음악 #뮤직비디오";
  const desc =
    (hook ? `"${hook}…"\n\n` : "") +
    (chapters ? `🎬 챕터\n${chapters}\n\n` : "") +
    "🎵 이 곡의 음악·가사는 AI로 제작되었습니다.\n" +
    "※ 사용한 AI 음악 플랫폼의 라이선스(상업/수익화)를 확인하세요.\n\n" +
    hashtags;
  const tags = [title, "가사", "lyric video", "AI music", "뮤직비디오", "lyrics"].join(", ");
  return `[제목]\n${title} (가사 영상)\n\n[설명]\n${desc}\n\n[태그]\n${tags}`;
}
$("metaBtn").addEventListener("click", () => {
  $("metaBox").value = buildMetadata();
  $("metaWrap").classList.remove("hidden");
  status("메타데이터 생성 완료. 복사해 업로드 시 붙여넣으세요.", "ok");
});
$("copyMetaBtn").addEventListener("click", async (e) => {
  const t = $("metaBox").value;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch (err) {
    $("metaBox").select();
    document.execCommand("copy");
  }
  flashCopied(e.currentTarget);
  status("메타데이터를 복사했습니다.", "ok");
});

// ---- 자막 스타일 미리보기 ----
const PRESET_PREVIEW = {
  ballad: { base: "#FFFFFF", hi: "#FFE08A", outline: "#101010" },
  kpop: { base: "#FFFFFF", hi: "#FF5FA2", outline: "#101010" },
  citypop: { base: "#FFF4E0", hi: "#7DE0FF", outline: "#201430" },
  simple: { base: "#FFFFFF", hi: "#FFFFFF", outline: "#000000" },
};
// 미리보기·최종 자막이 같은 색을 쓰도록, 색은 피커(커스텀) 한 곳에서만 읽는다.
function currentStyleColors() {
  return { base: $("textColor").value, hi: $("hiColor").value, outline: $("outlineColor").value };
}
function presetColorsToPickers() {
  const p = PRESET_PREVIEW[$("subtitleStyle").value] || PRESET_PREVIEW.ballad;
  $("textColor").value = p.base;
  $("hiColor").value = p.hi;
  $("outlineColor").value = p.outline;
}
function updateStylePreview() {
  const el = $("stylePreview");
  if (!el) return;
  const c = currentStyleColors();
  el.style.fontFamily = $("fontSelect").value;  // 폰트 미리보기에도 반영
  const o = c.outline;
  const sh = `-2px 0 ${o},2px 0 ${o},0 -2px ${o},0 2px ${o},-2px -2px ${o},2px 2px ${o},-2px 2px ${o},2px -2px ${o}`;
  el.innerHTML =
    `<span style="color:${c.hi};text-shadow:${sh}">부르는 단어</span> ` +
    `<span style="color:${c.base};text-shadow:${sh}">가사 미리보기</span>`;
}
// 프리셋을 바꾸면 색 피커를 그 프리셋 색으로 채운다(거기서 취향대로 미세조정).
$("subtitleStyle").addEventListener("change", () => {
  presetColorsToPickers();
  updateStylePreview();
  updatePreview();
});
["textColor", "hiColor", "outlineColor"].forEach((id) =>
  $(id).addEventListener("input", () => { updateStylePreview(); updatePreview(); })
);
$("resetColors").addEventListener("click", () => {
  presetColorsToPickers();
  updateStylePreview();
  updatePreview();
});

// ---- 자동저장 (브라우저 localStorage · 디바운스 1.5s) ----
const AUTOSAVE_KEY = "subsong_autosave";
let autosaveTimer = null;
function scheduleAutosave() {
  const ind = $("saveState");
  if (ind) ind.classList.add("saving");
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      const st = collectState();
      if ((st.scenes || []).length || (st.lyrics || "").trim()) {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ at: Date.now(), state: st }));
      }
    } catch (e) {
      /* 용량 초과 등 무시 */
    }
    if (ind) ind.classList.remove("saving");
  }, 1500);
}
document.addEventListener("input", scheduleAutosave, true);
document.addEventListener("change", scheduleAutosave, true);

// ---- 되돌리기 / 다시하기 (가사 타이밍·구간 편집 스냅샷) ----
let undoStack = [];
let redoStack = [];
let lastHistory = null;
let restoring = false;
let historyTimer = null;
function histSnapshot() {
  return JSON.stringify({ scenes, sections: sectionsState });
}
function updateUndoButtons() {
  if ($("undoBtn")) $("undoBtn").disabled = !undoStack.length;
  if ($("redoBtn")) $("redoBtn").disabled = !redoStack.length;
}
function recordHistory() {
  if (restoring) return;
  const cur = histSnapshot();
  if (cur === lastHistory) return;
  if (lastHistory !== null) {
    undoStack.push(lastHistory);
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
  }
  lastHistory = cur;
  updateUndoButtons();
}
function recordHistorySoon() {
  if (restoring) return;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(recordHistory, 350);
}
function resetHistory() {
  undoStack = [];
  redoStack = [];
  lastHistory = histSnapshot();
  updateUndoButtons();
}
function restoreHistory(str) {
  restoring = true;
  try {
    const o = JSON.parse(str);
    scenes = normalizeScenes(o.scenes || []);
    sectionsState = o.sections || [];
    renderRows();
    renderSectionCards();
    renderAnchor();
    renderChapters();
    updatePreview();
    updateActionState();
  } finally {
    restoring = false;
  }
}
function undo() {
  if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; recordHistory(); }
  if (!undoStack.length) return status("되돌릴 작업이 없습니다.", "ok");
  redoStack.push(lastHistory);
  lastHistory = undoStack.pop();
  restoreHistory(lastHistory);
  updateUndoButtons();
  status("되돌렸습니다.", "ok");
}
function redo() {
  if (!redoStack.length) return status("다시 실행할 작업이 없습니다.", "ok");
  undoStack.push(lastHistory);
  lastHistory = redoStack.pop();
  restoreHistory(lastHistory);
  updateUndoButtons();
  status("다시 실행했습니다.", "ok");
}
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);
document.addEventListener("change", recordHistorySoon, true);
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = (e.key || "").toLowerCase();
  const isZ = k === "z" || k === "ㅈ";
  const isY = k === "y" || k === "ㅛ";
  if (isZ && !e.shiftKey) {
    if (document.activeElement && document.activeElement.id === "lyrics") return; // 가사 입력칸은 네이티브 undo
    e.preventDefault();
    undo();
  } else if ((isZ && e.shiftKey) || isY) {
    e.preventDefault();
    redo();
  }
});

function offerRestore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
  } catch (e) {
    saved = null;
  }
  if (!saved || !saved.state || !(saved.state.scenes || []).length) return;
  const bar = $("restoreBar");
  $("restoreInfo").textContent = `이전 작업(${new Date(saved.at).toLocaleString()})이 있습니다. 복구할까요?`;
  bar.classList.remove("hidden");
  $("restoreBtn").onclick = () => {
    applyState(saved.state);
    bar.classList.add("hidden");
    status("이전 작업을 복구했습니다.", "ok");
  };
  $("restoreDismiss").onclick = () => bar.classList.add("hidden");
}

// ---- 실시간 미리보기 (배경 + 노래방 자막) ----
function setPreviewAspect() {
  const a = getAspect();
  $("preview").style.aspectRatio = a === "9:16" ? "9 / 16" : a === "1:1" ? "1 / 1" : "16 / 9";
}
function applyPreviewStyle() {
  const ov = $("previewSub");
  const fs = Number($("fontSize").value) || 48;
  const pw = $("preview").clientWidth || 640;
  ov.style.fontSize = Math.max(11, (fs * pw) / 1920) + "px";
  ov.style.fontFamily = $("fontSelect").value;  // 폰트 선택을 미리보기에도 반영
  const o = currentStyleColors().outline;
  ov.style.textShadow = `-2px 0 ${o},2px 0 ${o},0 -2px ${o},0 2px ${o},-2px -2px ${o},2px 2px ${o},-2px 2px ${o},2px -2px ${o}`;
  const pos = $("subtitlePos").value;
  if (pos === "middle") {
    ov.style.top = "50%"; ov.style.bottom = "auto"; ov.style.transform = "translateY(-50%)";
  } else if (pos === "top") {
    ov.style.top = "7%"; ov.style.bottom = "auto"; ov.style.transform = "none";
  } else {
    ov.style.top = "auto"; ov.style.bottom = "7%"; ov.style.transform = "none";
  }
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function karaokeHTML(sc, t) {
  const c = currentStyleColors();
  const words = sc.words && sc.words.length ? sc.words : null;
  if (!words || $("subtitleStyle").value === "simple") {
    return `<span style="color:${c.base}">${escapeHtml(sc.text)}</span>`;
  }
  // 최종 ASS \kf와 동일하게: 부르는 단어를 '왼→오'로 점점 채운다(단어 길이=다음 단어 시작까지).
  return words
    .map((w, i) => {
      const ws = Number(w.start);
      const we = i + 1 < words.length
        ? Number(words[i + 1].start)
        : (w.end != null ? Number(w.end) : Number(sc.end));
      const word = escapeHtml(w.w);
      if (t >= we) return `<span style="color:${c.hi}">${word}</span>`;
      if (t < ws) return `<span style="color:${c.base}">${word}</span>`;
      const f = Math.max(0, Math.min(1, (t - ws) / Math.max(0.05, we - ws))) * 100;
      return `<span style="background:linear-gradient(90deg,${c.hi} ${f}%,${c.base} ${f}%);` +
        `-webkit-background-clip:text;background-clip:text;color:transparent">${word}</span>`;
    })
    .join(" ");
}
let _lastPreviewSec = null;
function applyPreviewFx(bg, sec) {
  // Ken Burns 줌(슬라이더 값만큼) — 자막과 분리된 배경 레이어에만 적용
  const kb = Number($("kenBurns").value) || 0;
  if (kb > 0 && bg.style.backgroundImage) {
    const dur = sec ? Math.max(3, Math.min(14, sec.end - sec.start)) : 8;
    bg.style.setProperty("--kb-scale", (1 + kb).toFixed(3));
    bg.style.setProperty("--kb-dur", dur + "s");
    bg.classList.add("kb-on");
  } else {
    bg.classList.remove("kb-on");
    bg.style.transform = "";
  }
  // 구간 전환 크로스페이드 근사 — 구간이 바뀔 때 배경을 페이드 인
  const key = sec ? sec.label + "@" + sec.start : null;
  if (key !== _lastPreviewSec) {
    _lastPreviewSec = key;
    if ($("transition").value !== "none") {
      bg.style.opacity = "0";
      void bg.offsetWidth; // 리플로우 → opacity 트랜지션 발동
    }
    bg.style.opacity = "1";
  }
}

function applyPreviewTitle(t) {
  const el = $("previewTitle");
  if (!el) return false;
  const title = $("songTitle").value.trim();
  const dur = Number($("introTitleDur").value) || 3;
  // 인트로 타이틀: 켜져 있고 제목이 있고 타이틀 길이 안일 때 표시(최종 ASS와 동일 구간)
  const on = $("introTitle").checked && title && t < dur;
  if (on) {
    el.textContent = title;
    el.style.fontFamily = $("fontSelect").value;
    const pw = $("preview").clientWidth || 640;
    el.style.fontSize = Math.max(14, ((Number($("fontSize").value) || 48) * 1.7 * pw) / 1920) + "px";
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
  return on;
}

function syncPreviewVideo(vid, sec) {
  // 영상 미리보기를 오디오 재생 위치/상태에 맞춘다(구간 시작 기준, 길이 반복).
  if (vid.readyState >= 1 && vid.duration && isFinite(vid.duration)) {
    const into = (audio.currentTime || 0) - sec.start;
    const target = ((into % vid.duration) + vid.duration) % vid.duration;
    if (Math.abs((vid.currentTime || 0) - target) > 0.4) {
      try { vid.currentTime = target; } catch (e) { /* seek 무시 */ }
    }
  }
  if (!audio.paused) {
    if (vid.paused) vid.play().catch(() => {});
  } else if (!vid.paused) {
    vid.pause();
  }
}

function updatePreview() {
  const prev = $("preview");
  if (!prev || currentStep < 2) return;
  const bg = $("previewBg");
  const vid = $("previewVideo");
  const t = audio.currentTime || 0;
  let sec = sectionsState.find((s) => t >= s.start && t < s.end);
  if (!sec && sectionsState.length) {
    sec = t < sectionsState[0].start ? sectionsState[0] : sectionsState[sectionsState.length - 1];
  }
  const isVid = !!(sec && sec.image_url && isVideoUrl(sec.image_url));
  if (isVid && vid) {
    if (vid.dataset.src !== sec.image_url) {
      vid.dataset.src = sec.image_url;
      vid.src = sec.image_url;
    }
    vid.classList.add("show");
    if (bg) { bg.style.backgroundImage = ""; bg.classList.remove("kb-on"); bg.style.opacity = "1"; }
    syncPreviewVideo(vid, sec);
  } else {
    if (vid) { vid.classList.remove("show"); if (!vid.paused) vid.pause(); }
    if (bg) {
      if (sec && sec.image_url) {
        bg.style.backgroundImage = `url('${sec.image_url}')`;
        bg.style.backgroundColor = "";
      } else {
        bg.style.backgroundImage = "";
        bg.style.backgroundColor = $("bgColor").value || "#10131c";
      }
      applyPreviewFx(bg, sec);
    }
  }
  const sc = scenes.find((s) => t >= s.start && t < s.end);
  let off = false;
  if (sc) off = sectionsState.some((s) => s.subtitle === false && (s.scene_ids || []).includes(sc.id));
  const titleShown = applyPreviewTitle(t); // 타이틀 표시 중엔 자막 숨김(겹침 방지)
  $("previewSub").innerHTML = sc && !off && !titleShown ? karaokeHTML(sc, t) : "";
  applyPreviewStyle();
  const meta = $("previewMeta");
  if (meta) {
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60);
    meta.textContent = `미리보기 · ${mm}:${String(ss).padStart(2, "0")}` + (sec ? ` · ${sec.label}` : "");
  }
}

// ---- 구간 이미지 직접 업로드 ----
async function uploadSectionImage(s, file) {
  if (!file) return;
  busy(`${s.label} 이미지 업로드 중…`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload-bg", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    s.image_id = data.bg_id;
    s.image_url = data.bg_url || "/data/" + data.bg_id;
    s.candidates = [{ image_id: s.image_id, image_url: s.image_url, has_face: false }];
    if (!anchor) setAnchor(s);
    renderSectionCards();
    renderAnchor();
    updatePreview();
    status(`${s.label} 배경을 올린 이미지로 바꿨습니다.`, "ok");
  } catch (e) {
    status("업로드 실패: " + e.message, "err");
  }
}

// ---- 단계 네비게이션 ----
$("stepTabs").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-step]");
  if (li) goStep(Number(li.dataset.step));
});
$("stepTabs").addEventListener("keydown", (e) => {
  const li = e.target.closest("li[data-step]");
  if (!li) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    goStep(Number(li.dataset.step));
  } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const next = Number(li.dataset.step) + (e.key === "ArrowRight" ? 1 : -1);
    const target = document.querySelector(`.steps li[data-step="${Math.max(1, Math.min(4, next))}"]`);
    if (target) target.focus();
  }
});
$("prevStep").addEventListener("click", () => goStep(currentStep - 1));
$("nextStep").addEventListener("click", () => {
  if (currentStep === 1 && !scenes.length) {
    return status("먼저 ‘자동 정렬 시작’으로 가사를 맞춰주세요.", "err");
  }
  goStep(currentStep + 1);
});

// 미리보기 즉시 반영 — 폰트·전환·줌·인트로 타이틀·제목까지 포함(input/change 둘 다 안전망)
["fontSize", "bgColor", "subtitleStyle", "subtitlePos", "fontSelect",
 "transition", "transitionDur", "kenBurns", "songTitle", "introTitle",
 "introTitleDur", "introFade", "outroFade"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", updatePreview);
  el.addEventListener("change", updatePreview);
});
// 폰트는 자막 스타일 미리보기(스와치)에도 반영
$("fontSelect").addEventListener("change", updateStylePreview);
$("fontSize").addEventListener("input", () => {
  $("fontSizeVal").textContent = $("fontSize").value;
  $("fontSize").setAttribute("aria-valuetext", $("fontSize").value + "px");
});

// 썸네일은 제목이 있어야 — 없으면 버튼 비활성 + 안내
function updateThumbBtnState() {
  const has = !!$("songTitle").value.trim();
  $("thumbBtn").disabled = !has;
  $("thumbBtn").title = has ? "" : "먼저 ‘영상 제목’을 입력하세요";
}
$("songTitle").addEventListener("input", updateThumbBtnState);
updateThumbBtnState();

// 배경 연출 슬라이더 값 표시
function updateFxLabels() {
  const td = Number($("transitionDur").value).toFixed(1) + "s";
  $("transitionDurVal").textContent = td;
  $("transitionDur").setAttribute("aria-valuetext", td);
  const kb = Number($("kenBurns").value);
  const kbt = kb > 0 ? "+" + Math.round(kb * 100) + "%" : "없음";
  $("kenBurnsVal").textContent = kbt;
  $("kenBurns").setAttribute("aria-valuetext", kbt);
}
$("transitionDur").addEventListener("input", updateFxLabels);
$("kenBurns").addEventListener("input", updateFxLabels);
updateFxLabels();

document.querySelectorAll('input[name="aspect"]').forEach((r) =>
  r.addEventListener("change", () => {
    setPreviewAspect();
    updatePreview();
  })
);
window.addEventListener("resize", applyPreviewStyle);

updateLyricStats();
updateActionState();
renderSectionCards();
renderAnchor();
renderChapters();
updateStylePreview();
refreshProjects();
offerRestore();
goStep(1);
