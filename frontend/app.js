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
  anchor = null;
  renderRows();
  renderSectionCards();
  renderAnchor();
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
        font_size: Number($("fontSize").value) || 48,
        subtitle_style: $("subtitleStyle").value,
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
    const setRef = document.createElement("button");
    setRef.type = "button";
    setRef.className = "mini-btn anchor-set";
    setRef.textContent = "참조로";
    setRef.title = "이 구간의 선택 이미지를 일관성 참조로 지정";
    rowEl.append(input, gen, setRef);

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
    s.has_face = pick.dataset.hasFace === "1";
    if (!anchor) setAnchor(s); // 첫 선택을 자동 참조로 지정
    renderSectionCards();
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
  $("bgColor").value = st.bg_color || "#101114";
  updateStylePreview();
  const asp = document.querySelector(`input[name="aspect"][value="${st.aspect || "16:9"}"]`);
  if (asp) asp.checked = true;
  if (st.audio_url) audio.src = st.audio_url;
  stopAt = null;
  renderRows();
  renderSectionCards();
  renderAnchor();
  renderChapters();
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

updateLyricStats();
updateActionState();
renderSectionCards();
renderAnchor();
renderChapters();
updateStylePreview();
refreshProjects();
offerRestore();
