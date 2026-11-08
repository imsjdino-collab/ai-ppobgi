// 공통: Firebase 연결, 기본값, 도우미 함수
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, set, update, remove, get,
  runTransaction, onDisconnect, push
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const r = (p) => (p ? ref(db, p) : ref(db));
export { onValue, set, update, remove, get, runTransaction, onDisconnect, push };

let offset = 0;
onValue(r(".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });
/** 서버 기준 현재 시각(ms) — 기기마다 시계가 달라도 타이머가 맞도록 */
export const now = () => Date.now() + offset;

export function watch(path, cb) {
  return onValue(r(path), (s) => cb(s.val()));
}

export const RANKS = ["r1", "r2", "r3", "r4", "r5"];
export const RANK_COLORS = {
  1: "#FFD23F", 2: "#FF3EA5", 3: "#22E4FF", 4: "#7CFF6B", 5: "#9B8CFF", 0: "#9aa0b4"
};

export const DEFAULT_SETTINGS = {
  mode: "practice",        // "practice"(연습) | "event"(본 행사)
  oneTry: true,            // 본 행사: 학번당 1회 제한
  controlSec: 10,          // 조종 제한 시간(초)
  practiceDeplete: false,  // 연습 모드에서도 재고를 줄일지
};

export const DEFAULT_STOCK = {
  event: {
    r1: { name: "당첨!!!!", total: 10, left: 10 },
    r2: { name: "쿠키 1개", total: 30, left: 30 },
    r3: { name: "마이쮸 2개", total: 50, left: 50 },
    r4: { name: "미니 인간사료 1개", total: 100, left: 100 },
    r5: { name: "꽝", total: 180, left: 180 },
  },
  practice: {
    r1: { name: "발표 면제권", total: 2, left: 2 },
    r2: { name: "칭찬 스티커 3장", total: 4, left: 4 },
    r3: { name: "칭찬 스티커 2장", total: 6, left: 6 },
    r4: { name: "칭찬 스티커 1장", total: 8, left: 8 },
    r5: { name: "꽝", total: 10, left: 10 },
  },
};

/** 처음 실행할 때 기본 설정과 재고를 만들어 둠 */
export async function ensureDefaults() {
  const [s, st] = await Promise.all([get(r("settings")), get(r("stock"))]);
  const ups = {};
  if (!s.exists()) ups["settings"] = DEFAULT_SETTINGS;
  else {
    const cur = s.val();
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (cur[k] === undefined) ups["settings/" + k] = DEFAULT_SETTINGS[k];
    }
  }
  const stock = st.val() || {};
  if (!stock.event) ups["stock/event"] = DEFAULT_STOCK.event;
  if (!stock.practice) ups["stock/practice"] = DEFAULT_STOCK.practice;
  if (Object.keys(ups).length) await update(r(), ups);
}

export const pad2 = (n) => String(n).padStart(2, "0");
export const gidOf = (g, c, n) => `${g}-${pad2(c)}-${pad2(n)}`;
export function labelOf(gid) {
  const [g, c, n] = gid.split("-").map(Number);
  return `${g}학년 ${c}반 ${n}번`;
}

/** 재고를 줄이는 모드인지 */
export const depletes = (settings, mode) =>
  mode === "event" || !!(settings && settings.practiceDeplete);

export function leftTotal(stockOfMode) {
  if (!stockOfMode) return 0;
  return RANKS.reduce((a, k) => a + Math.max(0, (stockOfMode[k] && stockOfMode[k].left) || 0), 0);
}

export const LOSE_LINES = [
  "AI가 계산해봤는데... 꽝!",
  "알고리즘이 오늘은 아니래요",
  "확률은 거짓말을 하지 않아요",
  "데이터가 부족했나 봐요",
  "오류 404: 상품을 찾을 수 없음",
];

export function safeStore(kind = "localStorage") {
  try {
    const s = window[kind];
    const t = "__t";
    s.setItem(t, "1"); s.removeItem(t);
    return s;
  } catch (e) {
    const mem = {};
    return {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; },
    };
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
