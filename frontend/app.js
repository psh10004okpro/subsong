let scenes = [];
let audioId = null;
let bgId = null;
let sectionsState = [];
let stopAt = null;
let statusTimer = null;
let isAligning = false;
let localAudioUrl = null;

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

function setWorkflow(step) {
  document.querySelectorAll(".workflow li").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) <= step);
  });
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
    setWorkflow(2);
    status(`정렬 완료: ${scenes.length}줄을 검토할 수 있습니다.`, "ok");
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
  updateActionState();
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
  renderRows();
  renderSectionCards();
  setWorkflow(1);
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
    renderRows();
    return;
  }

  row.classList.toggle("invalid", scene.end <= scene.start);
  updateActionState();
});

$("addRow").addEventListener("click", () => {
  const t = round2(audio.currentTime || 0);
  scenes.push({
    id: scenes.length,
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
    $("bgName").textContent = file.name;
    status("배경 업로드 완료", "ok");
  } catch (err) {
    status("배경 업로드 실패: " + err.message, "err");
  }
});

$("srtBtn").addEventListener("click", async () => {
  if (!scenes.length) return status("먼저 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");

  const res = await fetch("/api/srt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenes }),
  });
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lyrics.srt";
  a.click();
  URL.revokeObjectURL(a.href);
  setWorkflow(3);
  status("SRT 저장 완료", "ok");
});

$("renderBtn").addEventListener("click", async () => {
  if (!audioId || !scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");

  const button = $("renderBtn");
  button.disabled = true;
  busy("영상 합성 중입니다. 노래 길이에 따라 시간이 걸립니다.");

  // 자막 off 구간의 줄은 자막에서 제외
  const offIds = new Set();
  sectionsState.forEach((s) => {
    if (s.subtitle === false) (s.scene_ids || []).forEach((id) => offIds.add(id));
  });
  const subScenes = scenes.filter((s) => !offIds.has(s.id));

  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_id: audioId,
        scenes: subScenes,
        aspect: getAspect(),
        bg_id: bgId,
        bg_color: $("bgColor").value,
        font_size: Number($("fontSize").value) || 28,
        sections: sectionsState
          .filter((s) => s.image_id)
          .map((s) => ({ start: s.start, end: s.end, image_id: s.image_id })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);

    $("resultVideo").src = data.video_url;
    $("downloadLink").href = data.video_url;
    $("result").classList.remove("hidden");
    setWorkflow(3);
    status("영상 생성 완료. 아래에서 확인할 수 있습니다.", "ok");
  } catch (e) {
    status("영상 생성 실패: " + e.message, "err");
  } finally {
    updateActionState();
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
    gen.textContent = `${CANDIDATE_COUNT}장 생성`;
    rowEl.append(input, gen);

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
        pick.style.backgroundImage = `url('${c.image_url}')`;
        pick.setAttribute("aria-label", "이 이미지 선택");
        cands.append(pick);
      });
      body.append(cands);
    }

    card.append(thumb, body);
    box.appendChild(card);
  });
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
    status(`${sectionsState.length}개 구간으로 나눴습니다. 구간별로 ‘${CANDIDATE_COUNT}장 생성’ 후 1장을 고르세요.`, "ok");
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
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    s.candidates = data.candidates || [];
    if (s.candidates[0]) {
      s.image_id = s.candidates[0].image_id;
      s.image_url = s.candidates[0].image_url;
    }
    renderSectionCards();
    status(`${s.label} 후보 ${s.candidates.length}장 생성 완료. 마음에 드는 1장을 클릭하세요.`, "ok");
  } catch (err) {
    status("이미지 생성 실패: " + err.message, "err");
  } finally {
    genBtn.disabled = false;
  }
}

$("genImagesBtn").addEventListener("click", groupSections);

$("sections").addEventListener("change", (e) => {
  const card = e.target.closest(".section-card");
  if (!card) return;
  const s = sectionsState[Number(card.dataset.i)];
  if (!s) return;
  if (e.target.classList.contains("prompt")) s.image_prompt = e.target.value;
  else if (e.target.classList.contains("subtitle-toggle")) s.subtitle = e.target.checked;
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
    renderSectionCards();
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
    font_size: Number($("fontSize").value) || 28,
    bg_color: $("bgColor").value,
    bg_id: bgId,
  };
}

function applyState(st) {
  audioId = st.audio_id || null;
  scenes = normalizeScenes(st.scenes || []);
  sectionsState = st.sections || [];
  bgId = st.bg_id || null;
  $("lyrics").value = st.lyrics || "";
  $("language").value = st.language || "ko";
  $("imgStyle").value = st.style || "";
  $("fontSize").value = st.font_size || 28;
  $("bgColor").value = st.bg_color || "#101114";
  const asp = document.querySelector(`input[name="aspect"][value="${st.aspect || "16:9"}"]`);
  if (asp) asp.checked = true;
  if (st.audio_url) audio.src = st.audio_url;
  stopAt = null;
  renderRows();
  renderSectionCards();
  updateLyricStats();
  setWorkflow(scenes.length ? 3 : 1);
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

updateLyricStats();
updateActionState();
renderSectionCards();
refreshProjects();
