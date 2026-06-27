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
    goStep(2);
    status(`정렬 완료: ${scenes.length}줄. 미리보기로 확인하며 고치세요.`, "ok");
  } catch (e) {
    status("정렬 실패: " + e.message, "err");
  } finally {
    isAligning = false;
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
    audio.currentTime = scene.start;
    stopAt = scene.end;
    audio.play();
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
    $("bgName").textContent = file.name;
    status("배경 업로드 완료", "ok");
  } catch (err) {
    status("배경 업로드 실패: " + err.message, "err");
  }
});

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
    /* 연결 끊김은 무시(작업은 서버에서 계속 진행) */
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

window.addEventListener("beforeunload", () => {
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
});

// ---- 2차: 구간별 배경 이미지 (후보 N장 생성 → 1장 선택) ----
const CANDIDATE_COUNT = 4;

function renderSectionCards() {
  const box = $("sections");
  box.innerHTML = "";
  sectionsState.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "section-card";
    card.dataset.i = i;

    const thumb = document.createElement("div");
    thumb.className = "section-thumb";
    if (s.image_url) thumb.style.backgroundImage = `url('${s.image_url}?t=${Date.now()}')`;

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
    up.title = "내 이미지를 이 구간 배경으로";
    const setRef = document.createElement("button");
    setRef.type = "button";
    setRef.className = "mini-btn anchor-set";
    setRef.textContent = "참조로";
    setRef.title = "이 구간의 선택 이미지를 일관성 참조로 지정";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
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
        pick.style.backgroundImage = `url('${c.image_url}')`;
        pick.setAttribute("aria-label", "이 이미지 선택");
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
      body: JSON.stringify({ scenes, style: $("imgStyle").value, aspect: getAspect() }),
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
  genBtn.disabled = true;
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
    renderSectionCards();
    const refNote = useRef && anchor ? " (참조 적용)" : "";
    status(`${s.label} 후보 ${s.candidates.length}장 생성 완료${refNote}. 1장을 클릭해 선택하세요.`, "ok");
  } catch (err) {
    status("이미지 생성 실패: " + err.message, "err");
  } finally {
    genBtn.disabled = false;
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

async function genAllCandidates() {
  if (!sectionsState.length) return status("먼저 구간을 나누세요.", "err");
  const btn = $("genAllBtn");
  btn.disabled = true;
  $("genImagesBtn").disabled = true;
  try {
    for (let i = 0; i < sectionsState.length; i++) {
      const s = sectionsState[i];
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
        }
      } catch (e) {
        /* 개별 구간 실패는 건너뜀 */
      }
      renderSectionCards(); // 각 구간 완료 즉시 표시
      renderAnchor();
    }
    status("전체 구간 배경 생성 완료. 마음에 안 드는 구간만 다시 고르세요.", "ok");
  } finally {
    btn.disabled = false;
    $("genImagesBtn").disabled = false;
  }
}
$("genAllBtn").addEventListener("click", genAllCandidates);

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
    aspect: getAspect(),
    font_size: Number($("fontSize").value) || 48,
    subtitle_style: $("subtitleStyle").value,
    subtitle_pos: $("subtitlePos").value,
    song_title: $("songTitle").value,
    bg_color: $("bgColor").value,
    bg_id: bgId,
    anchor,
    use_ref: useRef,
  };
}

function applyState(st) {
  audioId = st.audio_id || null;
  scenes = normalizeScenes(st.scenes || []);
  sectionsState = st.sections || [];
  bgId = st.bg_id || null;
  anchor = st.anchor || null;
  useRef = st.use_ref !== false;
  $("lyrics").value = st.lyrics || "";
  $("language").value = st.language || "ko";
  $("imgStyle").value = st.style || "";
  $("fontSize").value = st.font_size || 48;
  $("subtitleStyle").value = st.subtitle_style || "ballad";
  $("subtitlePos").value = st.subtitle_pos || "bottom";
  $("songTitle").value = st.song_title || "";
  $("bgColor").value = st.bg_color || "#101114";
  $("fontSizeVal").textContent = $("fontSize").value;
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
}

async function refreshProjects(selectSlug) {
  try {
    const res = await fetch("/api/projects");
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
    /* 목록 실패는 조용히 무시 */
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
    await refreshProjects(data.slug);
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

$("saveProjectBtn").addEventListener("click", saveProject);
$("loadProjectBtn").addEventListener("click", loadProject);

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
  if (sectionsState.length) {
    box.classList.remove("hidden");
    $("chaptersBox").value = buildChapters();
  } else {
    box.classList.add("hidden");
    $("chaptersBox").value = "";
  }
}

$("copyChaptersBtn").addEventListener("click", async () => {
  const txt = $("chaptersBox").value;
  if (!txt) return status("먼저 구간을 나누세요.", "err");
  try {
    await navigator.clipboard.writeText(txt);
  } catch (e) {
    $("chaptersBox").select();
    document.execCommand("copy");
  }
  status("챕터를 복사했습니다. 유튜브 설명란에 붙여넣으세요.", "ok");
});

// ---- 자동 썸네일 ----
$("thumbBtn").addEventListener("click", async () => {
  const title = $("songTitle").value.trim();
  if (!title) return status("영상 제목을 입력하세요.", "err");
  const bg = (sectionsState.find((s) => s.image_id) || {}).image_id || "";
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
$("copyMetaBtn").addEventListener("click", async () => {
  const t = $("metaBox").value;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch (e) {
    $("metaBox").select();
    document.execCommand("copy");
  }
  status("메타데이터를 복사했습니다.", "ok");
});

// ---- 자막 스타일 미리보기 ----
const PRESET_PREVIEW = {
  ballad: { base: "#FFFFFF", hi: "#FFE08A", outline: "#101010" },
  kpop: { base: "#FFFFFF", hi: "#FF5FA2", outline: "#101010" },
  citypop: { base: "#FFF4E0", hi: "#7DE0FF", outline: "#201430" },
  simple: { base: "#FFFFFF", hi: "#FFFFFF", outline: "#000000" },
};
function updateStylePreview() {
  const el = $("stylePreview");
  if (!el) return;
  const p = PRESET_PREVIEW[$("subtitleStyle").value] || PRESET_PREVIEW.ballad;
  const o = p.outline;
  const sh = `-2px 0 ${o},2px 0 ${o},0 -2px ${o},0 2px ${o},-2px -2px ${o},2px 2px ${o},-2px 2px ${o},2px -2px ${o}`;
  el.innerHTML =
    `<span style="color:${p.hi};text-shadow:${sh}">부르는 단어</span> ` +
    `<span style="color:${p.base};text-shadow:${sh}">가사 미리보기</span>`;
}
$("subtitleStyle").addEventListener("change", updateStylePreview);

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
  const p = PRESET_PREVIEW[$("subtitleStyle").value] || PRESET_PREVIEW.ballad;
  const ov = $("previewSub");
  const fs = Number($("fontSize").value) || 48;
  const pw = $("preview").clientWidth || 640;
  ov.style.fontSize = Math.max(11, (fs * pw) / 1920) + "px";
  const o = p.outline;
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
  const p = PRESET_PREVIEW[$("subtitleStyle").value] || PRESET_PREVIEW.ballad;
  const words = sc.words && sc.words.length ? sc.words : null;
  if (!words || $("subtitleStyle").value === "simple") {
    return `<span style="color:${p.base}">${escapeHtml(sc.text)}</span>`;
  }
  return words
    .map((w) => `<span style="color:${t >= Number(w.start) ? p.hi : p.base}">${escapeHtml(w.w)}</span>`)
    .join(" ");
}
function updatePreview() {
  const prev = $("preview");
  if (!prev || currentStep < 2) return;
  const t = audio.currentTime || 0;
  let sec = sectionsState.find((s) => t >= s.start && t < s.end);
  if (!sec && sectionsState.length) {
    sec = t < sectionsState[0].start ? sectionsState[0] : sectionsState[sectionsState.length - 1];
  }
  if (sec && sec.image_url) {
    prev.style.backgroundImage = `url('${sec.image_url}')`;
    prev.style.backgroundColor = "";
  } else {
    prev.style.backgroundImage = "";
    prev.style.backgroundColor = $("bgColor").value || "#10131c";
  }
  const sc = scenes.find((s) => t >= s.start && t < s.end);
  let off = false;
  if (sc) off = sectionsState.some((s) => s.subtitle === false && (s.scene_ids || []).includes(sc.id));
  $("previewSub").innerHTML = sc && !off ? karaokeHTML(sc, t) : "";
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
$("prevStep").addEventListener("click", () => goStep(currentStep - 1));
$("nextStep").addEventListener("click", () => goStep(currentStep + 1));

["fontSize", "bgColor", "subtitleStyle", "subtitlePos"].forEach((id) =>
  $(id).addEventListener("input", updatePreview)
);
$("subtitlePos").addEventListener("change", updatePreview);
$("fontSize").addEventListener("input", () => {
  $("fontSizeVal").textContent = $("fontSize").value;
});
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
