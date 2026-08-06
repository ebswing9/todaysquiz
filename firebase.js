/* =========================================================
   firebase.js
   - index.html, admin.html이 공통으로 불러다 쓰는 파일
   - 파이어베이스 연결, 데이터 경로, 상태 계산, 점수 계산, 공통 유틸을 모아둠
   - 로직/문구를 고칠 땐 이 파일 하나만 고치면 두 페이지에 모두 반영됨
========================================================= */

/* ---------------------------------------------------------
   1) 파이어베이스 연결
   - 아래 firebaseConfig 값을 본인의 새 파이어베이스 프로젝트 설정으로 교체하세요.
   - Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱 > SDK 설정 및 구성 에서 확인 가능합니다.
--------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyAKlIm_ZDD4ICyROlSskTKP5fpSixkSeIU",
  authDomain: "todaysquiz-5167d.firebaseapp.com",
  databaseURL: "https://todaysquiz-5167d-default-rtdb.firebaseio.com",
  projectId: "todaysquiz-5167d",
  storageBucket: "todaysquiz-5167d.firebasestorage.app",
  messagingSenderId: "582156880416",
  appId: "1:582156880416:web:3f750531895cdc5f9a4a45"
};


firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* 서버 시각 보정
   - 학생 기기 시계를 그대로 믿지 않고, 파이어베이스 서버 기준 시각을 계산해서 사용합니다.
   - openAt/closeAt 등 예약 시각 비교는 항상 serverNow()를 사용하세요. */
let __serverTimeOffset = 0;
db.ref(".info/serverTimeOffset").on("value", (snap) => {
  __serverTimeOffset = snap.val() || 0;
});
function serverNow() {
  return Date.now() + __serverTimeOffset;
}

/* ---------------------------------------------------------
   2) 데이터 경로 / 상수
--------------------------------------------------------- */
const PATH = {
  CONFIG: "config",
  ADMIN: "admin",
  STREAK_BADGES: "streakBadges",
  STUDENTS: "students",
  QUIZZES: "quizzes"
};

const QUIZ_STATE = {
  BEFORE_REVEAL: "BEFORE_REVEAL",   // 아직 공개 전
  REVEALED_WAIT: "REVEALED_WAIT",   // 문제는 공개, 제출은 아직
  OPEN: "OPEN",                     // 제출 가능
  CLOSED: "CLOSED"                  // 마감 (정답 공개)
};

const QUESTION_TYPE = {
  SHORT: "short",
  CHOICE: "choice"
};

const SCORING_MODE = {
  SIMPLE: "simple",
  TIER: "tier"
};

/* ---------------------------------------------------------
   3) 오늘의 퀴즈 상태 계산 (예약 시각 + 수동 오버라이드)
   meta = { revealAt, openAt, closeAt, forcedState }
   forcedState: null | "OPEN" | "END"
--------------------------------------------------------- */
function computeQuizState(meta, now) {
  if (!meta) return QUIZ_STATE.BEFORE_REVEAL;
  now = now ?? serverNow();

  if (meta.forcedState === "END") {
    return QUIZ_STATE.CLOSED;
  }
  if (meta.forcedState === "OPEN") {
    if (meta.closeAt && now >= meta.closeAt) return QUIZ_STATE.CLOSED;
    return QUIZ_STATE.OPEN;
  }

  if (meta.revealAt && now < meta.revealAt) return QUIZ_STATE.BEFORE_REVEAL;
  if (meta.openAt && now < meta.openAt) return QUIZ_STATE.REVEALED_WAIT;
  if (meta.closeAt && now >= meta.closeAt) return QUIZ_STATE.CLOSED;
  if (!meta.openAt) return QUIZ_STATE.BEFORE_REVEAL; // openAt 미설정이면 아직 준비 안 된 것으로 처리
  return QUIZ_STATE.OPEN;
}

/* ---------------------------------------------------------
   4) 날짜 (한국시간 기준 YYYY-MM-DD)
--------------------------------------------------------- */
const __kstFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
function toKstDateStr(ms) {
  return __kstFormatter.format(new Date(ms));
}
function todayKstStr() {
  return toKstDateStr(serverNow());
}
/* 날짜 문자열에 일수를 더하고 뺌 (문자열이 YYYY-MM-DD 형식이라 사전식 정렬 = 날짜순 정렬 그대로 사용 가능) */
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------
   5) 정답 판정
--------------------------------------------------------- */
function isAnswerCorrect(answerKey, answer) {
  if (!answerKey || !answerKey.correctAnswer) return false;
  return String(answer || "").trim() === String(answerKey.correctAnswer).trim();
}

/* ---------------------------------------------------------
   6) 점수 계산
   rankIndex: 0부터 시작하는 등수 (해당 퀴즈에서 정답을 맞힌 사람들 중 순서)
--------------------------------------------------------- */
function computeSimpleScore(rankIndex, simpleConfig) {
  const first = simpleConfig?.first ?? 5;
  const step = simpleConfig?.step ?? 1;
  return Math.max(first - step * rankIndex, 0);
}

function computeTierScore(rankPosition /* 1-based */, tierConfig) {
  if (!Array.isArray(tierConfig)) return 0;
  for (const tier of tierConfig) {
    if (rankPosition >= tier.from && rankPosition <= tier.to) {
      return tier.points;
    }
  }
  return 0;
}

function computeScoreForRank(rankIndex0Based, meta) {
  if (meta.scoringMode === SCORING_MODE.TIER) {
    return computeTierScore(rankIndex0Based + 1, meta.tierConfig);
  }
  return computeSimpleScore(rankIndex0Based, meta.simpleConfig);
}

/* ---------------------------------------------------------
   7) 스트릭 뱃지 (관리자가 설정한 단계 목록에서 현재 스트릭에 맞는 뱃지 찾기)
   badges: [{days:3, icon:"⭐"}, {days:7, icon:"🔥"}, ...] (오름차순 아니어도 되게 정렬해서 계산)
--------------------------------------------------------- */
function getStreakBadge(streak, badges) {
  if (!badges || !streak) return null;
  const list = Object.values(badges)
    .filter(b => b && typeof b.days === "number")
    .sort((a, b) => a.days - b.days);
  let matched = null;
  for (const b of list) {
    if (streak >= b.days) matched = b;
  }
  return matched;
}

function getDefaultStreakBadges() {
  return [
    { days: 3, icon: "⭐" },
    { days: 7, icon: "⭐⭐" },
    { days: 14, icon: "🔥" },
    { days: 30, icon: "💎" },
    { days: 60, icon: "👑" }
  ];
}

/* ---------------------------------------------------------
   8) 초기 config / 기본값
--------------------------------------------------------- */
function getInitialConfig() {
  return {
    studentCount: 29,
    defaultQuizTimes: { ...DEFAULT_QUIZ_TIMES }
  };
}

function getInitialQuizMeta() {
  return {
    questionText: "",
    questionImageData: null,
    requireCorrectMode: false,
    type: QUESTION_TYPE.SHORT,
    choices: [],
    revealAt: null,
    openAt: null,
    closeAt: null,
    forcedState: null,
    scoringMode: SCORING_MODE.SIMPLE,
    simpleConfig: { first: 5, step: 1 },
    tierConfig: [{ from: 1, to: 5, points: 5 }, { from: 6, to: 10, points: 3 }],
    retryLimit: null,
    rankCounter: 0,
    scored: false
  };
}

/* ---------------------------------------------------------
   9) 공통 유틸
--------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.innerText = str ?? "";
  return div.innerHTML;
}

function csvField(str) {
  return `"${String(str ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(content, filename) {
  const csvContent = "\uFEFF" + content;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDateTimeLocal(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseDateTimeLocal(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return isNaN(t) ? null : t;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/* ---------------------------------------------------------
   10) 커스텀 달력(날짜 선택기)
   사용법 (HTML):
     <div class="date-picker" data-date-picker>
       <input type="hidden" />
       <button type="button" class="date-picker-trigger"></button>
       <div class="date-picker-popup hidden">
         <div class="dp-header">
           <button type="button" class="dp-prev">‹</button>
           <span class="dp-month-label"></span>
           <button type="button" class="dp-next">›</button>
         </div>
         <div class="dp-weekdays"></div>
         <div class="dp-days"></div>
       </div>
     </div>
   사용법 (JS): const picker = attachDatePicker(wrapperEl, { onChange: (dateStr) => {...} });
     picker.setValue("2026-07-26")  // 값 세팅
     wrapperEl.querySelector("input[type=hidden]") 의 value / change 이벤트로도 접근 가능
--------------------------------------------------------- */
function formatPrettyDateKr(dateStr) {
  if (!dateStr) return "날짜 선택";
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

function attachDatePicker(wrapper, options) {
  options = options || {};
  const input = wrapper.querySelector("input[type=hidden]");
  const trigger = wrapper.querySelector(".date-picker-trigger");
  const popup = wrapper.querySelector(".date-picker-popup");
  const monthLabel = wrapper.querySelector(".dp-month-label");
  const weekdaysWrap = wrapper.querySelector(".dp-weekdays");
  const daysWrap = wrapper.querySelector(".dp-days");
  const prevBtn = wrapper.querySelector(".dp-prev");
  const nextBtn = wrapper.querySelector(".dp-next");

  ["일", "월", "화", "수", "목", "금", "토"].forEach(w => {
    const span = document.createElement("span");
    span.innerText = w;
    weekdaysWrap.appendChild(span);
  });

  let viewDate = input.value ? new Date(input.value + "T00:00:00") : new Date();

  function renderCalendar() {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    monthLabel.innerText = `${y}년 ${m + 1}월`;

    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    daysWrap.innerHTML = "";

    for (let i = 0; i < firstDay; i++) {
      const blank = document.createElement("span");
      blank.className = "dp-day dp-day-blank";
      daysWrap.appendChild(blank);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dp-day";
      btn.innerText = d;
      const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (dateStr === input.value) btn.classList.add("selected");
      if (dateStr === todayKstStr()) btn.classList.add("today");
      if (options.isMarked && options.isMarked(dateStr)) btn.classList.add("dp-day-has-quiz");
      btn.addEventListener("click", () => {
        input.value = dateStr;
        trigger.innerText = formatPrettyDateKr(dateStr);
        popup.classList.add("hidden");
        input.dispatchEvent(new Event("change"));
        if (options.onChange) options.onChange(dateStr);
      });
      daysWrap.appendChild(btn);
    }
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".date-picker-popup").forEach(p => { if (p !== popup) p.classList.add("hidden"); });
    popup.classList.toggle("hidden");
    renderCalendar();
  });
  prevBtn.addEventListener("click", (e) => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() - 1); renderCalendar(); });
  nextBtn.addEventListener("click", (e) => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() + 1); renderCalendar(); });
  popup.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => popup.classList.add("hidden"));

  trigger.innerText = formatPrettyDateKr(input.value);

  return {
    setValue(dateStr) {
      input.value = dateStr || "";
      trigger.innerText = formatPrettyDateKr(dateStr);
      viewDate = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
    },
    getValue() {
      return input.value;
    },
    // 표시(예: 퀴즈 등록 여부) 데이터가 나중에 바뀌었을 때, 열려 있는 달력을 다시 그려서 반영
    refresh() {
      renderCalendar();
    }
  };
}

/* ---------------------------------------------------------
   10-a) 시/분 <select> 옵션 채우기 (공용) + 시각만 선택하는 간단한 선택기
--------------------------------------------------------- */
function populateHourMinuteOptions(hourSelect, minuteSelect) {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = String(h).padStart(2, "0");
    opt.innerText = `${String(h).padStart(2, "0")}시`;
    hourSelect.appendChild(opt);
  }
  for (let mm = 0; mm < 60; mm += 5) {
    const opt = document.createElement("option");
    opt.value = String(mm).padStart(2, "0");
    opt.innerText = `${String(mm).padStart(2, "0")}분`;
    minuteSelect.appendChild(opt);
  }
}

/* 날짜 없이 시:분만 고르는 간단한 선택기 (관리자 패널의 "기본 시각 설정"용)
   HTML: <span class="time-only-picker"><select class="tp-hour"></select>:<select class="tp-minute"></select></span> */
function attachTimeOnlyPicker(wrapper, initialValue) {
  const hourSelect = wrapper.querySelector(".tp-hour");
  const minuteSelect = wrapper.querySelector(".tp-minute");
  populateHourMinuteOptions(hourSelect, minuteSelect);
  const [h, m] = (initialValue || "08:00").split(":");
  hourSelect.value = h;
  minuteSelect.value = m;
  return {
    getValue() { return `${hourSelect.value}:${minuteSelect.value}`; },
    setValue(value) {
      const [hh, mm] = (value || "08:00").split(":");
      hourSelect.value = hh;
      minuteSelect.value = mm;
    }
  };
}

/* ---------------------------------------------------------
   10-b) 기본 시각 (새 날짜에 처음 문제를 등록할 때 미리 채워줄 값)
   관리자 패널에서 config/defaultQuizTimes 로 바꿀 수 있음. 없으면 이 기본값 사용.
--------------------------------------------------------- */
const DEFAULT_QUIZ_TIMES = {
  reveal: "08:00",
  open: "08:00",
  close: "14:00"
};

/* ---------------------------------------------------------
   10-c) 날짜 + 시간 선택기 (예약 시각 입력용, 달력과 같은 디자인)
   HTML 구조는 date-picker와 동일하되, dp-time-row / dp-confirm 버튼이 추가로 필요함:
     <div class="date-picker" data-datetime-picker>
       <input type="hidden" />                 (값 형식: "YYYY-MM-DDTHH:mm")
       <button type="button" class="date-picker-trigger"></button>
       <div class="date-picker-popup hidden">
         <div class="dp-header">...</div>
         <div class="dp-weekdays"></div>
         <div class="dp-days"></div>
         <div class="dp-time-row">
           <select class="dp-hour"></select><span class="dp-time-sep">:</span><select class="dp-minute"></select>
         </div>
         <button type="button" class="dp-confirm">확인</button>
       </div>
     </div>
--------------------------------------------------------- */
function formatPrettyDateTimeKr(value) {
  if (!value) return "시각 선택";
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  return `${m}월 ${d}일 ${timePart}`;
}

function attachDateTimePicker(wrapper, options) {
  options = options || {};
  const defaultTime = options.defaultTime || "08:00";

  const input = wrapper.querySelector("input[type=hidden]");
  const trigger = wrapper.querySelector(".date-picker-trigger");
  const popup = wrapper.querySelector(".date-picker-popup");
  const monthLabel = wrapper.querySelector(".dp-month-label");
  const weekdaysWrap = wrapper.querySelector(".dp-weekdays");
  const daysWrap = wrapper.querySelector(".dp-days");
  const prevBtn = wrapper.querySelector(".dp-prev");
  const nextBtn = wrapper.querySelector(".dp-next");
  const hourSelect = wrapper.querySelector(".dp-hour");
  const minuteSelect = wrapper.querySelector(".dp-minute");
  const confirmBtn = wrapper.querySelector(".dp-confirm");

  ["일", "월", "화", "수", "목", "금", "토"].forEach(w => {
    const span = document.createElement("span");
    span.innerText = w;
    weekdaysWrap.appendChild(span);
  });
  populateHourMinuteOptions(hourSelect, minuteSelect);

  function splitValue(value) {
    if (!value) return { date: todayKstStr(), time: defaultTime };
    const [date, time] = value.split("T");
    return { date, time: time || defaultTime };
  }

  let pending = splitValue(input.value);
  let viewDate = new Date(pending.date + "T00:00:00");

  function renderCalendar() {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    monthLabel.innerText = `${y}년 ${m + 1}월`;

    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    daysWrap.innerHTML = "";

    for (let i = 0; i < firstDay; i++) {
      const blank = document.createElement("span");
      blank.className = "dp-day dp-day-blank";
      daysWrap.appendChild(blank);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dp-day";
      btn.innerText = d;
      const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (dateStr === pending.date) btn.classList.add("selected");
      if (dateStr === todayKstStr()) btn.classList.add("today");
      btn.addEventListener("click", () => {
        pending.date = dateStr;
        renderCalendar();
      });
      daysWrap.appendChild(btn);
    }

    hourSelect.value = pending.time.split(":")[0];
    minuteSelect.value = pending.time.split(":")[1];
  }

  hourSelect.addEventListener("click", e => e.stopPropagation());
  minuteSelect.addEventListener("click", e => e.stopPropagation());
  hourSelect.addEventListener("change", () => { pending.time = `${hourSelect.value}:${minuteSelect.value}`; });
  minuteSelect.addEventListener("change", () => { pending.time = `${hourSelect.value}:${minuteSelect.value}`; });

  confirmBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const value = `${pending.date}T${pending.time}`;
    input.value = value;
    trigger.innerText = formatPrettyDateTimeKr(value);
    popup.classList.add("hidden");
    input.dispatchEvent(new Event("change"));
    if (options.onChange) options.onChange(value);
  });

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".date-picker-popup").forEach(p => { if (p !== popup) p.classList.add("hidden"); });
    pending = splitValue(input.value);
    viewDate = new Date(pending.date + "T00:00:00");
    popup.classList.toggle("hidden");
    renderCalendar();
  });
  prevBtn.addEventListener("click", (e) => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() - 1); renderCalendar(); });
  nextBtn.addEventListener("click", (e) => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() + 1); renderCalendar(); });
  popup.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => popup.classList.add("hidden"));

  trigger.innerText = formatPrettyDateTimeKr(input.value);

  return {
    setValue(value) {
      input.value = value || "";
      trigger.innerText = formatPrettyDateTimeKr(value);
      pending = splitValue(value);
      viewDate = new Date(pending.date + "T00:00:00");
    },
    getValue() {
      return input.value;
    }
  };
}

/* ---------------------------------------------------------
   10-d) 이미지 압축 (문제에 첨부하는 이미지를 base64로 변환하기 전, 용량을 줄임)
   Realtime Database에 통째로 저장하므로 용량이 크면 안돼서, 가로 최대 800px / JPEG 품질 0.7로 축소
--------------------------------------------------------- */
function compressImageToDataUrl(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
   11) 마감 채점 (트랜잭션 기반, 여러 클라이언트가 동시에 시도해도 딱 한 번만 실행됨)
   - 마감 시각이 지난 것을 발견한 아무 클라이언트(관리자든 학생이든)나 이 함수를 호출하면 됨.
   - meta/scored 필드에 트랜잭션을 걸어서 "채점 실행 권한"을 딱 한 클라이언트만 갖도록 함.
--------------------------------------------------------- */
async function tryFinalizeQuizScoring(dateStr) {
  const metaRef = db.ref(`${PATH.QUIZZES}/${dateStr}/meta`);
  const metaSnap = await metaRef.once("value");
  const meta = metaSnap.val();
  if (!meta) return;

  const state = computeQuizState(meta, serverNow());
  if (state !== QUIZ_STATE.CLOSED) return;
  if (meta.scored === true) return;

  const lockResult = await metaRef.child("scored").transaction(current => {
    if (current === true) return; // 이미 채점됨 -> 중단
    return true;
  });
  if (!lockResult.committed) return;

  // 잠금을 획득한 클라이언트만 아래 채점 로직을 실행
  const [answersSnap, studentsSnap] = await Promise.all([
    db.ref(`${PATH.QUIZZES}/${dateStr}/answers`).once("value"),
    db.ref(`${PATH.STUDENTS}`).once("value")
  ]);
  const answers = answersSnap.val() || {};
  const students = studentsSnap.val() || {};

  // 최종 정답자만 추려서, 정답으로 확정된 순서(correctRank)대로 정렬 -> 이게 곧 등수
  const correctList = Object.keys(answers)
    .filter(id => answers[id] && answers[id].correctRank != null)
    .sort((a, b) => answers[a].correctRank - answers[b].correctRank);

  const updates = {};

  correctList.forEach((id, idx) => {
    const points = computeScoreForRank(idx, meta);
    updates[`${PATH.QUIZZES}/${dateStr}/answers/${id}/pointsAwarded`] = points;

    const prevScore = (students[id] && students[id].totalScore) || 0;
    const prevStreak = (students[id] && students[id].currentStreak) || 0;
    const newStreak = prevStreak + 1;
    const prevLongest = (students[id] && students[id].longestStreak) || 0;

    updates[`${PATH.STUDENTS}/${id}/totalScore`] = prevScore + points;
    updates[`${PATH.STUDENTS}/${id}/currentStreak`] = newStreak;
    updates[`${PATH.STUDENTS}/${id}/longestStreak`] = Math.max(prevLongest, newStreak);
  });

  Object.keys(students).forEach(id => {
    if (correctList.includes(id)) return; // 이미 위에서 처리됨

    if (answers[id]) {
      updates[`${PATH.QUIZZES}/${dateStr}/answers/${id}/pointsAwarded`] = 0;
    }

    const prevStreak = (students[id] && students[id].currentStreak) || 0;
    if (prevStreak > 0) {
      // 스트릭이 오늘 끊김 -> 나중에 관리자가 "복구" 가능하도록 끊긴 시점 기록
      updates[`${PATH.STUDENTS}/${id}/brokenStreakDate`] = dateStr;
      updates[`${PATH.STUDENTS}/${id}/brokenStreakValue`] = prevStreak;
      updates[`${PATH.STUDENTS}/${id}/currentStreak`] = 0;
    }
  });

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }
}

/* ---------------------------------------------------------
   12) 스트릭 복구 (가장 최근에 끊긴 스트릭 1회만 복구 가능)
--------------------------------------------------------- */
async function recoverStudentStreak(studentId) {
  const snap = await db.ref(`${PATH.STUDENTS}/${studentId}`).once("value");
  const data = snap.val();
  if (!data || data.brokenStreakDate == null) return false;

  const restored = data.brokenStreakValue || 0;
  await db.ref(`${PATH.STUDENTS}/${studentId}`).update({
    currentStreak: restored,
    longestStreak: Math.max(data.longestStreak || 0, restored),
    brokenStreakDate: null,
    brokenStreakValue: null
  });
  return true;
}

/* ---------------------------------------------------------
   13) 기간별 누적 랭킹 계산 (관리자 패널용)
   quizzes/{date}/answers/{id}/pointsAwarded 를 기간 내 날짜에 대해 모두 더함
--------------------------------------------------------- */
async function computeRankingForRange(startDateStr, endDateStr) {
  const snap = await db.ref(PATH.QUIZZES)
    .orderByKey()
    .startAt(startDateStr)
    .endAt(endDateStr)
    .once("value");
  const quizzes = snap.val() || {};

  const totals = {}; // studentId -> score
  Object.keys(quizzes).forEach(date => {
    const answers = quizzes[date].answers || {};
    Object.keys(answers).forEach(id => {
      const pts = answers[id].pointsAwarded || 0;
      totals[id] = (totals[id] || 0) + pts;
    });
  });
  return totals;
}
