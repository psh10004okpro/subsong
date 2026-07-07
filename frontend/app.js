// ---- 서브패스(/subsong 등) 배포 대응 ----------------------------------------
// 이 파일은 <base>/app.js 로 로드되므로, 자기 스크립트의 경로에서 앱이 마운트된
// 베이스 경로를 자동 감지한다(루트 배포 시 "" → 동작 동일). 절대경로로 호출하는
// /api·/data 요청에만 이 접두사를 붙여, 서브도메인/서브패스 어디든 그대로 돈다.
const BASE = (() => {
  const s =
    document.currentScript ||
    [...document.scripts].find((x) => /\/app\.js(\?|$)/.test(x.src || ""));
  try {
    return s && s.src ? new URL(s.src).pathname.replace(/\/app\.js.*$/, "") : "";
  } catch (e) {
    return "";
  }
})();
const withBase = (u) =>
  typeof u === "string" && /^\/(api|data)\//.test(u) ? BASE + u : u;
if (BASE) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (u, opt) => _fetch(withBase(u), opt); // 모든 /api·/data fetch 자동 보정
}

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
let outputEditIndex = 0;
let audioLeadSec = 0; // 영상 앞 무음/타이틀 프리롤 길이. 실제 오디오는 이 시간만큼 뒤에서 시작한다.
let mode = "lyrics"; // "lyrics"(가사) | "ambient"(분위기) | "story"(스토리)
let ambientPurpose = "meditation"; // 분위기 모드 목적 프리셋 키
let storyGenre = "yadam"; // 스토리 모드 장르 키
let avatarTone = "trust"; // 아바타 모드 용도(톤)
let avatarImageId = ""; // 생성/기존 아바타 이미지 id (DATA)
let avatarUploadFile = null; // 업로드한 아바타 사진 File (있으면 우선)

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const sampleLyrics = [
  "어두운 밤하늘 아래",
  "너의 이름을 불러본다",
  "바람이 스쳐 지나가도",
  "이 노래는 남아 있을 거야",
].join("\n");

const TUTORIAL_KEY = "subsong_tutorial_seen_v1";
const THEME_KEY = "subsong_theme_v1";
const TUTORIAL_STEPS = [
  {
    title: "음원과 가사를 준비하세요",
    text: "소스 단계에서 MP3/WAV 음원과 줄 단위 가사를 넣습니다. 예시 채우기로 먼저 흐름을 확인할 수도 있습니다.",
  },
  {
    title: "자동 정렬로 자막 싱크를 만듭니다",
    text: "자동 정렬 시작을 누르면 가사별 시작/끝 시간이 만들어집니다. 싱크 단계에서 1줄/2줄 자막, 타이틀, 엔딩도 수정할 수 있습니다.",
  },
  {
    title: "가사별 배경을 생성하거나 업로드하세요",
    text: "배경 단계에서 GPT-Image-2 또는 나노바나나를 선택해 이미지를 만들고, 원하는 줄만 직접 업로드할 수 있습니다.",
  },
  {
    title: "미리보고 MP4로 내보냅니다",
    text: "출력 단계에서 자막 위치, 폰트, 화면 비율을 조정하고 완성 미리보기 후 최종 MP4를 생성합니다.",
  },
];
let tutorialIndex = 0;

const GUIDE_TEXT = {
  undoBtn: "최근 편집 내용을 한 단계 되돌립니다.",
  redoBtn: "되돌린 편집을 다시 적용합니다.",
  guideToggle: "버튼 설명 표시를 켜거나 끕니다.",
  themeSelect: "화면 테마를 화이트 또는 블랙으로 전환합니다. 기본값은 화이트입니다.",
  loadProjectBtn: "선택한 저장 프로젝트를 불러옵니다.",
  deleteProjectBtn: "선택한 프로젝트를 삭제합니다.",
  saveProjectBtn: "현재 작업을 이름을 붙여 프로젝트로 저장합니다.",
  restoreBtn: "브라우저 자동저장 작업을 복구하거나 새로 시작합니다.",
  restoreDismiss: "복구 안내를 닫습니다.",
  sampleBtn: "예시 가사를 입력칸에 추가합니다.",
  alignBtn: "음원과 가사를 분석해 가사별 시작/끝 시간을 만듭니다.",
  autoTwoLineBtn: "전체 가사를 보기 좋은 2줄 자막으로 자동 정리합니다.",
  autoOneLineBtn: "2줄 자막을 다시 1줄 자막으로 합칩니다.",
  addTitleRow: "영상 시작용 타이틀 줄을 추가합니다.",
  addEndingRow: "영상 마지막 엔딩 줄을 추가합니다.",
  addRow: "현재 재생 위치 근처에 새 가사 줄을 추가합니다.",
  autoPromptBtn: "가사와 전체 분위기로 한글 이미지 프롬프트 초안을 작성합니다.",
  beatSnapBtn: "배경 구간 경계를 가까운 비트 위치에 맞춥니다.",
  genAllBtn: "가사별 배경 슬롯과 프롬프트를 준비하고 전체 이미지를 순서대로 생성합니다.",
  genImagesBtn: "가사 줄마다 배경을 지정할 슬롯을 만듭니다.",
  genAnchorBtn: "전체 배경 생성에 먼저 사용할 참조 이미지를 만듭니다.",
  uploadAnchorBtn: "가지고 있는 이미지를 전체 생성용 참조 이미지로 등록합니다.",
  clearAnchorBtn: "이후 이미지 생성에 쓰는 참조 이미지를 해제합니다.",
  fontUploadBtn: "로컬 폰트 파일을 업로드해 자막 폰트로 사용합니다.",
  resetColors: "현재 자막 스타일의 기본 글자색과 강조색으로 되돌립니다.",
  srtBtn: "현재 자막 싱크를 SRT 파일로 다운로드합니다.",
  manualEditBtn: "전체 화면 타임라인 편집기로 이동해 수동 보정을 합니다.",
  previewRenderBtn: "최종 MP4 전에 낮은 해상도 미리보기 영상을 만듭니다.",
  renderBtn: "현재 설정으로 최종 MP4 영상을 생성합니다.",
  cancelRenderBtn: "진행 중인 미리보기 또는 MP4 생성을 취소합니다.",
  railPreviewBtn: "완성 미리보기와 출력 설정이 있는 마지막 단계로 이동합니다.",
  railTimelineBtn: "전체 화면 타임라인 수동 편집기를 엽니다.",
  thumbBtn: "대표 배경 이미지와 제목으로 유튜브용 썸네일을 만듭니다.",
  metaBtn: "유튜브 업로드용 제목, 설명, 태그 초안을 생성합니다.",
  copyChaptersBtn: "설명란 챕터 타임스탬프를 클립보드에 복사합니다.",
  copyMetaBtn: "생성된 메타데이터를 클립보드에 복사합니다.",
  prevStep: "이전 작업 단계로 이동하고 현재 작업을 즉시 자동저장합니다.",
  nextStep: "다음 작업 단계로 이동하고 현재 작업을 즉시 자동저장합니다.",
  timelinePrev: "수동 편집에서 이전 가사 구간으로 이동합니다.",
  timelinePlay: "선택한 가사 구간만 재생하거나 정지합니다.",
  timelineNext: "수동 편집에서 다음 가사 구간으로 이동합니다.",
  manualSaveProjectBtn: "수동 편집 내용을 프로젝트로 저장합니다.",
  manualExitBtn: "수동 편집을 마치고 일반 화면으로 돌아갑니다.",
  timelineSetStart: "현재 재생 위치를 선택 구간의 시작 시간으로 적용합니다.",
  timelineSetEnd: "현재 재생 위치를 선택 구간의 끝 시간으로 적용합니다.",
  timelineUpload: "선택 구간의 배경 이미지나 영상을 직접 업로드합니다.",
  timelineGenerate: "선택 구간의 프롬프트로 이미지를 생성합니다.",
  timelineChat: "대화로 프롬프트를 다듬고 이미지를 생성한 뒤 선택 구간에 적용합니다.",
  timelineClearBg: "선택 구간의 배경을 비우고 이전 배경을 이어 쓰게 합니다.",
};

const STEP_GUIDE = {
  1: "음원과 원본 가사를 준비하는 단계입니다.",
  2: "자막 시간과 가사 줄을 확인하고 수정하는 단계입니다.",
  3: "가사별 이미지 프롬프트, 생성 이미지, 업로드 배경을 관리하는 단계입니다.",
  4: "자막 스타일, 화면 비율, 미리보기, MP4 출력을 설정하는 단계입니다.",
};

const ACTION_GUIDE = {
  setstart: "현재 재생 위치를 이 줄의 시작 시간으로 지정합니다.",
  setend: "현재 재생 위치를 이 줄의 끝 시간으로 지정합니다.",
  play: "이 가사 줄만 시작부터 끝까지 재생합니다.",
  del: "이 가사 줄을 삭제합니다.",
};

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function savedTheme() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch (e) {
    return "light";
  }
}

function applyTheme(value, notify = false) {
  const next = normalizeTheme(value);
  document.body.classList.toggle("theme-dark", next === "dark");
  document.body.classList.toggle("theme-light", next === "light");
  document.documentElement.dataset.theme = next;
  const select = $("themeSelect");
  if (select) select.value = next;
  if (notify) status(next === "dark" ? "블랙 테마를 적용했습니다." : "화이트 테마를 적용했습니다.", "ok");
}

function setupTheme() {
  applyTheme(savedTheme());
  const select = $("themeSelect");
  if (!select) return;
  select.addEventListener("change", (e) => {
    const next = normalizeTheme(e.target.value);
    applyTheme(next, true);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      /* 저장 불가 환경이면 이번 세션에만 적용한다 */
    }
  });
}

function setGuide(el, text) {
  if (!el || !text) return;
  el.dataset.guide = text;
  if (!el.title) el.title = text;
}

function forGuideMatches(root, selector, fn) {
  if (root && root.nodeType === 1 && root.matches(selector)) fn(root);
  if (root && root.querySelectorAll) root.querySelectorAll(selector).forEach(fn);
}

function applyButtonGuides(root = document) {
  Object.entries(GUIDE_TEXT).forEach(([id, text]) => setGuide($(id), text));
  document.querySelectorAll(".steps li[data-step]").forEach((li) => {
    setGuide(li, STEP_GUIDE[li.dataset.step]);
  });
  document.querySelectorAll(".rail-item[data-rail-step]").forEach((button) => {
    setGuide(button, STEP_GUIDE[button.dataset.railStep]);
  });
  forGuideMatches(root, ".line button[data-act]", (button) => {
    setGuide(button, ACTION_GUIDE[button.dataset.act]);
  });
  forGuideMatches(root, ".section-card .gen", (button) =>
    setGuide(button, "이 가사의 프롬프트로 배경 이미지를 생성합니다."));
  forGuideMatches(root, ".section-card .image-chat", (button) =>
    setGuide(button, "채팅 팝업에서 대화하며 이미지를 생성하고 마음에 들 때 적용합니다."));
  forGuideMatches(root, ".section-card .upload", (button) =>
    setGuide(button, "내 이미지나 영상을 이 가사 배경으로 올립니다."));
  forGuideMatches(root, ".section-card .anchor-set", (button) =>
    setGuide(button, "이 구간 이미지를 다음 생성의 참조 이미지로 사용합니다."));
  forGuideMatches(root, ".candidate", (button) =>
    setGuide(button, "이 후보 이미지를 해당 가사 배경으로 선택합니다."));
  forGuideMatches(root, ".timeline-clip", (button) =>
    setGuide(button, "이 구간을 선택하고 수동 편집 인스펙터로 불러옵니다."));
  forGuideMatches(root, ".stage-timeline-clip", (button) =>
    setGuide(button, "이 가사 위치로 미리보기를 이동합니다."));
  forGuideMatches(root, "a[download]", (link) =>
    setGuide(link, "생성된 파일을 다운로드합니다."));
}

function positionGuideTip(target) {
  const tip = $("guideTip");
  if (!tip || !target || !target.dataset.guide) return;
  tip.textContent = target.dataset.guide;
  tip.classList.remove("hidden");
  tip.style.left = "0px";
  tip.style.top = "0px";
  const rect = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - tw - 8));
  let top = rect.bottom + 10;
  if (top + th > window.innerHeight - 8) top = Math.max(8, rect.top - th - 10);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function hideGuideTip() {
  const tip = $("guideTip");
  if (tip) tip.classList.add("hidden");
}

let guideSetupDone = false;
function setupGuides() {
  if (guideSetupDone) return;
  guideSetupDone = true;
  applyButtonGuides();
  const observer = new MutationObserver((items) => {
    items.forEach((item) => {
      item.addedNodes.forEach((node) => {
        if (node.nodeType === 1) applyButtonGuides(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("pointerover", (e) => {
    const target = e.target.closest("[data-guide]");
    if (target) positionGuideTip(target);
  });
  document.addEventListener("pointerout", (e) => {
    const target = e.target.closest("[data-guide]");
    if (target && !target.contains(e.relatedTarget)) hideGuideTip();
  });
  document.addEventListener("focusin", (e) => {
    const target = e.target.closest("[data-guide]");
    if (target) positionGuideTip(target);
  });
  document.addEventListener("focusout", hideGuideTip);
  window.addEventListener("scroll", hideGuideTip, true);
  window.addEventListener("resize", hideGuideTip);

  $("guideToggle").addEventListener("click", () => {
    const on = !document.body.classList.contains("guide-mode");
    document.body.classList.toggle("guide-mode", on);
    $("guideToggle").setAttribute("aria-pressed", on ? "true" : "false");
    status(on ? "가이드 표시를 켰습니다. 버튼 위에 올리면 설명이 보입니다." : "가이드 표시를 껐습니다.", "ok");
  });
}

function setTutorialSeen() {
  try {
    localStorage.setItem(TUTORIAL_KEY, "1");
  } catch (e) {
    /* 저장 불가 환경이면 이번 세션에서만 닫힌다 */
  }
}

function renderTutorial() {
  const step = TUTORIAL_STEPS[tutorialIndex] || TUTORIAL_STEPS[0];
  if (!$("tutorialTitle")) return;
  $("tutorialStepNo").textContent = String(tutorialIndex + 1);
  $("tutorialTitle").textContent = step.title;
  $("tutorialText").textContent = step.text;
  $("tutorialPrev").disabled = tutorialIndex === 0;
  $("tutorialNext").textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? "시작하기" : "다음";
  const dots = $("tutorialDots");
  if (dots) {
    dots.innerHTML = "";
    TUTORIAL_STEPS.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "tutorial-dot" + (i === tutorialIndex ? " active" : "");
      dot.setAttribute("aria-label", `${i + 1}번째 튜토리얼 보기`);
      dot.addEventListener("click", () => {
        tutorialIndex = i;
        renderTutorial();
      });
      dots.appendChild(dot);
    });
  }
}

function closeTutorial(markSeen = true) {
  const overlay = $("tutorialOverlay");
  if (!overlay) return;
  if (markSeen) setTutorialSeen();
  overlay.classList.add("hidden");
  document.body.classList.remove("tutorial-open");
}

function showTutorial(force = false) {
  const overlay = $("tutorialOverlay");
  if (!overlay) return;
  if (!force) {
    try {
      if (localStorage.getItem(TUTORIAL_KEY) === "1") return;
    } catch (e) {
      /* localStorage 차단 시에도 튜토리얼은 보여준다 */
    }
  }
  tutorialIndex = 0;
  renderTutorial();
  overlay.classList.remove("hidden");
  document.body.classList.add("tutorial-open");
  setTimeout(() => $("tutorialNext") && $("tutorialNext").focus(), 0);
}

function setupTutorial() {
  if (!$("tutorialOverlay")) return;
  $("tutorialSkip").addEventListener("click", () => closeTutorial(true));
  $("tutorialClose").addEventListener("click", () => closeTutorial(true));
  $("tutorialPrev").addEventListener("click", () => {
    tutorialIndex = Math.max(0, tutorialIndex - 1);
    renderTutorial();
  });
  $("tutorialNext").addEventListener("click", () => {
    if (tutorialIndex >= TUTORIAL_STEPS.length - 1) return closeTutorial(true);
    tutorialIndex += 1;
    renderTutorial();
  });
  $("tutorialOverlay").addEventListener("click", (e) => {
    if (e.target === $("tutorialOverlay")) closeTutorial(true);
  });
  document.addEventListener("keydown", (e) => {
    if ($("tutorialOverlay").classList.contains("hidden")) return;
    if (e.key === "Escape") closeTutorial(true);
  });
}

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

  const ambient = isAmbient();
  $("alignBtn").disabled = isAligning || !hasSource || !hasLyrics;
  if ($("ambientBtn")) $("ambientBtn").disabled = !hasSource;
  if ($("storyBtn")) $("storyBtn").disabled = !($("storyText") && $("storyText").value.trim());
  if ($("avatarBtn")) $("avatarBtn").disabled = !($("avatarScript") && $("avatarScript").value.trim() && (avatarImageId || avatarUploadFile));
  $("srtBtn").disabled = !hasScenes || !timingOk;
  const canRender = !isRendering && audioId && hasScenes && timingOk;
  if ($("manualEditBtn")) $("manualEditBtn").disabled = !hasScenes;
  $("previewRenderBtn").disabled = !canRender;
  $("renderBtn").disabled = !canRender;
  $("genImagesBtn").disabled = !hasScenes;
  if ($("genAllBtn")) $("genAllBtn").disabled = !hasScenes;
  // 분위기 모드는 가사 싱크가 없으므로 스탭2에 안내만 띄운다.
  const ambientNotice = $("ambientSyncNotice");
  if (ambient) {
    if (ambientNotice) ambientNotice.classList.remove("hidden");
    $("editorEmpty").classList.add("hidden");
    $("editorTools").classList.add("hidden");
  } else {
    if (ambientNotice) ambientNotice.classList.add("hidden");
    $("editorEmpty").classList.toggle("hidden", hasScenes);
    $("editorTools").classList.toggle("hidden", !hasScenes);
  }
  $("lineSummary").textContent = hasScenes
    ? `${scenes.length}줄 · ${timingOk ? "시간 정상" : "시간 확인 필요"}`
    : "0줄";
}

function hasTimingIssues() {
  return scenes.some((sc) => Number(sc.end) <= Number(sc.start));
}

function isManualMode() {
  const page = $("manualEditorPage");
  return !!(page && !page.classList.contains("hidden"));
}

function updateStudioChromeHeight() {
  const header = document.querySelector(".app-header");
  const headerHeight = header ? header.getBoundingClientRect().height : 112;
  const verticalGap = 22; // studio 위/아래 여백과 안전 여유
  document.documentElement.style.setProperty("--studio-chrome-h", `${Math.ceil(headerHeight + verticalGap)}px`);
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
  document.querySelectorAll(".rail-item[data-rail-step]").forEach((button) => {
    const s = Number(button.dataset.railStep);
    button.classList.toggle("active", s === currentStep);
    button.classList.toggle("done", s < currentStep);
    if (s === currentStep) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".step").forEach((p) => {
    p.classList.remove("hidden");
    p.classList.toggle("active", Number(p.dataset.step) === currentStep);
  });
  const withStage = currentStep >= 2;
  if (!isManualMode()) $("stage").classList.toggle("hidden", !withStage);
  document.querySelector(".studio").classList.toggle("with-stage", withStage);
  $("prevStep").classList.toggle("hidden", currentStep === 1);
  $("nextStep").classList.toggle("hidden", currentStep === 4);
  if (withStage) {
    updateStudioChromeHeight();
    setPreviewAspect();
    updatePreview();
    renderStageTimeline();
  }
  if (currentStep === 4) renderOutputTimeline();
  window.scrollTo({ top: 0, behavior: "smooth" });
  saveAutosaveNow();  // 단계 이동(정렬 완료 포함)은 디바운스 없이 즉시 저장
}

function getAspect() {
  const manual = $("manualAspect");
  if (isManualMode() && manual && manual.value) return manual.value;
  const checked = document.querySelector('input[name="aspect"]:checked');
  return checked ? checked.value : "16:9";
}

function syncAspect(value, save = true) {
  const next = ["16:9", "9:16", "1:1"].includes(value) ? value : "16:9";
  const radio = document.querySelector(`input[name="aspect"][value="${next}"]`);
  if (radio) radio.checked = true;
  if ($("manualAspect")) $("manualAspect").value = next;
  setPreviewAspect();
  updatePreview();
  if (save) scheduleAutosave();
}

function getImageProvider() {
  const manual = $("manualImageProvider");
  const el = isManualMode() && manual ? manual : $("imageProvider");
  return el ? el.value || "chatgpt_proxy" : "chatgpt_proxy";
}

function imageProviderLabel() {
  const manual = $("manualImageProvider");
  const el = isManualMode() && manual ? manual : $("imageProvider");
  return el && el.selectedOptions[0] ? el.selectedOptions[0].textContent : "GPT-Image-2";
}

function syncImageProvider(value) {
  const main = $("imageProvider");
  const manual = $("manualImageProvider");
  const requested = value || getImageProvider();
  const hasOption = (el, next) => el && [...el.options].some((option) => option.value === next);
  const next = hasOption(main, requested) || hasOption(manual, requested) ? requested : "chatgpt_proxy";
  if (main) main.value = next;
  if (manual) manual.value = next;
}

function imageProviderButtonLabel() {
  return "이미지 생성";
}

function karaokeEnabled() {
  const el = $("karaokeToggle");
  return !!(el && el.checked);
}

function karaokeHighlightActive() {
  return karaokeEnabled() && $("subtitleStyle").value !== "simple";
}

const ASPECT_SIZE = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
};

function subtitleOffsets() {
  return {
    x: Number($("subtitleOffsetX").value) || 0,
    y: Number($("subtitleOffsetY").value) || 0,
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function titleLeadSeconds() {
  const el = $("titleLeadSec");
  return clampNumber(el ? el.value : 3, 0.5, 30, 3);
}

function endingTailSeconds() {
  const el = $("endingTailSec");
  return clampNumber(el ? el.value : 3, 0.5, 60, 3);
}

function timelineAudioOffset() {
  return Math.max(0, Number(audioLeadSec) || 0);
}

function currentTimelineTime() {
  return round2((audio.currentTime || 0) + timelineAudioOffset());
}

function audioTimeFromTimeline(t) {
  return Math.max(0, (Number(t) || 0) - timelineAudioOffset());
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
    audioLeadSec = 0;
    audio.src = data.audio_url;
    if (!$("songTitle").value.trim()) $("songTitle").value = defaultTitleText();
    const addedSpecialRows = ensureDefaultSpecialRows();
    stopAt = null;
    sectionsState = [];
    renderRows();
    renderSectionCards();
    resetHistory(); // 정렬 결과를 되돌리기 시작점으로
    goStep(2);
    status(`정렬 완료: ${scenes.length}줄${addedSpecialRows ? " (타이틀/엔딩 포함)" : ""}. 미리보기로 확인하며 고치세요.`, "ok");
  } catch (e) {
    status("정렬 실패: " + e.message, "err");
  } finally {
    isAligning = false;
    $("alignBtn").textContent = "자동 정렬 시작";
    updateActionState();
  }
}

// ---- 제작 모드: lyrics(가사) / ambient(분위기) / story(스토리) / avatar(아바타) ----
const MODES = ["lyrics", "ambient", "story", "avatar"];
const MODE_LABELS = {
  lyrics: "🎤 가사 뮤직비디오",
  ambient: "🌙 분위기 영상",
  story: "📖 스토리 영상",
  avatar: "🧑‍💼 아바타 영상",
};
function isAmbient() {
  return mode === "ambient";
}
function isStory() {
  return mode === "story";
}
function isAvatar() {
  return mode === "avatar";
}
// ambient·story는 가사 그룹핑 대신 sections를 미리 만들어 쓰는 공통 성격.
function isPrebuiltMode() {
  return isAmbient() || isStory();
}

function setMode(next, save = true) {
  mode = MODES.includes(next) ? next : "lyrics";
  MODES.forEach((m) => {
    document.querySelectorAll(`.mode-${m}-only`).forEach((el) => el.classList.toggle("hidden", mode !== m));
  });
  // 음원 업로드는 lyrics/ambient 전용(story·avatar는 음성을 자동 생성).
  const af = $("audioFile");
  const afField = af && af.closest(".field");
  if (afField) afField.classList.toggle("hidden", isStory() || isAvatar());
  // 아바타는 이 화면에서 바로 결과가 나오는 단일-스텝 모드 → 단계 이동 버튼 숨김.
  if ($("nextStep")) $("nextStep").classList.toggle("hidden", isAvatar() || currentStep === 4);
  const banner = $("modeBannerName");
  if (banner) banner.textContent = MODE_LABELS[mode];
  updateActionState();
  renderChapters(); // 스탭3 버튼(가사별 나누기·프롬프트·비트) 노출을 모드에 맞게 갱신
  checkServices(); // 스토리·아바타가 쓰는 외부 서비스 헬스 경고
  if (save) scheduleAutosave();
}

// 스토리(TTS·LLM)·아바타(마브·LLM) 외부 서비스 헬스 → 다운 시 사전 경고.
async function checkServices() {
  const warn = $("serviceWarn");
  if (!warn) return;
  if (!isStory() && !isAvatar()) {
    warn.classList.add("hidden");
    return;
  }
  try {
    const h = await (await fetch("/api/health/services")).json();
    const down = [];
    if (isStory() && !h.tts) down.push("나레이션(TTS)");
    if (isAvatar() && !h.marv) down.push("아바타 생성(마브)");
    if (!h.llm) down.push("AI 자동생성(LLM)");
    if (down.length) {
      warn.innerHTML =
        `<strong>일부 서비스가 응답하지 않습니다: ${escapeHtml(down.join(", "))}</strong>` +
        "<span>지금 만들면 실패하거나 일부 기능이 제한될 수 있습니다. 잠시 후 다시 시도해 주세요.</span>";
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
    }
  } catch (e) {
    warn.classList.add("hidden");
  }
}

// 진입 화면(landing): 무엇을 만들지 먼저 고르고 스튜디오로 들어간다.
function showModeLanding(canContinue = false) {
  const foot = $("modeLandingContinue");
  if (foot) foot.classList.toggle("hidden", !canContinue);
  $("modeLanding").classList.remove("hidden");
}

// 자동저장된 이어서할 작업이 있는지(적용하지 않고 확인만).
function hasRestorableSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
    const st = saved && saved.state;
    return !!(st && ((st.scenes || []).length || (st.lyrics || "").trim()));
  } catch (e) {
    return false;
  }
}

function chooseMode(next) {
  setMode(next);
  $("modeLanding").classList.add("hidden");
  goStep(1);
  showTutorial(false); // 처음 사용자면 튜토리얼 표시(이미 봤으면 자동 스킵)
}

async function doAmbient() {
  const file = $("audioFile").files[0];
  if (!file) return status("음원 파일을 선택하세요.", "err");
  const mood = $("ambientMood").value.trim();
  if (ambientPurpose === "custom" && !mood) {
    return status("직접입력을 선택했으면 분위기 문구를 입력하세요.", "err");
  }
  const count = clampNumber($("sceneCount").value, 1, 30, 6);

  const btn = $("ambientBtn");
  btn.disabled = true;
  btn.textContent = "만드는 중…";
  busy("음원 길이에 맞춰 장면을 나누는 중입니다.");

  const fd = new FormData();
  fd.append("audio", file);
  fd.append("purpose", ambientPurpose);
  fd.append("mood", mood);
  fd.append("count", String(count));
  fd.append("style", $("imgStyle") ? $("imgStyle").value.trim() : "");

  try {
    const res = await fetch("/api/ambient", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);

    audioId = data.audio_id;
    scenes = normalizeScenes(data.scenes || []);
    sectionsState = (data.sections || []).map((s) => ({
      ...s, candidates: [], subtitle: false,
    }));
    audioLeadSec = 0;
    audio.src = data.audio_url;
    if (!$("songTitle").value.trim()) $("songTitle").value = defaultTitleText();
    // 분위기 영상에 맞는 기본 연출: 자막 없음(심플)·크로스페이드·잔잔한 줌.
    $("subtitleStyle").value = "simple";
    $("karaokeToggle").checked = false;
    $("transition").value = "crossfade";
    if (Number($("kenBurns").value) === 0) $("kenBurns").value = 0.06;
    updateFxLabels();
    updateStylePreview();
    stopAt = null;
    renderRows();
    renderSectionCards();
    renderAnchor();
    renderChapters();
    resetHistory();
    goStep(3);
    status(`${scenes.length}개 장면을 만들었습니다. ‘전체 이미지 자동생성’으로 배경을 채우세요.`, "ok");
  } catch (e) {
    status("장면 생성 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "장면 만들기";
    updateActionState();
  }
}

// ---- 스토리(이야기) 모드 — 대본 → 나레이션 + 장면 이미지 ----
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateStoryStats() {
  const el = $("storyText");
  if (el && $("storyStats")) $("storyStats").textContent = `${el.value.length}자`;
}

async function doStoryGenerate() {
  const topic = $("storyTopic").value.trim();
  if (!topic) return status("AI로 생성할 주제를 입력하세요.", "err");
  const btn = $("storyGenBtn");
  btn.disabled = true;
  btn.textContent = "생성 중…";
  busy("AI가 이야기를 쓰는 중입니다…");
  try {
    const res = await fetch("/api/story/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, genre: storyGenre, length: Number($("storyLength").value) || 60 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    $("storyText").value = data.text || "";
    updateStoryStats();
    updateActionState();
    status("이야기 대본을 생성했습니다. 확인·수정 후 ‘이야기 영상 만들기’를 누르세요.", "ok");
  } catch (e) {
    status("이야기 생성 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI 생성";
  }
}

async function doStory() {
  const text = $("storyText").value.trim();
  if (!text) return status("이야기 대본을 입력하거나 AI로 생성하세요.", "err");
  if (storyGenre === "custom" && !($("storyMood") && $("storyMood").value.trim())) {
    return status("‘직접’ 장르는 분위기·화풍을 입력하세요.", "err");
  }
  const btn = $("storyBtn");
  btn.disabled = true;
  btn.textContent = "만드는 중…";
  busy("나레이션·장면을 만드는 중입니다. 1~2분 걸릴 수 있어요…");
  try {
    const res = await fetch("/api/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, genre: storyGenre, voice: $("storyVoice").value || "warm_f",
        custom_style: $("storyMood") ? $("storyMood").value.trim() : "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    const result = await pollStoryJob(data.job_id);

    audioId = result.audio_id;
    scenes = normalizeScenes(result.scenes || []);
    sectionsState = (result.sections || []).map((s) => ({
      ...s, candidates: [], subtitle: s.subtitle !== false,
    }));
    audioLeadSec = 0;
    audio.src = result.audio_url;
    if (!$("songTitle").value.trim()) $("songTitle").value = defaultTitleText();
    // 스토리: 나레이션 자막 ON(하이라이트 없는 심플)·크로스페이드·잔잔한 줌.
    $("subtitleStyle").value = "simple";
    $("karaokeToggle").checked = false;
    $("transition").value = "crossfade";
    if (Number($("kenBurns").value) === 0) $("kenBurns").value = 0.06;
    updateFxLabels();
    updateStylePreview();
    stopAt = null;
    renderRows();
    renderSectionCards();
    renderAnchor();
    renderChapters();
    resetHistory();
    goStep(3);
    status(`${scenes.length}개 장면을 만들었습니다. ‘전체 이미지 자동생성’으로 배경을 채우세요.`, "ok");
  } catch (e) {
    status("이야기 영상 만들기 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "이야기 영상 만들기";
    updateActionState();
  }
}

let currentJobId = null; // 진행 중 스토리/아바타 잡 (취소용)
const JOB_POLL_TIMEOUT_MS = 25 * 60 * 1000; // 25분 상한

async function pollStoryJob(jid) {
  currentJobId = jid;
  if ($("jobCancelBtn")) $("jobCancelBtn").classList.remove("hidden");
  const started = performance.now();
  try {
    for (;;) {
      await _sleep(1000);
      if (performance.now() - started > JOB_POLL_TIMEOUT_MS) {
        throw new Error("시간이 초과되었습니다(25분). 서비스 상태를 확인하세요.");
      }
      const res = await fetch(`/api/jobs/${jid}`);
      if (!res.ok) throw new Error("작업 상태를 가져오지 못했습니다.");
      const j = await res.json();
      if (j.message) busy(`${j.message} (${Math.round((j.progress || 0) * 100)}%)`);
      if (j.status === "done") return j.result || {};
      if (j.status === "error") throw new Error(j.error || "생성 실패");
      if (j.status === "cancelled") throw new Error("취소됨");
    }
  } finally {
    currentJobId = null;
    if ($("jobCancelBtn")) $("jobCancelBtn").classList.add("hidden");
  }
}

// ---- 아바타(인물이 말하는) 모드 — 마브 talking_head ----
async function loadAvatarOptions() {
  const sel = $("avatarVoice");
  if (!sel) return;
  try {
    const res = await fetch("/api/avatar/options");
    const data = await res.json();
    const voices = data.voices || [];
    sel.innerHTML = voices.length
      ? voices.map((v) => `<option value="${v.key}">${escapeHtml(v.label)}</option>`).join("")
      : '<option value="">저장된 목소리 없음</option>';
    const msel = $("avatarModel");
    if (msel) {
      const models = data.models || [];
      msel.innerHTML = '<option value="">기본(용도별 추천)</option>' +
        models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    }
  } catch (e) {
    sel.innerHTML = '<option value="">목소리 목록 실패</option>';
  }
}

function updateAvatarStats() {
  const el = $("avatarScript");
  if (el && $("avatarStats")) $("avatarStats").textContent = `${el.value.length}자`;
}

function setAvatarPreview(url) {
  const box = $("avatarPreview");
  if (!box) return;
  box.innerHTML = url ? `<img src="${url}" alt="아바타" />` : "<span>아바타 미리보기</span>";
}

async function doAvatarGenImage() {
  const desc = $("avatarDesc").value.trim();
  const btn = $("avatarGenImgBtn");
  btn.disabled = true;
  btn.textContent = "생성 중…";
  busy("AI 아바타 이미지를 생성하는 중입니다…");
  try {
    const res = await fetch("/api/avatar/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc, tone: avatarTone }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    avatarImageId = data.image_id;
    avatarUploadFile = null;
    setAvatarPreview(data.image_url);
    updateActionState();
    status("아바타 이미지를 생성했습니다.", "ok");
  } catch (e) {
    status("아바타 이미지 생성 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI 생성";
  }
}

async function doAvatarGenScript() {
  const topic = $("avatarTopic").value.trim();
  if (!topic) return status("AI로 생성할 주제를 입력하세요.", "err");
  const btn = $("avatarGenScriptBtn");
  btn.disabled = true;
  btn.textContent = "생성 중…";
  busy("AI가 대본을 쓰는 중입니다…");
  try {
    const res = await fetch("/api/avatar/generate-script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, tone: avatarTone, length: Number($("avatarLength").value) || 20 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    $("avatarScript").value = data.text || "";
    updateAvatarStats();
    updateActionState();
    status("대본을 생성했습니다. 확인·수정 후 ‘아바타 영상 만들기’를 누르세요.", "ok");
  } catch (e) {
    status("대본 생성 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ 대본";
  }
}

async function doAvatar() {
  const script = $("avatarScript").value.trim();
  if (!script) return status("대본을 입력하거나 AI로 생성하세요.", "err");
  if (!avatarUploadFile && !avatarImageId) return status("아바타 이미지를 업로드하거나 생성하세요.", "err");
  const btn = $("avatarBtn");
  btn.disabled = true;
  btn.textContent = "만드는 중…";
  $("avatarResult").classList.add("hidden");
  busy("아바타 영상을 만드는 중입니다. 1~3분 걸릴 수 있어요…");
  try {
    const fd = new FormData();
    fd.append("script", script);
    fd.append("voice", $("avatarVoice").value || "");
    fd.append("tone", avatarTone);
    fd.append("model", ($("avatarModel") && $("avatarModel").value) || "");
    fd.append("longform", $("avatarLongform") && $("avatarLongform").checked ? "true" : "false");
    fd.append("aspect", "9:16");
    if (avatarUploadFile) fd.append("portrait", avatarUploadFile);
    else fd.append("image_id", avatarImageId);
    const res = await fetch("/api/avatar", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    const result = await pollStoryJob(data.job_id);
    const url = result.video_url;
    $("avatarVideo").src = url;
    $("avatarDownload").href = url;
    $("avatarResult").classList.remove("hidden");
    status("아바타 영상을 만들었습니다.", "ok");
  } catch (e) {
    status("아바타 영상 만들기 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "아바타 영상 만들기";
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
    const lyric = makeTextarea("lyric", scene.text, "가사");

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
  renderOutputTimeline();
  recordHistorySoon();
}

function makeInput(className, value, label) {
  const input = document.createElement("input");
  input.className = className;
  input.value = value;
  input.setAttribute("aria-label", label);
  return input;
}

function makeTextarea(className, value, label) {
  const textarea = document.createElement("textarea");
  textarea.className = className;
  textarea.value = value;
  textarea.rows = 2;
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", label);
  return textarea;
}

function twoLineText(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  return lines.length <= 2 ? lines.join("\n") : [lines[0], lines.slice(1).join(" ")].join("\n");
}

function oneLineText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function autoTwoLineText(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").split("\n").join(" ").replace(/\s+/g, " ").trim();
  if (!text || text.length <= 16) return text;

  const chars = [...text];
  const mid = Math.floor(chars.length / 2);
  const breakChars = new Set([" ", ",", ".", "?", "!", "，", "。", "、", "?", "!", "·", "/", "-"]);
  let best = -1;
  let bestDist = Infinity;
  chars.forEach((ch, i) => {
    if (!breakChars.has(ch)) return;
    if (i < 4 || i > chars.length - 5) return;
    const dist = Math.abs(i - mid);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  });

  const splitAt = best >= 0 ? best + (chars[best] === " " ? 0 : 1) : mid;
  const left = chars.slice(0, splitAt).join("").trim();
  const right = chars.slice(splitAt).join("").trim();
  if (!left || !right) return text;
  return `${left}\n${right}`;
}

function autoTwoLineAll() {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  let changed = 0;
  scenes = scenes.map((scene) => {
    const next = twoLineText(autoTwoLineText(scene.text));
    if (next !== scene.text) changed++;
    return { ...scene, text: next };
  });
  syncSectionTimes();
  renderRows();
  if (sectionsState.length) {
    renderSectionCards();
    renderChapters();
  }
  updatePreview();
  updateActionState();
  status(changed ? `${changed}개 가사를 2줄 자막으로 정리했습니다.` : "이미 2줄 기준으로 정리되어 있습니다.", "ok");
}

function autoOneLineAll() {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  let changed = 0;
  scenes = scenes.map((scene) => {
    const next = oneLineText(scene.text);
    if (next !== scene.text) changed++;
    return { ...scene, text: next };
  });
  syncSectionTimes();
  renderRows();
  if (sectionsState.length) {
    renderSectionCards();
    renderChapters();
  }
  updatePreview();
  updateActionState();
  status(changed ? `${changed}개 가사를 1줄 자막으로 정리했습니다.` : "이미 1줄 기준으로 정리되어 있습니다.", "ok");
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

function nextSceneId() {
  return scenes.reduce((m, s) => Math.max(m, Number(s.id) || 0), -1) + 1;
}

function sceneSortBias(scene) {
  if (scene && scene.section === "title") return -1;
  if (scene && scene.section === "ending") return 1;
  return 0;
}

function sortScenes() {
  scenes.sort((a, b) =>
    Number(a.start) - Number(b.start)
    || sceneSortBias(a) - sceneSortBias(b)
    || Number(a.id) - Number(b.id));
}

function defaultTitleText() {
  const typed = $("songTitle") ? $("songTitle").value.trim() : "";
  if (typed) return typed;
  const file = $("audioFile") && $("audioFile").files ? $("audioFile").files[0] : null;
  const fromFile = file ? String(file.name || "").replace(/\.[^.]+$/, "").trim() : "";
  return fromFile || "타이틀";
}

function estimatedAudioEnd(includeSpecial = false) {
  return scenes.reduce((m, s) => {
    if (!includeSpecial && (s.section === "title" || s.section === "ending")) return m;
    return Math.max(m, Number(s.end) || 0);
  }, 0);
}

function regularScenes() {
  return scenes.filter((s) => s.section !== "title" && s.section !== "ending");
}

function firstRegularStart(items = regularScenes()) {
  return items.reduce((m, s) => Math.min(m, Number(s.start) || 0), Infinity);
}

function lastRegularEnd(items = regularScenes()) {
  return items.reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
}

function audioEndTime() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
}

function videoAudioEndTime() {
  return timelineAudioOffset() + audioEndTime();
}

function makeSpecialScene(kind) {
  const fallbackDur = 3;
  const regular = regularScenes();
  const title = defaultTitleText();
  if (kind === "title") {
    const firstStart = firstRegularStart(regular);
    const fallbackEnd = Math.min(fallbackDur, estimatedAudioEnd(true) || fallbackDur);
    const end = Number.isFinite(firstStart)
      ? Math.max(0.1, firstStart)
      : fallbackEnd;
    return {
      id: nextSceneId(),
      start: 0,
      end: round2(end),
      text: title,
      section: "title",
      image_prompt: `${title}, opening title scene, cinematic music video`,
      image_path: "",
      video_path: "",
    };
  }

  const regularEnd = lastRegularEnd(regular);
  const audioEnd = videoAudioEndTime();
  const start = round2(regularEnd);
  const end = round2(audioEnd > regularEnd ? audioEnd : regularEnd + fallbackDur);
  return {
    id: nextSceneId(),
    start,
    end,
    text: "엔딩",
    section: "ending",
    image_prompt: "ending scene, final outro, cinematic music video",
    image_path: "",
    video_path: "",
  };
}

function ensureDefaultSpecialRows() {
  if (!scenes.length) return 0;
  let added = 0;
  if (!scenes.some((scene) => scene.section === "title")) {
    scenes.push(makeSpecialScene("title"));
    added++;
  }
  if (!scenes.some((scene) => scene.section === "ending")) {
    scenes.push(makeSpecialScene("ending"));
    added++;
  }
  if (added) {
    sortScenes();
  }
  return added;
}

function applySpecialTiming(scene, kind) {
  const next = makeSpecialScene(kind);
  scene.start = next.start;
  scene.end = next.end;
  scene.section = kind;
  if (!String(scene.text || "").trim()) scene.text = next.text;
  if (!String(scene.image_prompt || "").trim()) scene.image_prompt = next.image_prompt;
  scene.image_path = scene.image_path || "";
  scene.video_path = scene.video_path || "";
  return scene;
}

function shiftScenesAfterTitle(delta) {
  if (!delta) return;
  scenes.forEach((scene) => {
    if (scene.section === "title") return;
    scene.start = round2(Math.max(0, Number(scene.start) + delta));
    scene.end = round2(Math.max(scene.start + 0.1, Number(scene.end) + delta));
    if (Array.isArray(scene.words)) {
      scene.words = scene.words.map((word) => ({
        ...word,
        start: Number.isFinite(Number(word.start)) ? round2(Number(word.start) + delta) : word.start,
        end: Number.isFinite(Number(word.end)) ? round2(Number(word.end) + delta) : word.end,
      }));
    }
  });
}

function applyTitleBeforeSong(duration = titleLeadSeconds()) {
  const nextLead = round2(Math.max(0, duration));
  const prevLead = timelineAudioOffset();
  const delta = round2(nextLead - prevLead);
  shiftScenesAfterTitle(delta);
  audioLeadSec = nextLead;

  let scene = scenes.find((s) => s.section === "title");
  if (!scene) {
    scene = makeSpecialScene("title");
    scenes.push(scene);
  }
  scene.start = 0;
  scene.end = round2(Math.max(0.1, nextLead));
  scene.section = "title";
  if (!String(scene.text || "").trim()) scene.text = defaultTitleText();
  if (!String(scene.image_prompt || "").trim()) {
    scene.image_prompt = `${scene.text}, opening title scene, cinematic music video`;
  }

  const ending = scenes.find((s) => s.section === "ending");
  if (ending) applyEndingAfterSong(endingTailSeconds(), ending);
  sortScenes();
  return scene;
}

function applyEndingAfterSong(duration = endingTailSeconds(), existing = null) {
  const regularEnd = lastRegularEnd();
  const audioEnd = videoAudioEndTime();
  const start = round2(regularEnd);
  const end = round2(Math.max(audioEnd, regularEnd) + Math.max(0, duration));
  let scene = existing || scenes.find((s) => s.section === "ending");
  if (!scene) {
    scene = makeSpecialScene("ending");
    scenes.push(scene);
  }
  scene.start = start;
  scene.end = Math.max(start + 0.1, end);
  scene.text = String(scene.text || "").trim() || "엔딩";
  scene.section = "ending";
  if (!String(scene.image_prompt || "").trim()) {
    scene.image_prompt = "ending scene, final outro, cinematic music video";
  }
  sortScenes();
  return scene;
}

function refreshSceneEditors(seekIndex = -1) {
  syncSectionTimes();
  renderRows();
  renderSectionCards();
  renderChapters();
  renderOutputTimeline();
  updatePreview();
  updateActionState();
  if (seekIndex >= 0 && scenes[seekIndex]) seekToTime(scenes[seekIndex].start);
}

function insertSpecialRow(kind) {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  const scene = kind === "title"
    ? applyTitleBeforeSong(titleLeadSeconds())
    : applyEndingAfterSong(endingTailSeconds());
  sortScenes();
  const index = scenes.findIndex((s) => s.id === scene.id);
  outputEditIndex = index >= 0 ? index : outputEditIndex;
  refreshSceneEditors(index);
  status(
    kind === "title"
      ? `타이틀 줄을 0:00.0~${fmt(scene.end)}로 맞췄습니다.`
      : `엔딩 줄을 ${fmt(scene.start)}부터 시작하도록 맞췄습니다.`,
    "ok"
  );
}

function lyricLabel(lines, index = 0) {
  const text = (lines || [])
    .map((line) => String(line || "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!text) return "";
  return text.length > 36 ? text.slice(0, 36) + "..." : text;
}

function defaultImagePrompt(scene) {
  const style = $("imgStyle") ? $("imgStyle").value.trim() : "";
  const lyric = String((scene && scene.text) || "").replace(/\s+/g, " ").trim();
  return [style, lyric].filter(Boolean).join(", ") || "background";
}

function sectionFromScene(scene, index, previous) {
  const lines = [scene.text].filter((v) => String(v || "").trim());
  return {
    ...(previous || {}),
    index,
    label: lyricLabel(lines, index) || `구간 ${index + 1}`,
    section_label: String(scene.section || "").trim(),
    start: round2(scene.start),
    end: round2(scene.end),
    scene_ids: [scene.id],
    lines,
    image_prompt: (previous && previous.image_prompt) || defaultImagePrompt(scene),
    image_path: (previous && previous.image_path) || "",
    image_id: (previous && previous.image_id) || "",
    image_url: (previous && previous.image_url) || "",
    candidates: previous && previous.candidates ? [...previous.candidates] : [],
    subtitle: previous ? previous.subtitle !== false : true,
  };
}

// 배경 슬롯(section)의 start/end는 소속 장면에서 파생된 값이라, 장면 시간을 고치면
// 같이 갱신해 줘야 미리보기·렌더의 배경 타이밍이 어긋나지 않는다.
// 스탭3가 이미 만들어진 상태에서는 스탭2의 가사 행과 1:1 개수도 유지한다.
function syncSectionTimes() {
  if (!sectionsState.length) return false;
  const previousByScene = new Map();
  sectionsState.forEach((sec) => {
    (sec.scene_ids || []).forEach((id) => {
      if (!previousByScene.has(id)) previousByScene.set(id, sec);
    });
  });

  const next = [];
  scenes.forEach((scene) => {
    // 가사 모드는 빈 줄을 건너뛴다. 분위기 모드는 장면 텍스트가 원래 비어 있으므로
    // 건너뛰면 배경 슬롯이 통째로 사라진다 → 모드일 때는 모든 장면을 유지한다.
    if (!isAmbient() && !String(scene.text || "").trim()) return;
    next.push(sectionFromScene(scene, next.length, previousByScene.get(scene.id)));
  });
  const changed = next.length !== sectionsState.length
    || next.some((sec, i) => sec.scene_ids[0] !== (sectionsState[i] && (sectionsState[i].scene_ids || [])[0]));
  sectionsState = next;
  return changed;
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
    scene.text = twoLineText(target.value);
    target.value = scene.text;
  }

  row.classList.toggle("invalid", scene.end <= scene.start);
  if (scene.end <= scene.start) {
    status("끝 시간은 시작 시간보다 커야 합니다.", "err");
  }
  syncSectionTimes();
  if (sectionsState.length) {
    renderSectionCards();
    renderChapters();
  }
  updateActionState();
  updatePreview();
}

function updateCurrentLine() {
  const t = currentTimelineTime();
  $("playhead").textContent = fmt(t);
  document.querySelectorAll(".line").forEach((row) => {
    const sc = scenes[Number(row.dataset.i)];
    row.classList.toggle("current", Boolean(sc && t >= sc.start && t < sc.end));
  });
  document.querySelectorAll(".section-card").forEach((card) => {
    const sec = sectionsState[Number(card.dataset.i)];
    card.classList.toggle("current", Boolean(sec && t >= sec.start && t < sec.end));
  });
  updateStageTimelineCurrent();
  updateOutputTimelineCurrent();
}

function seekToTime(t) {
  const next = audioTimeFromTimeline(t);
  stopAt = null;
  try {
    audio.currentTime = next;
  } catch (e) {
    // 오디오가 아직 완전히 준비되지 않아도 미리보기 갱신은 계속 시도한다.
  }
  updateCurrentLine();
  updatePreview();
}

function setAudioPreview(file) {
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  localAudioUrl = file ? URL.createObjectURL(file) : null;
  if (localAudioUrl && !audioId) audio.src = localAudioUrl;
}

$("audioFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  audioId = null;
  audioLeadSec = 0;
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
  if (e.target.matches("input, textarea")) updateRowFromInput(e.target);
});

$("lines").addEventListener("input", (e) => {
  if (!e.target.classList.contains("lyric")) return;
  const row = e.target.closest(".line");
  const scene = row && scenes[Number(row.dataset.i)];
  if (!scene) return;
  const next = twoLineText(e.target.value);
  if (next !== e.target.value) e.target.value = next;
  scene.text = next;
  updatePreview();
});

$("lines").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  const row = (button || e.target).closest(".line");
  if (!row) return;
  const i = Number(row.dataset.i);
  const scene = scenes[i];
  if (!scene) return;

  if (!button) {
    seekToTime(scene.start);
    return;
  }

  if (button.dataset.act === "setstart") {
    scene.start = currentTimelineTime();
    row.querySelector(".start").value = fmt(scene.start);
  } else if (button.dataset.act === "setend") {
    scene.end = currentTimelineTime();
    row.querySelector(".end").value = fmt(scene.end);
  } else if (button.dataset.act === "play") {
    if (!audio.paused) { // 재생 중이면 정지(토글)
      audio.pause();
      stopAt = null;
    } else {
      seekToTime(scene.start);
      stopAt = scene.end;
      audio.play().catch((err) =>
        status("이 줄을 재생할 수 없습니다(오디오 미로드일 수 있음): " + err.message, "err"));
    }
  } else if (button.dataset.act === "del") {
    const wasLeadTitle = scene.section === "title" && timelineAudioOffset() > 0;
    scenes.splice(i, 1);
    if (wasLeadTitle) {
      shiftScenesAfterTitle(-timelineAudioOffset());
      audioLeadSec = 0;
      const ending = scenes.find((s) => s.section === "ending");
      if (ending) applyEndingAfterSong(endingTailSeconds(), ending);
    }
    syncSectionTimes();
    renderRows();
    renderSectionCards();
    renderChapters();
    updatePreview();
    return;
  }

  row.classList.toggle("invalid", scene.end <= scene.start);
  syncSectionTimes();
  if (sectionsState.length) {
    renderSectionCards();
    renderChapters();
  }
  updateActionState();
  updatePreview();
});

$("addRow").addEventListener("click", () => {
  const t = currentTimelineTime();
  // scenes.length는 줄을 지운 뒤 기존 id와 충돌할 수 있다 → 최대 id + 1로 발급.
  const nextId = nextSceneId();
  scenes.push({
    id: nextId,
    start: t,
    end: round2(t + 2),
    text: "",
    image_prompt: "",
    image_path: "",
    video_path: "",
  });
  sortScenes();
  refreshSceneEditors(scenes.findIndex((s) => s.id === nextId));
});
$("autoTwoLineBtn").addEventListener("click", autoTwoLineAll);
$("autoOneLineBtn").addEventListener("click", autoOneLineAll);
$("addTitleRow").addEventListener("click", () => insertSpecialRow("title"));
$("addEndingRow").addEventListener("click", () => insertSpecialRow("ending"));

audio.addEventListener("loadedmetadata", () => {
  $("audioMeta").textContent = Number.isFinite(audio.duration)
    ? `길이 ${fmt(audio.duration)}`
    : "재생 준비 완료";
});

audio.addEventListener("timeupdate", () => {
  const t = currentTimelineTime();
  if (stopAt !== null && t >= stopAt) {
    audio.pause();
    stopAt = null;
  }
  updateCurrentLine();
  updatePreview();
});
audio.addEventListener("seeked", () => {
  updateCurrentLine();
  updatePreview();
});
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
    scheduleAutosave();
    status("배경 업로드 완료. 사이트를 나갔다 와도 현재 작업에 유지됩니다.", "ok");
  } catch (err) {
    status("배경 업로드 실패: " + err.message, "err");
  }
});

// 공통 배경은 '가사별 배경이 하나도 없을 때만' 적용됨 — 상태에 맞게 안내(조용한 무시 방지)
let bgName = "";
function updateBgNote() {
  const el = $("bgName");
  if (!el) return;
  const hasSecImg = sectionsState.some((s) => s.image_id);
  if (bgId) {
    el.textContent = hasSecImg
      ? `⚠ ${bgName || "공통 배경"} — 가사별 배경이 있어 이 공통 배경은 사용되지 않습니다.`
      : `${bgName || "업로드된 배경"} 적용됨.`;
  } else {
    el.textContent = hasSecImg
      ? "가사별 배경을 사용합니다. (공통 배경은 가사별 이미지가 하나도 없을 때만 적용)"
      : "선택하지 않으면 가사별 이미지 또는 배경색을 씁니다.";
  }
}

$("srtBtn").addEventListener("click", async () => {
  if (!scenes.length) return status("먼저 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");
  saveAutosaveNow();

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
let isRendering = false;

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
  isRendering = false;
  updateActionState();
}

function renderResults(videos, mode = "final") {
  const box = $("result");
  box.innerHTML = "";
  if (!videos.length) {
    box.classList.add("hidden");
    return;
  }
  videos.forEach((v) => {
    const item = document.createElement("div");
    item.className = "result-item";
    const isPreview = mode === "preview" || v.preview;
    if (v.aspect) {
      const tag = document.createElement("div");
      tag.className = "muted";
      tag.textContent = `${isPreview ? "완성 미리보기" : "최종 MP4"} · ${v.aspect}`;
      item.appendChild(tag);
    }
    const vid = document.createElement("video");
    vid.controls = true;
    vid.src = v.video_url;
    if (isPreview) {
      const note = document.createElement("div");
      note.className = "muted";
      note.textContent = "미리보기 확인 후 수정하거나 최종 MP4 만들기를 진행하세요.";
      item.append(vid, note);
    } else {
      const a = document.createElement("a");
      a.className = "download-link";
      a.href = v.video_url;
      a.download = "music_video" + (v.aspect ? "_" + v.aspect.replace(":", "x") : "") + ".mp4";
      a.textContent = "영상 다운로드";
      item.append(vid, a);
    }
    box.appendChild(item);
  });
  box.classList.remove("hidden");
}

function listenRenderJob(jid, mode = "final") {
  if (renderES) renderES.close();
  renderES = new EventSource(withBase(`/api/jobs/${jid}/events`)); // EventSource는 fetch 오버라이드 밖이라 명시 보정
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
      renderResults(vids, mode);
      hideRenderProgress();
      endRender();
      status(
        mode === "preview"
          ? "완성 미리보기 생성 완료. 아래에서 먼저 확인하세요."
          : `영상 생성 완료 (${vids.length}개). 아래에서 확인하세요.`,
        "ok"
      );
    } else if (j.status === "error") {
      hideRenderProgress();
      endRender();
      status("영상 생성 실패: " + (j.error || ""), "err");
    } else if (j.status === "cancelled") {
      hideRenderProgress();
      endRender();
      status("렌더를 취소했습니다.", "ok");
    } else {
      busy(`${mode === "preview" ? "완성 미리보기 생성 중" : "영상 합성 중"}… ${Math.round((j.progress || 0) * 100)}%`);
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
          renderResults(vids, mode);
          status(mode === "preview" ? "완성 미리보기 생성 완료." : `영상 생성 완료 (${vids.length}개).`, "ok");
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

function buildRenderPayload(preview = false) {
  // 자막 off 구간의 줄은 자막에서 제외
  const offIds = new Set();
  sectionsState.forEach((s) => {
    if (s.subtitle === false) (s.scene_ids || []).forEach((id) => offIds.add(id));
  });
  const subScenes = scenes.filter((s) => !offIds.has(s.id));
  const primary = getAspect();
  const aspects = preview
    ? [primary]
    : ($("alsoShorts").checked ? [...new Set([primary, "9:16"])] : [primary]);

  return {
    audio_id: audioId,
    scenes: subScenes,
    aspect: primary,
    aspects,
    preview,
    bg_id: bgId,
    bg_color: $("bgColor").value,
    font_size: Number($("fontSize").value) || 48,
    subtitle_style: $("subtitleStyle").value,
    subtitle_pos: $("subtitlePos").value,
    subtitle_align: $("subtitleAlign").value,
    subtitle_offset_x: subtitleOffsets().x,
    subtitle_offset_y: subtitleOffsets().y,
    karaoke_enabled: karaokeEnabled(),
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
    outro_title: $("outroTitle").checked ? $("songTitle").value.trim() : "",
    outro_title_dur: Number($("outroTitleDur").value) || 3.0,
    audio_delay_sec: timelineAudioOffset(),
    sections: sectionBackgroundTimeline(),
  };
}

async function startRender(preview = false) {
  if (!audioId || !scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  if (hasTimingIssues()) return status("시작/끝 시간이 맞지 않는 줄을 먼저 고치세요.", "err");
  saveAutosaveNow();

  isRendering = true;
  updateActionState();
  showRenderProgress(0);
  busy(preview ? "완성 미리보기 렌더 준비 중…" : "최종 MP4 합성 준비 중…");

  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRenderPayload(preview)),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    renderJobId = data.job_id;
    listenRenderJob(renderJobId, preview ? "preview" : "final");
  } catch (e) {
    status((preview ? "미리보기 생성 실패: " : "영상 생성 실패: ") + e.message, "err");
    hideRenderProgress();
    endRender();
  }
}

$("previewRenderBtn").addEventListener("click", () => startRender(true));
$("renderBtn").addEventListener("click", () => startRender(false));

$("alignBtn").addEventListener("click", doAlign);
$("ambientBtn").addEventListener("click", doAmbient);
$("ambientToBgBtn").addEventListener("click", () => goStep(3));

$("modeLanding").addEventListener("click", (e) => {
  const card = e.target.closest(".mode-card");
  if (card) chooseMode(card.dataset.mode);
});
$("changeModeBtn").addEventListener("click", () => showModeLanding(hasRestorableSession()));
$("continueWorkBtn").addEventListener("click", () => {
  if (restoreSession()) $("modeLanding").classList.add("hidden");
});

$("purposeChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  ambientPurpose = chip.dataset.purpose || "meditation";
  $("purposeChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  if (ambientPurpose === "custom") $("ambientMood").focus();
  scheduleAutosave();
});

$("sceneCount").addEventListener("input", () => {
  $("sceneCountVal").textContent = $("sceneCount").value;
  scheduleAutosave();
});

// ---- 스토리 모드 위젯 ----
$("storyBtn").addEventListener("click", doStory);
$("storyGenBtn").addEventListener("click", doStoryGenerate);
$("storyText").addEventListener("input", () => {
  updateStoryStats();
  updateActionState();
  scheduleAutosave();
});
$("storyVoice").addEventListener("change", scheduleAutosave);
$("genreChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  storyGenre = chip.dataset.genre || "yadam";
  $("genreChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  scheduleAutosave();
});

// ---- 아바타 모드 위젯 ----
$("avatarBtn").addEventListener("click", doAvatar);
$("avatarGenImgBtn").addEventListener("click", doAvatarGenImage);
$("avatarGenScriptBtn").addEventListener("click", doAvatarGenScript);
$("avatarScript").addEventListener("input", () => {
  updateAvatarStats();
  updateActionState();
  scheduleAutosave();
});
$("avatarVoice").addEventListener("change", scheduleAutosave);
$("avatarFile").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  avatarUploadFile = f;
  avatarImageId = "";
  setAvatarPreview(URL.createObjectURL(f));
  updateActionState();
});
$("toneChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  avatarTone = chip.dataset.tone || "trust";
  $("toneChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  scheduleAutosave();
});
$("jobCancelBtn").addEventListener("click", async () => {
  if (!currentJobId) return;
  $("jobCancelBtn").disabled = true;
  try {
    await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
    busy("취소하는 중…");
  } catch (e) {
    /* 폴러가 상태로 감지 */
  } finally {
    $("jobCancelBtn").disabled = false;
  }
});

window.addEventListener("beforeunload", (e) => {
  saveAutosaveNow();
  if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
  // 렌더 진행 중이거나 정렬 중이면 새로고침/닫기 전에 경고(작업·결과 유실 방지).
  if (renderJobId || isAligning) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---- 2차: 가사별 배경 이미지 (선택한 프록시로 1장 생성) ----
const CANDIDATE_COUNT = 1;

function isVideoUrl(u) {
  return /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(u || "");
}

function inheritedMediaForIndex(index) {
  for (let i = Math.min(index, sectionsState.length - 1); i >= 0; i--) {
    const s = sectionsState[i];
    if (s && s.image_url) return { section: s, inherited: i !== index };
  }
  return { section: null, inherited: false };
}

function sectionBackgroundTimeline() {
  const timeline = [];
  let currentId = "";
  sectionsState.forEach((s) => {
    if (s.image_id) currentId = s.image_id;
    if (!currentId) return;
    const last = timeline[timeline.length - 1];
    if (last && last.image_id === currentId) {
      last.end = s.end;
    } else {
      timeline.push({ start: s.start, end: s.end, image_id: currentId });
    }
  });
  return timeline;
}

function timelineScale() {
  const total = Math.max(1, scenes.reduce((m, s) => Math.max(m, Number(s.end) || 0), Number(audio.duration) || 0));
  return total > 420 ? 14 : total > 240 ? 18 : 28;
}

function sectionIndexForSceneIndex(sceneIndex) {
  const scene = scenes[sceneIndex];
  if (!scene) return -1;
  return sectionsState.findIndex((s) => (s.scene_ids || []).includes(scene.id));
}

function ensureTimelineSections() {
  if (!scenes.length) return false;
  if (!sectionsState.length) {
    sectionsState = scenes
      .filter((scene) => isAmbient() || String(scene.text || "").trim())
      .map((scene, index) => sectionFromScene(scene, index));
    return true;
  }
  return syncSectionTimes();
}

function timelineSectionForSceneIndex(sceneIndex, create = false) {
  if (create) ensureTimelineSections();
  const idx = sectionIndexForSceneIndex(sceneIndex);
  return idx >= 0 ? sectionsState[idx] : null;
}

function timelineLabel(scene, index) {
  const txt = String((scene && scene.text) || "").replace(/\s+/g, " ").trim();
  if (txt) return `${index + 1}. ${txt.slice(0, 38)}`;
  return isAmbient() ? `장면 ${index + 1}` : `${index + 1}. 빈 가사`;
}

function clampOutputIndex(index) {
  if (!scenes.length) return 0;
  return Math.max(0, Math.min(scenes.length - 1, Number(index) || 0));
}

function selectedOutputScene() {
  outputEditIndex = clampOutputIndex(outputEditIndex);
  return scenes[outputEditIndex] || null;
}

function renderOutputTimeline() {
  const editor = $("timelineEditor");
  if (!editor) return;
  const select = $("timelineSelect");
  const track = $("timelineTrack");
  const info = $("timelineInfo");
  if (!select || !track) return;

  outputEditIndex = clampOutputIndex(outputEditIndex);
  select.innerHTML = "";
  track.innerHTML = "";

  if (!scenes.length) {
    select.disabled = true;
    ["timelinePrev", "timelinePlay", "timelineNext", "timelineStart", "timelineEnd",
     "timelineText", "timelinePrompt", "timelineSubtitle", "timelineSetStart",
     "timelineSetEnd", "timelineUpload", "timelineGenerate", "timelineChat", "timelineClearBg"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = true;
    });
    if (info) info.textContent = "0줄";
    if ($("timelineBgNote")) $("timelineBgNote").textContent = "";
    renderStageTimeline();
    return;
  }

  select.disabled = false;
  ["timelinePrev", "timelinePlay", "timelineNext", "timelineStart", "timelineEnd",
   "timelineText", "timelinePrompt", "timelineSubtitle", "timelineSetStart",
   "timelineSetEnd", "timelineUpload", "timelineGenerate", "timelineChat", "timelineClearBg"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = false;
  });

  const scale = timelineScale();
  scenes.forEach((scene, index) => {
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = timelineLabel(scene, index);
    select.appendChild(opt);

    const secIdx = sectionIndexForSceneIndex(index);
    const sec = secIdx >= 0 ? sectionsState[secIdx] : null;
    const media = secIdx >= 0 ? inheritedMediaForIndex(secIdx) : { section: null, inherited: false };
    const clip = document.createElement("button");
    clip.type = "button";
    clip.className = "timeline-clip";
    clip.dataset.i = index;
    clip.style.setProperty("--clip-w", Math.max(52, Math.round(Math.max(0.2, scene.end - scene.start) * scale)) + "px");
    clip.classList.toggle("selected", index === outputEditIndex);
    clip.classList.toggle("subtitle-off", !!(sec && sec.subtitle === false));
    clip.classList.toggle("inherited", !!media.inherited);
    clip.classList.toggle("no-bg", !(media.section && media.section.image_url));
    clip.innerHTML = `<b>${escapeHtml(String(scene.text || "").replace(/\s+/g, " ") || "빈 가사")}</b><small>${fmt(scene.start)}-${fmt(scene.end)}</small>`;
    track.appendChild(clip);
  });

  const playhead = document.createElement("div");
  playhead.id = "timelinePlayhead";
  playhead.className = "timeline-playhead";
  track.appendChild(playhead);
  select.value = String(outputEditIndex);
  if (info) info.textContent = `${outputEditIndex + 1}/${scenes.length} · ${fmt((selectedOutputScene() || {}).start || 0)}`;
  fillOutputTimelineEditor();
  updateOutputTimelineCurrent();
  renderStageTimeline();
}

function fillOutputTimelineEditor() {
  const scene = selectedOutputScene();
  if (!scene || !$("timelineStart")) return;
  const sec = timelineSectionForSceneIndex(outputEditIndex, false);
  const secIdx = sectionIndexForSceneIndex(outputEditIndex);
  const media = secIdx >= 0 ? inheritedMediaForIndex(secIdx) : { section: null, inherited: false };
  $("timelineStart").value = fmt(scene.start);
  $("timelineEnd").value = fmt(scene.end);
  $("timelineText").value = scene.text || "";
  $("timelineSubtitle").checked = !(sec && sec.subtitle === false);
  $("timelinePrompt").value = sec ? (sec.image_prompt || "") : defaultImagePrompt(scene);
  const note = $("timelineBgNote");
  if (note) {
    if (sec && sec.image_id) note.textContent = "이 구간 배경이 지정되어 있습니다.";
    else if (media.section && media.inherited) note.textContent = "배경 없음: 직전 이미지를 계속 사용합니다.";
    else note.textContent = "배경 없음: 공통 배경 또는 배경색을 사용합니다.";
  }
}

function updateOutputTimelineCurrent() {
  const track = $("timelineTrack");
  if (!track || !scenes.length) return;
  const t = currentTimelineTime();
  let left = 0;
  const scale = timelineScale();
  document.querySelectorAll(".timeline-clip").forEach((clip) => {
    const sc = scenes[Number(clip.dataset.i)];
    clip.classList.toggle("current", Boolean(sc && t >= sc.start && t < sc.end));
  });
  for (const scene of scenes) {
    if (t <= scene.start) break;
    const dur = Math.max(0.2, Math.min(t, scene.end) - scene.start);
    left += Math.max(52, Math.round(Math.max(0.2, scene.end - scene.start) * scale))
      * Math.max(0, Math.min(1, dur / Math.max(0.2, scene.end - scene.start)));
    if (t < scene.end) break;
  }
  const ph = $("timelinePlayhead");
  if (ph) ph.style.left = Math.round(left + 10) + "px";
}

function renderStageTimeline() {
  const wrap = $("stageTimeline");
  const track = $("stageTimelineTrack");
  const info = $("stageTimelineInfo");
  if (!wrap || !track) return;

  const visible = currentStep >= 2 && scenes.length > 0 && !isManualMode();
  wrap.classList.toggle("hidden", !visible);
  track.innerHTML = "";
  if (info) info.textContent = scenes.length ? `${scenes.length}줄` : "0줄";
  if (!visible) return;

  scenes.forEach((scene, index) => {
    const secIdx = sectionIndexForSceneIndex(index);
    const media = secIdx >= 0 ? inheritedMediaForIndex(secIdx) : { section: null, inherited: false };
    const clip = document.createElement("button");
    clip.type = "button";
    clip.className = "stage-timeline-clip";
    clip.dataset.i = String(index);
    if (media.section && media.section.image_url && !isVideoUrl(media.section.image_url)) {
      clip.style.backgroundImage = `url("${media.section.image_url}")`;
    }
    clip.classList.toggle("no-bg", !(media.section && media.section.image_url));
    clip.classList.toggle("inherited", !!media.inherited);
    const text = String(scene.text || "").replace(/\s+/g, " ").trim() || "빈 가사";
    clip.title = `${index + 1}. ${text}`;
    clip.innerHTML = `<span>${index + 1}</span><b>${escapeHtml(text)}</b><small>${fmt(scene.start)}-${fmt(scene.end)}</small>`;
    track.appendChild(clip);
  });
  updateStageTimelineCurrent();
}

function updateStageTimelineCurrent() {
  const track = $("stageTimelineTrack");
  if (!track || !scenes.length) return;
  const t = currentTimelineTime();
  let currentIndex = -1;
  document.querySelectorAll(".stage-timeline-clip").forEach((clip) => {
    const index = Number(clip.dataset.i);
    const sc = scenes[index];
    const isCurrent = Boolean(sc && t >= sc.start && t < sc.end);
    clip.classList.toggle("current", isCurrent);
    if (isCurrent) currentIndex = index;
  });
  const info = $("stageTimelineInfo");
  if (info) {
    info.textContent = currentIndex >= 0
      ? `${currentIndex + 1}/${scenes.length} · ${fmt(t)}`
      : `${scenes.length}줄`;
  }
}

function selectOutputClip(index, seek = true) {
  outputEditIndex = clampOutputIndex(index);
  const scene = selectedOutputScene();
  renderOutputTimeline();
  if (scene && seek) seekToTime(scene.start);
}

function refreshAfterOutputEdit(rerenderRows = true) {
  syncSectionTimes();
  if (rerenderRows) renderRows();
  renderSectionCards();
  renderChapters();
  renderOutputTimeline();
  updatePreview();
  updateActionState();
  scheduleAutosave();
}

function updateOutputSceneTiming(field, value) {
  const scene = selectedOutputScene();
  if (!scene) return;
  scene[field] = round2(parseTime(value));
  if (scene.end <= scene.start) {
    status("끝 시간은 시작 시간보다 커야 합니다.", "err");
  }
  refreshAfterOutputEdit();
}

function enterManualEditor(pushHash = true) {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  ensureTimelineSections();
  const t = currentTimelineTime();
  const activeIndex = scenes.findIndex((s) => t >= s.start && t < s.end);
  if (activeIndex >= 0) outputEditIndex = activeIndex;
  const page = $("manualEditorPage");
  const slot = $("manualStageSlot");
  if (!page || !slot) return;
  syncImageProvider(($("imageProvider") && $("imageProvider").value) || getImageProvider());
  syncAspect(getAspect(), false);
  page.classList.remove("hidden");
  document.body.classList.add("manual-mode");
  slot.appendChild($("stage"));
  $("stage").classList.remove("hidden");
  renderOutputTimeline();
  setPreviewAspect();
  updatePreview();
  updateCurrentLine();
  scheduleAutosave();
  if (pushHash && location.hash !== "#manual-editor") {
    history.pushState(null, "", "#manual-editor");
  }
}

function exitManualEditor(updateHash = true) {
  const page = $("manualEditorPage");
  const home = $("stageHome");
  if (!page || !home) return;
  home.after($("stage"));
  page.classList.add("hidden");
  document.body.classList.remove("manual-mode");
  $("stage").classList.toggle("hidden", currentStep < 2);
  setPreviewAspect();
  updatePreview();
  renderOutputTimeline();
  scheduleAutosave();
  if (updateHash && location.hash === "#manual-editor") {
    history.pushState(null, "", location.pathname + location.search);
  }
}

function sectionTitle(s, index = 0) {
  const title = lyricLabel((s && s.lines) || [], index) || (s && s.label) || `구간 ${index + 1}`;
  return title.length > 36 ? title.slice(0, 36) + "..." : title;
}

function renderSectionCards() {
  const box = $("sections");
  box.innerHTML = "";
  if (!sectionsState.length) {
    const empty = document.createElement("div");
    empty.className = "sections-empty";
    empty.textContent = scenes.length
      ? "‘전체 이미지 자동생성’을 누르면 가사별 배경 슬롯과 이미지를 한 번에 만듭니다. 직접 올릴 수도 있습니다."
      : "먼저 1단계에서 자동 정렬을 완료하세요.";
    box.appendChild(empty);
    renderOutputTimeline();
    renderChapters();
    recordHistorySoon();
    return;
  }
  sectionsState.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "section-card" + (s._generating ? " loading" : "");
    card.dataset.i = i;

    const thumb = document.createElement("div");
    thumb.className = "section-thumb";
    const media = inheritedMediaForIndex(i);
    const mediaSec = media.section;
    if (media.inherited) thumb.classList.add("inherited");
    if (mediaSec && mediaSec.image_url) {
      if (isVideoUrl(mediaSec.image_url)) {
        thumb.classList.add("is-video");
        const vb = document.createElement("span");
        vb.className = "video-badge";
        vb.textContent = media.inherited ? "영상 · 이전" : "영상";
        thumb.appendChild(vb);
      } else {
        thumb.style.backgroundImage = `url('${mediaSec.image_url}?t=${Date.now()}')`;
      }
      if (media.inherited) {
        const ib = document.createElement("span");
        ib.className = "inherit-badge";
        ib.textContent = "이전";
        thumb.appendChild(ib);
      }
    }

    const head = document.createElement("div");
    head.className = "section-head";
    const label = document.createElement("b");
    label.textContent = sectionTitle(s, i);
    label.title = ((s.lines || []).filter(Boolean).join("\n") || s.label || "");
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
    gen.textContent = imageProviderButtonLabel();
    const chat = document.createElement("button");
    chat.type = "button";
    chat.className = "mini-btn image-chat";
    chat.textContent = "이미지 채팅";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "mini-btn upload";
    up.textContent = "업로드";
    up.title = "내 이미지/영상을 이 가사 배경으로";
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
    rowEl.append(input, gen, chat, up, setRef, file);

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
  updateCurrentLine();
  updatePreview();
  updateBgNote();
  renderOutputTimeline();
  recordHistorySoon();
}

async function groupSections() {
  if (!scenes.length) return status("먼저 자동 정렬을 완료하세요.", "err");
  const btn = $("genImagesBtn");
  btn.disabled = true;
  busy("가사별 배경 슬롯을 만드는 중입니다.");
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
    status(`${sectionsState.length}개 가사 줄에 배경 슬롯을 만들었습니다. 가사로 프롬프트를 자동 작성합니다…`, "ok");
    // 가사별 구조는 즉시 보여준다. 프롬프트 자동작성은 블로킹하지 않고 백그라운드로 진행
    // (실패해도 기본 프롬프트 유지). 그래서 '가사별 나누기' 버튼이 어댑터 왕복에 묶이지 않는다.
    autoWritePrompts(true);
  } catch (e) {
    status("가사별 나누기 실패: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function genCandidates(card, s, genBtn) {
  s._generating = true;
  renderSectionCards(); // 카드에 'AI 생성 중…' 오버레이 표시
  const idx = card && card.dataset.i != null ? Number(card.dataset.i) : Math.max(0, sectionsState.indexOf(s));
  const title = sectionTitle(s, idx);
  busy(`${imageProviderLabel()}로 ${title} 배경을 생성 중입니다.`);
  try {
    const res = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: s.image_prompt,
        aspect: getAspect(),
        count: CANDIDATE_COUNT,
        label: title,
        ref_image_id: useRef && anchor ? anchor.image_id : "",
        provider: getImageProvider(),
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
    status(`${title} 배경 생성 완료${refNote}.`, "ok");
  } catch (err) {
    status("이미지 생성 실패: " + err.message, "err");
  } finally {
    s._generating = false;
    renderSectionCards();
    renderAnchor();
  }
}

let imageChatSection = null;
let imageChatCandidate = null;

function imageChatSectionIndex() {
  return imageChatSection ? Math.max(0, sectionsState.indexOf(imageChatSection)) : 0;
}

function addImageChatMessage(role, text) {
  const box = $("imageChatMessages");
  if (!box) return;
  const msg = document.createElement("div");
  msg.className = `image-chat-msg ${role}`;
  msg.textContent = text;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
}

function imageChatPromptWithInstruction(prompt, instruction) {
  const base = String(prompt || "").trim();
  const next = String(instruction || "").replace(/\s+/g, " ").trim();
  if (!next) return base;
  if (!base) return next;
  return `${base}, ${next}`;
}

function setImageChatPreview(candidate) {
  const box = $("imageChatPreview");
  if (!box) return;
  imageChatCandidate = candidate || null;
  box.classList.toggle("has-image", !!candidate);
  box.style.backgroundImage = candidate && candidate.image_url ? `url('${candidate.image_url}')` : "";
  if ($("imageChatApply")) $("imageChatApply").disabled = !candidate;
}

function openImageChat(s, index = -1) {
  if (!s) return status("이미지를 만들 구간을 선택하세요.", "err");
  imageChatSection = s;
  imageChatCandidate = null;
  const i = index >= 0 ? index : imageChatSectionIndex();
  const title = sectionTitle(s, i);
  $("imageChatTitle").textContent = title;
  $("imageChatMeta").textContent = `${fmt(s.start)}-${fmt(s.end)} · ${imageProviderLabel()}`;
  $("imageChatProvider").textContent = `생성기: ${imageProviderLabel()} · 현재 프롬프트를 대화로 계속 수정할 수 있습니다.`;
  $("imageChatPrompt").value = s.image_prompt || defaultImagePrompt({ text: (s.lines || []).join(" ") });
  $("imageChatMessages").innerHTML = "";
  addImageChatMessage("assistant", "원하는 분위기, 인물 위치, 색감, 카메라 느낌을 말해주세요. 전송하면 현재 프롬프트에 반영됩니다.");
  setImageChatPreview(s.image_url ? {
    image_id: s.image_id,
    image_url: s.image_url,
    has_face: !!s.has_face,
  } : null);
  $("imageChatApply").disabled = true;
  $("imageChatModal").classList.remove("hidden");
  setTimeout(() => $("imageChatInput").focus(), 0);
}

function closeImageChat() {
  const modal = $("imageChatModal");
  if (modal) modal.classList.add("hidden");
}

async function generateImageFromChat() {
  const s = imageChatSection;
  if (!s) return status("이미지를 만들 구간을 선택하세요.", "err");
  const prompt = $("imageChatPrompt").value.trim();
  if (!prompt) return status("프롬프트를 입력하세요.", "err");
  const i = imageChatSectionIndex();
  const title = sectionTitle(s, i);
  $("imageChatGenerate").disabled = true;
  $("imageChatGenerate").textContent = "생성 중…";
  busy(`${imageProviderLabel()}로 채팅 이미지 생성 중…`);
  try {
    const refId = imageChatCandidate && imageChatCandidate.image_id
      ? imageChatCandidate.image_id
      : (s.image_id || (useRef && anchor ? anchor.image_id : ""));
    const res = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        aspect: getAspect(),
        count: 1,
        label: title,
        ref_image_id: refId,
        provider: getImageProvider(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    const candidate = (data.candidates || [])[0];
    if (!candidate) throw new Error("생성된 이미지가 없습니다.");
    setImageChatPreview(candidate);
    addImageChatMessage("assistant", "이미지를 생성했습니다. 더 바꾸고 싶으면 원하는 수정 내용을 다시 보내거나, 마음에 들면 적용을 누르세요.");
    status(`${title} 채팅 이미지 생성 완료.`, "ok");
  } catch (err) {
    status("이미지 채팅 생성 실패: " + err.message, "err");
  } finally {
    $("imageChatGenerate").disabled = false;
    $("imageChatGenerate").textContent = "이미지 생성";
  }
}

function applyImageChatCandidate() {
  const s = imageChatSection;
  const c = imageChatCandidate;
  if (!s || !c) return;
  s.image_prompt = $("imageChatPrompt").value.trim() || s.image_prompt;
  s.image_id = c.image_id;
  s.image_url = c.image_url;
  s.has_face = !!c.has_face;
  const existing = (s.candidates || []).filter((item) => item.image_id !== c.image_id);
  s.candidates = [c, ...existing].slice(0, 4);
  if (!anchor) setAnchor(s);
  closeImageChat();
  renderSectionCards();
  renderAnchor();
  renderOutputTimeline();
  updatePreview();
  updateCurrentLine();
  scheduleAutosave();
  status("채팅으로 만든 이미지를 선택 구간에 적용했습니다.", "ok");
}

function setAnchor(s) {
  if (!s || !s.image_id || !s.image_url) return;
  anchor = { image_id: s.image_id, image_url: s.image_url, has_face: !!s.has_face };
  useRef = true;
  renderAnchor();
}

function renderAnchor() {
  const bar = $("anchorBar");
  if (!bar) return;
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
    $("anchorHint").textContent = "참조 이미지를 먼저 생성하거나 업로드할 수 있습니다.";
  }
  $("useRefChk").checked = useRef;
  if ($("clearAnchorBtn")) $("clearAnchorBtn").disabled = !anchor;
}

$("useRefChk").addEventListener("change", (e) => {
  useRef = e.target.checked;
});

$("clearAnchorBtn").addEventListener("click", () => {
  anchor = null;
  renderAnchor();
  scheduleAutosave();
  status("참조를 해제했습니다.", "ok");
});

function anchorPrompt() {
  const style = $("imgStyle").value.trim();
  const lyricMood = scenes
    .slice(0, 4)
    .map((s) => String(s.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
  return [
    style || "감성적인 한국 뮤직비디오, 영화적인 조명과 차분한 색감",
    lyricMood ? `가사 분위기: ${lyricMood}` : "",
    "전체 영상에 반복 참조할 대표 키비주얼",
    "일관된 인물 또는 장소, 선명한 중심 피사체, 배경 이미지로 사용 가능",
    "텍스트, 로고, 자막 없음"
  ].filter(Boolean).join(". ");
}

async function generateAnchorImage() {
  const btn = $("genAnchorBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "생성 중…";
  }
  busy(`${imageProviderLabel()}로 참조 이미지를 생성 중입니다.`);
  try {
    const res = await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: anchorPrompt(),
        aspect: getAspect(),
        count: 1,
        label: "참조 이미지",
        ref_image_id: useRef && anchor ? anchor.image_id : "",
        provider: getImageProvider(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    const candidate = (data.candidates || [])[0];
    if (!candidate) throw new Error("생성된 참조 이미지가 없습니다.");
    setAnchor(candidate);
    scheduleAutosave();
    status("참조 이미지를 생성했습니다. 이후 이미지 생성에 이 참조가 적용됩니다.", "ok");
  } catch (err) {
    status("참조 이미지 생성 실패: " + err.message, "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "참조 생성";
    }
  }
}

async function uploadAnchorImage(file) {
  if (!file) return;
  busy("참조 이미지 업로드 중입니다.");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload-bg", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    setAnchor({
      image_id: data.bg_id,
      image_url: data.bg_url || withBase("/data/" + data.bg_id),
      has_face: !!data.has_face,
    });
    scheduleAutosave();
    status("참조 이미지를 등록했습니다. 이후 이미지 생성에 먼저 적용됩니다.", "ok");
  } catch (err) {
    status("참조 이미지 업로드 실패: " + err.message, "err");
  }
}

if ($("genAnchorBtn")) $("genAnchorBtn").addEventListener("click", generateAnchorImage);
if ($("uploadAnchorBtn")) $("uploadAnchorBtn").addEventListener("click", () => $("anchorFile").click());
if ($("anchorFile")) $("anchorFile").addEventListener("change", (e) => {
  uploadAnchorImage(e.target.files && e.target.files[0]);
  e.target.value = "";
});

$("genImagesBtn").addEventListener("click", groupSections);

let genAllAborted = false;
async function prepareSectionsForAutoImages() {
  if (!scenes.length) {
    status("먼저 자동 정렬을 완료하세요.", "err");
    return false;
  }
  const created = !sectionsState.length;
  if (created) {
    ensureTimelineSections();
  } else {
    syncSectionTimes();
  }
  if (!sectionsState.length) {
    status("이미지를 생성할 가사 줄이 없습니다.", "err");
    return false;
  }
  if (created) {
    renderSectionCards();
    renderAnchor();
    renderChapters();
    updatePreview();
  }
  return true;
}

async function genAllCandidates() {
  if (!(await prepareSectionsForAutoImages())) return;
  const btn = $("genAllBtn");
  genAllAborted = false;
  btn.textContent = "중지";
  btn.dataset.mode = "abort"; // 생성 중엔 같은 버튼이 '중지'로
  $("genImagesBtn").disabled = true;
  if ($("autoPromptBtn")) $("autoPromptBtn").disabled = true;
  if ($("beatSnapBtn")) $("beatSnapBtn").disabled = true;
  $("genAllProgress").classList.remove("hidden");
  setGenAllProgress(0);
  let ok = 0;
  try {
    busy("전체 이미지 자동생성 준비 중… 가사별 프롬프트를 확인합니다.");
    await autoWritePrompts(true);
    if (genAllAborted) {
      status("전체 이미지 자동생성을 중지했습니다.", "ok");
      return;
    }

    for (let i = 0; i < sectionsState.length; i++) {
      if (genAllAborted) break;
      const s = sectionsState[i];
      const title = sectionTitle(s, i);
      s._generating = true;
      renderSectionCards();
      busy(`전체 이미지 자동생성 중… ${i + 1}/${sectionsState.length} · ${title}`);
      try {
        const res = await fetch("/api/candidates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: s.image_prompt || defaultImagePrompt((scenes || [])[i]),
            aspect: getAspect(),
            count: CANDIDATE_COUNT,
            label: title,
            ref_image_id: useRef && anchor ? anchor.image_id : "",
            provider: getImageProvider(),
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
      status(`전체 이미지 자동생성을 중지했습니다. (${ok}/${total}개 완료)`, "ok");
    } else if (ok === 0) {
      status("이미지를 한 장도 생성하지 못했습니다. 프롬프트·네트워크를 확인하고 다시 시도하세요.", "err");
    } else if (ok < total) {
      status(`${ok}/${total}개만 생성됐습니다. 실패한 가사는 ‘이미지 생성’으로 다시 시도하세요.`, "err");
    } else {
      status("전체 가사 이미지 자동생성 완료. 마음에 안 드는 줄만 다시 생성하세요.", "ok");
    }
  } catch (e) {
    status("전체 이미지 자동생성 중 오류: " + e.message, "err");
  } finally {
    sectionsState.forEach((s) => { s._generating = false; });
    btn.textContent = "전체 이미지 자동생성";
    btn.dataset.mode = "";
    $("genImagesBtn").disabled = !scenes.length;
    if ($("autoPromptBtn")) $("autoPromptBtn").disabled = false;
    if ($("beatSnapBtn")) $("beatSnapBtn").disabled = false;
    $("genAllProgress").classList.add("hidden");
    renderSectionCards();
    renderAnchor();
    renderChapters();
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

// 가사 → 한글 이미지 프롬프트 자동작성. 실제 생성용 영어 변환은 백엔드에서 처리한다.
async function autoWritePrompts(silent) {
  if (!sectionsState.length) {
    if (!silent) status("먼저 가사별 나누기를 실행하세요.", "err");
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
        sections: target.map((s, i) => ({ label: sectionTitle(s, i), lines: s.lines || [] })),
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
    status(`${n}개 가사 한글 프롬프트를 자동 작성했습니다${extra}. 수정 후 ‘이미지 생성’으로 생성하세요.`, "ok");
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
    seekToTime(s.start);
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
    if (!s.image_id) return status("먼저 이 가사 이미지를 선택하세요.", "err");
    setAnchor(s);
    status(anchor.has_face ? "인물 참조로 지정했습니다." : "컨셉 참조로 지정했습니다.", "ok");
    return;
  }

  const genBtn = e.target.closest(".gen");
  if (genBtn) {
    genCandidates(card, s, genBtn);
    return;
  }

  const chatBtn = e.target.closest(".image-chat");
  if (chatBtn) {
    openImageChat(s, Number(card.dataset.i));
    return;
  }

  if (!e.target.closest("button,input,textarea,select,label")) {
    seekToTime(s.start);
  }
});

if ($("imageChatClose")) $("imageChatClose").addEventListener("click", closeImageChat);
if ($("imageChatModal")) {
  $("imageChatModal").addEventListener("click", (e) => {
    if (e.target === $("imageChatModal")) closeImageChat();
  });
}
if ($("imageChatForm")) {
  $("imageChatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("imageChatInput");
    const text = input.value.trim();
    if (!text) return;
    addImageChatMessage("user", text);
    $("imageChatPrompt").value = imageChatPromptWithInstruction($("imageChatPrompt").value, text);
    input.value = "";
    addImageChatMessage("assistant", "요청을 현재 프롬프트에 반영했습니다. 바로 생성하거나 추가 요청을 더 입력할 수 있습니다.");
  });
}
if ($("imageChatGenerate")) $("imageChatGenerate").addEventListener("click", generateImageFromChat);
if ($("imageChatApply")) $("imageChatApply").addEventListener("click", applyImageChatCandidate);
document.addEventListener("keydown", (e) => {
  const modal = $("imageChatModal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (e.key === "Escape") closeImageChat();
});

// ---- 출력 탭 타임라인 빠른 편집 ----
$("manualEditBtn").addEventListener("click", () => enterManualEditor(true));
$("manualSaveProjectBtn").addEventListener("click", saveProject);
$("manualExitBtn").addEventListener("click", () => {
  exitManualEditor(true);
  status("수동 수정 내용을 반영했습니다.", "ok");
});

$("timelineSelect").addEventListener("change", (e) => {
  selectOutputClip(Number(e.target.value));
});

$("timelineTrack").addEventListener("click", (e) => {
  const clip = e.target.closest(".timeline-clip");
  if (!clip) return;
  selectOutputClip(Number(clip.dataset.i));
});

if ($("stageTimelineTrack")) {
  $("stageTimelineTrack").addEventListener("click", (e) => {
    const clip = e.target.closest(".stage-timeline-clip");
    if (!clip) return;
    const scene = scenes[Number(clip.dataset.i)];
    if (scene) seekToTime(scene.start);
  });
}

$("timelinePrev").addEventListener("click", () => selectOutputClip(outputEditIndex - 1));
$("timelineNext").addEventListener("click", () => selectOutputClip(outputEditIndex + 1));
$("timelinePlay").addEventListener("click", () => {
  const scene = selectedOutputScene();
  if (!scene) return;
  if (!audio.paused) {
    audio.pause();
    stopAt = null;
    return;
  }
  seekToTime(scene.start);
  stopAt = scene.end;
  audio.play().catch((err) => status("구간 재생 실패: " + err.message, "err"));
});

$("timelineStart").addEventListener("change", (e) => updateOutputSceneTiming("start", e.target.value));
$("timelineEnd").addEventListener("change", (e) => updateOutputSceneTiming("end", e.target.value));
$("timelineText").addEventListener("input", (e) => {
  const scene = selectedOutputScene();
  if (!scene) return;
  const next = twoLineText(e.target.value);
  if (next !== e.target.value) e.target.value = next;
  scene.text = next;
  syncSectionTimes();
  updatePreview();
});
$("timelineText").addEventListener("change", () => refreshAfterOutputEdit());
$("timelinePrompt").addEventListener("input", (e) => {
  const sec = timelineSectionForSceneIndex(outputEditIndex, true);
  if (!sec) return;
  sec.image_prompt = e.target.value;
});
$("timelinePrompt").addEventListener("change", () => refreshAfterOutputEdit(false));
$("timelineSubtitle").addEventListener("change", (e) => {
  const sec = timelineSectionForSceneIndex(outputEditIndex, true);
  if (!sec) return;
  sec.subtitle = e.target.checked;
  refreshAfterOutputEdit(false);
});
$("timelineSetStart").addEventListener("click", () => {
  const scene = selectedOutputScene();
  if (!scene) return;
  scene.start = currentTimelineTime();
  refreshAfterOutputEdit();
});
$("timelineSetEnd").addEventListener("click", () => {
  const scene = selectedOutputScene();
  if (!scene) return;
  scene.end = currentTimelineTime();
  refreshAfterOutputEdit();
});
$("timelineUpload").addEventListener("click", () => $("timelineFile").click());
$("timelineFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  const sec = timelineSectionForSceneIndex(outputEditIndex, true);
  if (sec) uploadSectionImage(sec, file);
  e.target.value = "";
});
$("timelineGenerate").addEventListener("click", (e) => {
  const sec = timelineSectionForSceneIndex(outputEditIndex, true);
  if (!sec) return status("수정할 구간을 선택하세요.", "err");
  genCandidates(null, sec, e.currentTarget);
});
$("timelineChat").addEventListener("click", () => {
  const sec = timelineSectionForSceneIndex(outputEditIndex, true);
  if (!sec) return status("수정할 구간을 선택하세요.", "err");
  openImageChat(sec, sectionIndexForSceneIndex(outputEditIndex));
});
$("timelineClearBg").addEventListener("click", () => {
  const sec = timelineSectionForSceneIndex(outputEditIndex, false);
  if (!sec) return;
  sec.image_id = "";
  sec.image_url = "";
  sec.has_face = false;
  sec.candidates = [];
  refreshAfterOutputEdit(false);
  status("선택 구간 배경을 해제했습니다. 직전 이미지가 있으면 이어서 사용됩니다.", "ok");
});

window.addEventListener("hashchange", () => {
  if (location.hash === "#manual-editor") enterManualEditor(false);
  else if (isManualMode()) exitManualEditor(false);
});

// ---- 프로젝트 저장 / 불러오기 (작업 내용 기억) ----
function collectState() {
  return {
    audio_id: audioId,
    audio_url: audioId ? withBase(`/data/${audioId}`) : "",
    mode,
    ambient_purpose: ambientPurpose,
    ambient_mood: $("ambientMood") ? $("ambientMood").value : "",
    scene_count: Number($("sceneCount") ? $("sceneCount").value : 6) || 6,
    story_genre: storyGenre,
    story_voice: $("storyVoice") ? $("storyVoice").value : "warm_f",
    story_text: $("storyText") ? $("storyText").value : "",
    story_topic: $("storyTopic") ? $("storyTopic").value : "",
    story_length: $("storyLength") ? $("storyLength").value : "60",
    story_mood: $("storyMood") ? $("storyMood").value : "",
    avatar_tone: avatarTone,
    avatar_image_id: avatarImageId,
    avatar_script: $("avatarScript") ? $("avatarScript").value : "",
    avatar_topic: $("avatarTopic") ? $("avatarTopic").value : "",
    avatar_voice: $("avatarVoice") ? $("avatarVoice").value : "",
    avatar_model: $("avatarModel") ? $("avatarModel").value : "",
    avatar_longform: $("avatarLongform") ? $("avatarLongform").checked : false,
    language: $("language").value,
    lyrics: $("lyrics").value,
    step: currentStep,            // 새로고침 후 같은 단계로 복원하기 위해 현재 단계 저장
    scenes,
    audio_lead_sec: timelineAudioOffset(),
    title_lead_sec: titleLeadSeconds(),
    ending_tail_sec: endingTailSeconds(),
    sections: sectionsState,
    style: $("imgStyle").value,
    image_provider: getImageProvider(),
    gap: Number($("gapThreshold").value) || 1.6,
    aspect: getAspect(),
    font_size: Number($("fontSize").value) || 48,
    subtitle_style: $("subtitleStyle").value,
    subtitle_pos: $("subtitlePos").value,
    subtitle_align: $("subtitleAlign").value,
    subtitle_offset_x: subtitleOffsets().x,
    subtitle_offset_y: subtitleOffsets().y,
    karaoke_enabled: karaokeEnabled(),
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
    outro_title: $("outroTitle").checked,
    outro_title_dur: Number($("outroTitleDur").value) || 3,
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
  audioLeadSec = Number(st.audio_lead_sec) || 0;
  scenes = normalizeScenes(st.scenes || []);
  sectionsState = st.sections || [];
  bgId = st.bg_id || null;
  bgName = st.bg_name || (bgId ? "업로드된 배경" : "");
  anchor = st.anchor || null;
  useRef = st.use_ref !== false;
  $("lyrics").value = st.lyrics || "";
  $("language").value = st.language || "ko";
  ambientPurpose = st.ambient_purpose || "meditation";
  if ($("ambientMood")) $("ambientMood").value = st.ambient_mood || "";
  if ($("sceneCount")) {
    $("sceneCount").value = clampNumber(st.scene_count, 1, 30, 6);
    $("sceneCountVal").textContent = $("sceneCount").value;
  }
  if ($("purposeChips")) {
    $("purposeChips").querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.purpose === ambientPurpose));
  }
  storyGenre = st.story_genre || "yadam";
  if ($("storyVoice")) $("storyVoice").value = st.story_voice || "warm_f";
  if ($("storyText")) $("storyText").value = st.story_text || "";
  if ($("storyTopic")) $("storyTopic").value = st.story_topic || "";
  if ($("storyLength") && st.story_length) $("storyLength").value = st.story_length;
  if ($("storyMood")) $("storyMood").value = st.story_mood || "";
  if ($("genreChips")) {
    $("genreChips").querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.genre === storyGenre));
  }
  updateStoryStats();
  avatarTone = st.avatar_tone || "trust";
  avatarImageId = st.avatar_image_id || "";
  avatarUploadFile = null;
  if ($("avatarScript")) $("avatarScript").value = st.avatar_script || "";
  if ($("avatarTopic")) $("avatarTopic").value = st.avatar_topic || "";
  if ($("avatarModel") && st.avatar_model) $("avatarModel").value = st.avatar_model;
  if ($("avatarLongform")) $("avatarLongform").checked = !!st.avatar_longform;
  if ($("toneChips")) {
    $("toneChips").querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.tone === avatarTone));
  }
  setAvatarPreview(avatarImageId ? withBase(`/data/${avatarImageId}`) : "");
  updateAvatarStats();
  setMode(st.mode || "lyrics", false);
  if ($("titleLeadSec")) $("titleLeadSec").value = st.title_lead_sec || audioLeadSec || 3;
  if ($("endingTailSec")) $("endingTailSec").value = st.ending_tail_sec || 3;
  $("imgStyle").value = st.style || "";
  syncImageProvider(st.image_provider || "chatgpt_proxy");
  if (st.gap) $("gapThreshold").value = st.gap;
  $("fontSize").value = st.font_size || 48;
  $("subtitleStyle").value = st.subtitle_style || "ballad";
  $("subtitlePos").value = st.subtitle_pos || "bottom";
  $("subtitleAlign").value = st.subtitle_align || "center";
  $("subtitleOffsetX").value = Number(st.subtitle_offset_x) || 0;
  $("subtitleOffsetY").value = Number(st.subtitle_offset_y) || 0;
  $("karaokeToggle").checked = !!st.karaoke_enabled;
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
  $("outroTitle").checked = !!st.outro_title;
  if (st.outro_title_dur) $("outroTitleDur").value = st.outro_title_dur;
  $("alsoShorts").checked = !!st.also_shorts;
  $("songTitle").value = st.song_title || "";
  $("bgColor").value = st.bg_color || "#101114";
  $("fontSizeVal").textContent = $("fontSize").value;
  updateFxLabels();
  updateStylePreview();
  syncAspect(st.aspect || "16:9", false);
  if (st.audio_url) audio.src = st.audio_url;
  stopAt = null;
  syncSectionTimes();
  renderRows();
  renderSectionCards();
  renderAnchor();
  renderChapters();
  updateStylePreview();
  updateLyricStats();
  goStep(st.step || (scenes.length ? 2 : 1));
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
    .map((s, i) => `${fmtClock(i === 0 ? 0 : s.start)} ${sectionTitle(s, i)}`)
    .join("\n");
}

function renderChapters() {
  const box = $("ytExport");
  if (!box) return;
  const prebuilt = isPrebuiltMode();
  const ga = $("genAllBtn");
  if (ga) ga.classList.toggle("hidden", !scenes.length);
  // 분위기·스토리 모드: 가사별 나누기·프롬프트 자동작성·비트 스냅은 가사 전용이라 숨긴다.
  const gi = $("genImagesBtn");
  if (gi) gi.classList.toggle("hidden", prebuilt);
  const ap = $("autoPromptBtn");
  if (ap) ap.classList.toggle("hidden", prebuilt || !sectionsState.length);
  const bs = $("beatSnapBtn");
  if (bs) bs.classList.toggle("hidden", prebuilt || sectionsState.length < 2);
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
  if (!txt) return status("먼저 가사별 나누기를 실행하세요.", "err");
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
  saveAutosaveNow();
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
  if (!karaokeHighlightActive()) {
    el.innerHTML = `<span style="color:${c.base};text-shadow:${sh}">가사 미리보기</span>`;
    return;
  }
  el.innerHTML =
    `<span style="color:${c.hi};text-shadow:${sh}">부르는 단어</span> ` +
    `<span style="color:${c.base};text-shadow:${sh}">가사 미리보기</span>`;
}

const registeredFonts = new Set();

function ensureFontStyleEl() {
  let el = $("uploadedFontFaces");
  if (!el) {
    el = document.createElement("style");
    el.id = "uploadedFontFaces";
    document.head.appendChild(el);
  }
  return el;
}

function addUploadedFontOption(font) {
  if (!font || !font.family) return;
  const select = $("fontSelect");
  const fontId = font.font_id || font.family;
  if (font.font_url && !registeredFonts.has(fontId)) {
    ensureFontStyleEl().appendChild(document.createTextNode(
      `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(font.font_url)});font-display:swap;}\n`
    ));
    registeredFonts.add(fontId);
  }
  const exists = [...select.options].some((opt) =>
    opt.dataset.fontId === fontId || (opt.value === font.family && !font.font_id)
  );
  if (exists) return;
  const opt = document.createElement("option");
  opt.value = font.family;
  opt.textContent = font.label || `${font.family} (업로드)`;
  opt.dataset.fontId = fontId;
  select.appendChild(opt);
}

async function loadUploadedFonts() {
  try {
    const res = await fetch("/api/fonts");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    (data.fonts || []).forEach(addUploadedFontOption);
  } catch (e) {
    status("업로드 폰트 목록을 불러오지 못했습니다: " + e.message, "err");
  }
}

async function uploadSubtitleFont(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  busy("자막 폰트를 업로드 중입니다.");
  try {
    const res = await fetch("/api/upload-font", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    addUploadedFontOption(data);
    $("fontSelect").value = data.family;
    updateStylePreview();
    updatePreview();
    scheduleAutosave();
    status(`자막 폰트 추가 완료: ${data.label || data.family}`, "ok");
  } catch (e) {
    status("자막 폰트 추가 실패: " + e.message, "err");
  }
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
$("karaokeToggle").addEventListener("change", () => {
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

function saveAutosaveNow() {
  const ind = $("saveState");
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  try {
    const st = collectState();
    if ((st.scenes || []).length || (st.lyrics || "").trim()) {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ at: Date.now(), state: st }));
    }
  } catch (e) {
    /* 용량 초과 등 무시 */
  }
  if (ind) ind.classList.remove("saving");
}

document.addEventListener("input", scheduleAutosave, true);
document.addEventListener("change", scheduleAutosave, true);
document.addEventListener("click", (e) => {
  if (e.target.closest("a[download]")) saveAutosaveNow();
}, true);

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
    syncSectionTimes();
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

// 새로고침/재방문 시: 자동저장된 세션이 있으면 그 단계까지 자동으로 복원한다.
// (이전엔 "복구할까요?" 배너만 띄우고 항상 1단계로 리셋 → F5하면 처음 화면으로
//  돌아가는 원인이었다. 이제 이어서 복원하고, 원하면 "새로 시작"을 누른다.)
function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
  } catch (e) {
    saved = null;
  }
  const st = saved && saved.state;
  if (!st || (!(st.scenes || []).length && !(st.lyrics || "").trim())) return false;
  applyState(st); // 저장된 단계(st.step)까지 그대로 복원
  const bar = $("restoreBar");
  if (bar) {
    $("restoreInfo").textContent =
      `이전 작업(${new Date(saved.at).toLocaleString()})을 이어서 불러왔습니다.`;
    const fresh = $("restoreBtn");
    fresh.textContent = "새로 시작";
    fresh.onclick = () => {
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* 무시 */ }
      location.reload();
    };
    $("restoreDismiss").textContent = "닫기";
    $("restoreDismiss").onclick = () => bar.classList.add("hidden");
    bar.classList.remove("hidden");
  }
  return true;
}

// ---- 실시간 미리보기 (배경 + 자막) ----
function setPreviewAspect() {
  const a = getAspect();
  $("preview").style.aspectRatio = a === "9:16" ? "9 / 16" : a === "1:1" ? "1 / 1" : "16 / 9";
  if ($("manualAspect")) $("manualAspect").value = a;
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
  const [aw, ah] = ASPECT_SIZE[getAspect()] || ASPECT_SIZE["16:9"];
  const offsets = subtitleOffsets();
  const x = Math.round(offsets.x * (($("preview").clientWidth || 640) / aw));
  const y = Math.round(offsets.y * (($("preview").clientHeight || 360) / ah));
  if (pos === "middle") {
    ov.style.top = "50%"; ov.style.bottom = "auto";
    ov.style.transform = `translateX(${x}px) translateY(-50%) translateY(${y}px)`;
  } else if (pos === "top") {
    ov.style.top = "7%"; ov.style.bottom = "auto";
    ov.style.transform = `translate(${x}px, ${y}px)`;
  } else {
    ov.style.top = "auto"; ov.style.bottom = "7%";
    ov.style.transform = `translate(${x}px, ${y}px)`;
  }
  ov.style.textAlign = $("subtitleAlign").value === "left" ? "left" : "center";
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function subtitleHtml(s) {
  return escapeHtml(s).replace(/\n/g, "<br>");
}
function karaokeHTML(sc, t) {
  const c = currentStyleColors();
  if ((sc.text || "").includes("\n")) {
    return `<span style="color:${c.base}">${subtitleHtml(sc.text)}</span>`;
  }
  const words = sc.words && sc.words.length ? sc.words : null;
  if (!words || !karaokeHighlightActive()) {
    return `<span style="color:${c.base}">${subtitleHtml(sc.text)}</span>`;
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
  const key = sec ? sectionTitle(sec) + "@" + sec.start : null;
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
  const introDur = Number($("introTitleDur").value) || 3;
  const audioDur = Number(audio.duration);
  const outroDur = Number($("outroTitleDur").value) || 3;
  const introOn = $("introTitle").checked && title && t < introDur;
  const outroOn = $("outroTitle").checked && title && Number.isFinite(audioDur)
    && audioDur > 0 && t >= Math.max(0, audioDur - outroDur);
  // 타이틀 카드가 보이는 동안은 일반 자막을 숨긴다(최종 ASS와 동일 구간).
  const on = introOn || outroOn;
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
    const into = currentTimelineTime() - sec.start;
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
  const t = currentTimelineTime();
  let secIndex = sectionsState.findIndex((s) => t >= s.start && t < s.end);
  if (secIndex < 0 && sectionsState.length) {
    secIndex = t < sectionsState[0].start ? 0 : sectionsState.length - 1;
  }
  const sec = secIndex >= 0 ? sectionsState[secIndex] : null;
  const mediaSec = secIndex >= 0 ? inheritedMediaForIndex(secIndex).section : null;
  const isVid = !!(mediaSec && mediaSec.image_url && isVideoUrl(mediaSec.image_url));
  if (isVid && vid) {
    if (vid.dataset.src !== mediaSec.image_url) {
      vid.dataset.src = mediaSec.image_url;
      vid.src = mediaSec.image_url;
    }
    vid.classList.add("show");
    if (bg) { bg.style.backgroundImage = ""; bg.classList.remove("kb-on"); bg.style.opacity = "1"; }
    syncPreviewVideo(vid, mediaSec);
  } else {
    if (vid) { vid.classList.remove("show"); if (!vid.paused) vid.pause(); }
    if (bg) {
      if (mediaSec && mediaSec.image_url) {
        bg.style.backgroundImage = `url('${mediaSec.image_url}')`;
        bg.style.backgroundColor = "";
      } else {
        bg.style.backgroundImage = "";
        bg.style.backgroundColor = $("bgColor").value || "#10131c";
      }
      applyPreviewFx(bg, mediaSec || sec);
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
    meta.textContent = `미리보기 · ${mm}:${String(ss).padStart(2, "0")}` + (sec ? ` · ${sectionTitle(sec)}` : "");
  }
}

// ---- 구간 이미지 직접 업로드 ----
async function uploadSectionImage(s, file) {
  if (!file) return;
  const title = sectionTitle(s);
  busy(`${title} 이미지 업로드 중…`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload-bg", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    s.image_id = data.bg_id;
    s.image_url = data.bg_url || withBase("/data/" + data.bg_id);
    s.candidates = [{ image_id: s.image_id, image_url: s.image_url, has_face: false }];
    if (!anchor) setAnchor(s);
    renderSectionCards();
    renderAnchor();
    updatePreview();
    status(`${title} 배경을 올린 이미지로 바꿨습니다.`, "ok");
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
document.querySelectorAll(".rail-item[data-rail-step]").forEach((button) => {
  button.addEventListener("click", () => goStep(Number(button.dataset.railStep)));
});
if ($("railPreviewBtn")) {
  $("railPreviewBtn").addEventListener("click", () => {
    if (!scenes.length) return status("먼저 자동 정렬로 가사 싱크를 만들어주세요.", "err");
    goStep(4);
  });
}
if ($("railTimelineBtn")) {
  $("railTimelineBtn").addEventListener("click", () => {
    if (!scenes.length) return status("타임라인 편집은 싱크가 만들어진 뒤 사용할 수 있습니다.", "err");
    $("manualEditBtn").click();
  });
}
$("prevStep").addEventListener("click", () => goStep(currentStep - 1));
$("nextStep").addEventListener("click", () => {
  if (currentStep === 1 && !scenes.length) {
    return status(
      isStory() ? "먼저 ‘이야기 영상 만들기’를 눌러 장면을 만들어 주세요."
        : isAmbient() ? "먼저 ‘장면 만들기’를 눌러 장면을 만들어 주세요."
          : "먼저 ‘자동 정렬 시작’으로 가사를 맞춰주세요.",
      "err"
    );
  }
  goStep(currentStep + 1);
});

// 미리보기 즉시 반영 — 폰트·전환·줌·인트로 타이틀·제목까지 포함(input/change 둘 다 안전망)
["fontSize", "bgColor", "subtitleStyle", "subtitlePos", "subtitleAlign",
 "subtitleOffsetX", "subtitleOffsetY", "karaokeToggle", "fontSelect",
 "transition", "transitionDur", "kenBurns", "songTitle", "introTitle",
 "introTitleDur", "outroTitle", "outroTitleDur", "introFade", "outroFade"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", updatePreview);
  el.addEventListener("change", updatePreview);
});
// 폰트는 자막 스타일 미리보기(스와치)에도 반영
$("fontSelect").addEventListener("change", updateStylePreview);
$("fontUploadBtn").addEventListener("click", () => $("fontFile").click());
$("fontFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  uploadSubtitleFont(file);
  e.target.value = "";
});
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
    syncAspect(r.value);
  })
);
$("manualAspect").addEventListener("change", (e) => syncAspect(e.target.value));
function onImageProviderChange(e) {
  syncImageProvider(e.target.value);
  scheduleAutosave();
  status(`${imageProviderLabel()}를 사용합니다.`, "ok");
}
if ($("imageProvider")) $("imageProvider").addEventListener("change", onImageProviderChange);
if ($("manualImageProvider")) $("manualImageProvider").addEventListener("change", onImageProviderChange);
window.addEventListener("resize", () => {
  updateStudioChromeHeight();
  applyPreviewStyle();
});

async function init() {
  updateStudioChromeHeight();
  setupTheme();
  await loadUploadedFonts();
  setupGuides();
  setupTutorial();
  updateLyricStats();
  updateActionState();
  renderSectionCards();
  renderAnchor();
  renderChapters();
  updateStylePreview();
  refreshProjects();
  loadAvatarOptions(); // 마브 저장 보이스 목록(아바타 모드)
  // 항상 진입 화면부터: 모드를 고르거나(새로 시작), 이전 작업이 있으면 이어서.
  goStep(1);
  showModeLanding(hasRestorableSession());
  if (location.hash === "#manual-editor" && restoreSession()) {
    $("modeLanding").classList.add("hidden");
    if (scenes.length) enterManualEditor(false);
  }
}

init();
