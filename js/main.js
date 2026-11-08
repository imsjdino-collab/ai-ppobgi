// 메인 화면: 뽑기 기계(집게 2개, 2명 동시) + 게임 진행(대기열, 타이머, 추첨)을 맡는 "호스트"
import {
  r, watch, get, set, update, runTransaction, push, now,
  ensureDefaults, RANKS, RANK_COLORS, LANE_IDS, LANE_INFO, depletes, leftTotal, LOSE_LINES, safeStore, escapeHtml
} from "./db.js";
import { Sound } from "./sound.js";

const $ = (id) => document.getElementById(id);
const store = safeStore("sessionStorage");
const HOST_ID = store.getItem("hostId") || Math.random().toString(36).slice(2, 10);
store.setItem("hostId", HOST_ID);

// ---------- 상태 ----------
let settings = null, stock = null, queue = {}, host = null;
let started = false, isHost = false, musicOn = true;
let lastMoveSnd = 0;

// ---------- 캔버스 & 기계 ----------
const cv = $("cv"), cx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
const G = { x0: 0, y0: 0, w: 0, h: 0 };   // 유리창 영역(px)
const CH = 0.12;                         // 양쪽 출구 폭(유리 폭 대비)
const PILE_X0 = CH + 0.02, PILE_X1 = 1 - CH - 0.02;
const CAP_COLORS = ["#ff3ea5", "#22e4ff", "#ffd23f", "#7cff6b", "#9b8cff", "#ff8a3d"];
const capR = () => 0.038;                  // 유리 폭 대비 반지름
const ASPECT = 0.82;                      // 기계 유리창 세로/가로 비율(고정)
const aspect = () => ASPECT;
const CAP_COUNT = 56;
const HEAD_OFF = 0.05 + 0.035;             // 레일+몸통 높이(유리 높이 비율)
const capOff = () => (capR() * 1.65) / aspect();

function makeLane(id) {
  const info = LANE_INFO[id];
  const left = id === "L";
  return {
    id, ...info,
    chuteX: left ? CH / 2 : 1 - CH / 2,
    home: left ? 0.32 : 0.68,
    min: () => PILE_X0 + capR(),
    max: () => PILE_X1 - capR(),
    claw: { x: left ? 0.32 : 0.68, y: 0, open: 0.25, carry: null, sway: 0 },
    phase: "idle",        // idle | control | drop | reveal
    cur: null, dir: 0, lastBeep: -1, starting: false, falling: null,
  };
}
const lanes = { L: makeLane("L"), R: makeLane("R") };
let caps = [];

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const rect = cv.getBoundingClientRect();
  W = rect.width; H = rect.height;
  cv.width = W * DPR; cv.height = H * DPR;
  // 기계는 항상 같은 비율(가로 1 : 세로 ASPECT)로 그리고, 남는 공간은 가운데 정렬
  const sc = Math.min((W * 0.97) / 1, (H * 0.95) / ASPECT);
  G.w = sc; G.h = sc * ASPECT;
  G.x0 = (W - G.w) / 2; G.y0 = Math.max(0, H - G.h - H * 0.025);
}

const randX = () => PILE_X0 + capR() + Math.random() * (PILE_X1 - PILE_X0 - 2 * capR());

/**
 * movers를 순서대로 위에서 떨어뜨려 쌓을 자리를 계산 (tx, ty에 저장).
 * fixed는 움직이지 않는 캡슐. 좌표는 x(유리 폭 비율), y(유리 높이 비율).
 */
function settle(movers, fixed) {
  const R = capR(), floorY = ASPECT - R;           // 세로는 폭 단위로 바꿔서 계산
  const lo = PILE_X0 + R, hi = PILE_X1 - R;
  const placed = fixed.map((c) => ({ X: c.x, Y: c.y * ASPECT }));
  const rest = (X) => {
    let Y = floorY, s = null;
    for (const p of placed) {
      const dx = Math.abs(X - p.X);
      if (dx < 2 * R) { const cand = p.Y - Math.sqrt(4 * R * R - dx * dx); if (cand < Y) { Y = cand; s = p; } }
    }
    return [Y, s];
  };
  for (const c of movers) {
    let X = Math.max(lo, Math.min(hi, c.tx ?? c.x));
    let [Y, s] = rest(X);
    // 다른 캡슐 꼭대기에 위태롭게 얹히면 옆으로 굴러 내려가게
    for (let i = 0; i < 14 && s; i++) {
      const d = Math.sign(X - s.X) || (Math.random() < 0.5 ? -1 : 1);
      const X2 = Math.max(lo, Math.min(hi, X + d * R * 0.3));
      if (X2 === X) break;
      const [Y2, s2] = rest(X2);
      if (Y2 > Y + 1e-5) { X = X2; Y = Y2; s = s2; } else break;
    }
    c.tx = X; c.ty = Y / ASPECT;
    placed.push({ X, Y });
  }
}

function buildPile() {
  caps = Array.from({ length: CAP_COUNT }, () => ({
    x: randX(), y: 0, tx: randX(),
    c: CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0],
    rot: Math.random() * Math.PI * 2,
    hidden: false, locked: false,
  }));
  settle(caps, []);
  for (const c of caps) { c.x = c.tx; c.y = c.ty; }
}

// ---------- 그리기 ----------
function drawCapsule(px, py, rad, color, rot, alpha = 1) {
  cx.save();
  cx.globalAlpha = alpha;
  cx.translate(px, py); cx.rotate(rot);
  cx.shadowColor = color; cx.shadowBlur = rad * 0.6;
  cx.beginPath(); cx.arc(0, 0, rad, Math.PI, 0); cx.closePath();
  cx.fillStyle = color; cx.fill();
  cx.shadowBlur = 0;
  cx.beginPath(); cx.arc(0, 0, rad, 0, Math.PI); cx.closePath();
  cx.fillStyle = "rgba(230,225,255,0.85)"; cx.fill();
  cx.fillStyle = "rgba(0,0,0,0.35)"; cx.fillRect(-rad, -rad * 0.06, rad * 2, rad * 0.12);
  cx.beginPath(); cx.arc(-rad * 0.35, -rad * 0.45, rad * 0.22, 0, Math.PI * 2);
  cx.fillStyle = "rgba(255,255,255,0.55)"; cx.fill();
  cx.restore();
}

function roundRect(x, y, w, h, rr) {
  cx.beginPath();
  cx.moveTo(x + rr, y); cx.arcTo(x + w, y, x + w, y + h, rr); cx.arcTo(x + w, y + h, x, y + h, rr);
  cx.arcTo(x, y + h, x, y, rr); cx.arcTo(x, y, x + w, y, rr); cx.closePath();
}

const FONT = '"Galmuri11", sans-serif';

function drawChute(ln, t) {
  const { x0, y0, w, h } = G;
  const chW = CH * w, left = ln.id === "L";
  const bx = left ? x0 + 6 : x0 + w - chW + 6;
  cx.save();
  cx.strokeStyle = ln.color; cx.lineWidth = 3; cx.shadowColor = ln.color; cx.shadowBlur = 14;
  cx.strokeRect(bx, y0 + h * 0.45, chW - 12, h * 0.55 - 6);
  cx.restore();
  cx.globalAlpha = 0.08; cx.fillStyle = ln.color; cx.fillRect(bx, y0 + h * 0.45, chW - 12, h * 0.55 - 6); cx.globalAlpha = 1;
  cx.fillStyle = ln.color; cx.textAlign = "center";
  cx.font = `bold ${Math.max(14, h * 0.05)}px ${FONT}`;
  cx.fillText(ln.tag, bx + (chW - 12) / 2, y0 + h * 0.53);
  cx.font = `${Math.max(12, h * 0.035)}px ${FONT}`;
  cx.fillText("OUT", bx + (chW - 12) / 2, y0 + h * 0.59);
  cx.font = `${Math.max(16, h * 0.07)}px sans-serif`;
  cx.fillText("▼", bx + (chW - 12) / 2, y0 + h * 0.7 + Math.sin(t / 250) * 4);
}

function drawClaw(ln) {
  const { x0, y0, w, h } = G;
  const R = capR() * w, c = ln.claw;
  const hx = x0 + c.x * w + Math.sin(c.sway) * 3;
  const topY = y0 + h * 0.035;
  const headY = topY + h * 0.05 + c.y * h;
  cx.fillStyle = "#3b2d6e"; cx.fillRect(x0 + c.x * w - R * 0.9, y0, R * 1.8, h * 0.05);
  cx.strokeStyle = "#cfc7ff"; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(x0 + c.x * w, topY + h * 0.015); cx.lineTo(hx, headY); cx.stroke();
  cx.save();
  cx.shadowColor = ln.color; cx.shadowBlur = 16; cx.fillStyle = ln.color;
  roundRect(hx - R * 0.75, headY - R * 0.15, R * 1.5, R * 0.75, R * 0.2); cx.fill();
  cx.restore();
  cx.fillStyle = "#0b0716"; cx.font = `bold ${Math.max(10, R * 0.5)}px ${FONT}`; cx.textAlign = "center";
  cx.fillText(ln.tag, hx, headY + R * 0.42);
  if (c.carry) drawCapsule(hx, headY + R * 0.65 + R, R, c.carry.c, c.carry.rot);
  const ang = 0.15 + c.open * 0.75;
  cx.save();
  cx.strokeStyle = "#e8e2ff"; cx.lineWidth = Math.max(3, R * 0.16); cx.lineCap = "round";
  cx.shadowColor = ln.color; cx.shadowBlur = 8;
  for (const s of [-1, 1]) {
    const bx = hx + s * R * 0.55, by = headY + R * 0.55, len = R * 1.25;
    const mx = bx + s * Math.sin(ang) * len, my = by + Math.cos(ang) * len;
    const tx = mx - s * Math.sin(ang * 0.9) * len * 0.6, ty = my + len * 0.5;
    cx.beginPath(); cx.moveTo(bx, by); cx.lineTo(mx, my); cx.lineTo(tx, ty); cx.stroke();
  }
  cx.beginPath(); cx.moveTo(hx, headY + R * 0.6); cx.lineTo(hx, headY + R * 1.5); cx.stroke();
  cx.restore();
  if (ln.falling) drawCapsule(x0 + ln.falling.x * w, y0 + ln.falling.y * h, R, ln.falling.c, ln.falling.rot, ln.falling.a);
}

function draw(t) {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx.clearRect(0, 0, W, H);
  const { x0, y0, w, h } = G;
  const px = (nx) => x0 + nx * w, py = (ny) => y0 + ny * h;
  const R = capR() * w;

  const bg = cx.createLinearGradient(0, y0, 0, y0 + h);
  bg.addColorStop(0, "rgba(34,228,255,0.05)"); bg.addColorStop(1, "rgba(255,62,165,0.10)");
  cx.fillStyle = bg; cx.fillRect(x0, y0, w, h);

  for (const id of LANE_IDS) drawChute(lanes[id], t);

  // 털기
  if (shakeUntil > t) {
    const a = Math.min(1, (shakeUntil - t) / 400) * W * 0.008;
    cx.translate((Math.random() - 0.5) * a * 2, (Math.random() - 0.5) * a);
  }
  const sk = shuf ? Math.min(1, (t - shuf.t0) / shuf.ms) : 0;
  for (const c of caps) {
    if (c.hidden) continue;
    let xx = c.x, yy = c.y;
    if (shuf && c.sx !== undefined) {
      const k = Math.max(0, Math.min(1, (sk - c.delay) / (1 - c.delay)));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      xx = c.sx + (c.tx - c.sx) * e;
      yy = c.sy + (c.ty - c.sy) * e - Math.sin(Math.PI * k) * c.lift;
    }
    drawCapsule(px(xx), py(yy), R, c.c, c.rot + (shuf && c.sx !== undefined ? sk * c.spin : 0));
  }
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // 레일
  cx.save();
  cx.fillStyle = "#2b2150"; cx.fillRect(x0, y0, w, h * 0.035);
  cx.strokeStyle = "#22e4ff"; cx.shadowColor = "#22e4ff"; cx.shadowBlur = 10; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(x0, y0 + h * 0.035); cx.lineTo(x0 + w, y0 + h * 0.035); cx.stroke();
  cx.restore();

  for (const id of LANE_IDS) drawClaw(lanes[id]);

  // 조종 중인 집게 아래에 이름 표시
  cx.textAlign = "center";
  for (const id of LANE_IDS) {
    const ln = lanes[id];
    if (ln.cur && ln.phase === "control") {
      cx.fillStyle = ln.color; cx.font = `bold ${Math.max(13, h * 0.04)}px ${FONT}`;
      cx.fillText(ln.cur.label, px(ln.claw.x), y0 + h * (0.035 + 0.05 + ln.claw.y) + R * 3.4);
    }
  }
  if (started && isHost && LANE_IDS.every((id) => lanes[id].phase === "idle")) {
    cx.fillStyle = `rgba(242,238,255,${0.5 + 0.35 * Math.sin(t / 400)})`;
    cx.font = `bold ${Math.max(14, h * 0.05)}px ${FONT}`;
    cx.fillText("QR을 찍고 도전하세요!", px(0.5), y0 + h * 0.36);
  }

  cx.save();
  cx.globalAlpha = 0.06; cx.fillStyle = "#fff";
  cx.beginPath(); cx.moveTo(x0 + w * 0.62, y0); cx.lineTo(x0 + w * 0.7, y0); cx.lineTo(x0 + w * 0.5, y0 + h); cx.lineTo(x0 + w * 0.42, y0 + h); cx.fill();
  cx.restore();
  cx.strokeStyle = "rgba(255,62,165,0.6)"; cx.lineWidth = 2; cx.strokeRect(x0, y0, w, h);
}

// ---------- 트윈 ----------
const tweens = [];
function tween(obj, key, to, ms, ease = (k) => 1 - Math.pow(1 - k, 3)) {
  return new Promise((res) => {
    tweens.push({ obj, key, from: obj[key], to, ms, t0: performance.now(), ease, res });
  });
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const easeIO = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

let lastT = performance.now();
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    const k = Math.min(1, (t - tw.t0) / tw.ms);
    tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(k);
    if (k >= 1) { tweens.splice(i, 1); tw.res(); }
  }
  let moving = false;
  for (const id of LANE_IDS) {
    const ln = lanes[id];
    if (ln.phase !== "control" || !ln.cur) continue;
    const c = ln.claw;
    if (ln.dir) {
      c.x = Math.max(ln.min(), Math.min(ln.max(), c.x + ln.dir * 0.3 * dt));
      c.sway += dt * 10; moving = true;
    } else c.sway *= 0.9;
    const remain = ln.cur.endsAt - now();
    const sec = Math.ceil(remain / 1000);
    const tm = $("tm" + id);
    tm.textContent = Math.max(0, sec);
    tm.className = "lane-tm" + (sec <= 3 ? " warn" : "");
    if (sec <= 3 && sec >= 1 && sec !== ln.lastBeep) { Sound.beep(false); ln.lastBeep = sec; }
    if (remain <= 0) startDrop(ln);
  }
  if (moving && t - lastMoveSnd > 90) { Sound.move(); lastMoveSnd = t; }
  draw(t);
  requestAnimationFrame(loop);
}

// ---------- HUD ----------
function renderStock() {
  if (!settings || !stock) return;
  const m = settings.mode, s = stock[m] || {};
  const bar = $("stockBar");
  const prev = bar._prev || {};
  const showLeft = depletes(settings, m);
  bar.innerHTML = RANKS.map((k, i) => {
    const it = s[k] || { name: "-", left: 0, total: 0 };
    const rank = i + 1;
    return `<div class="stock r${rank}${showLeft && it.left <= 0 ? " zero" : ""}${prev[k] !== undefined && prev[k] !== it.left ? " bump" : ""}" style="--c:${RANK_COLORS[rank]}">
      <div class="rk">${rank}등</div>
      <div class="nm">${escapeHtml(it.name)}</div>
      <div class="lf">${showLeft ? `<b>${it.left}</b><small> / ${it.total}</small>` : `<small>연습용</small>`}</div>
    </div>`;
  }).join("");
  bar._prev = Object.fromEntries(RANKS.map((k) => [k, (s[k] || {}).left]));
  $("soldout").classList.toggle("hidden", !isSoldOut() || LANE_IDS.some((id) => lanes[id].phase !== "idle"));
}

function renderMode() {
  if (!settings) return;
  const b = $("modeBadge");
  b.className = "mode-badge " + settings.mode;
  b.textContent = settings.mode === "event" ? "★ 본 행사" : "연습 모드";
  $("howSec").textContent = settings.controlSec;
  $("howStep2").textContent = settings.mode === "event" ? "학번을 입력해요" : "닉네임을 입력해요";
}

function sortedQueue() {
  return Object.entries(queue || {})
    .filter(([, v]) => v && settings && v.mode === settings.mode)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
}

function renderQueue() {
  const list = sortedQueue();
  $("qCount").textContent = list.length ? `(${list.length}명)` : "";
  const MAX = 6;
  $("qList").innerHTML = list.length
    ? list.slice(0, MAX).map(([, v], i) => `<li><span class="n">${i + 1}</span><span>${escapeHtml(v.label)}</span></li>`).join("") +
      (list.length > MAX ? `<li class="more">외 ${list.length - MAX}명</li>` : "")
    : `<li class="empty">아직 아무도 없어요</li>`;
}

function renderLane(ln) {
  const nm = $("nm" + ln.id), tm = $("tm" + ln.id);
  if (ln.cur && ln.phase !== "idle") {
    nm.textContent = ln.cur.label;
    if (ln.phase === "drop") { tm.textContent = "두근두근"; tm.className = "lane-tm small"; }
    if (ln.phase === "reveal") { tm.textContent = "결과 발표!"; tm.className = "lane-tm small"; }
    if (ln.phase === "shuffle") { tm.textContent = "섞는 중!"; tm.className = "lane-tm small"; }
  } else {
    nm.textContent = "대기 중...";
    tm.textContent = ""; tm.className = "lane-tm";
  }
}

function inPlayCount() { return LANE_IDS.filter((id) => lanes[id].cur).length; }
function isSoldOut() {
  if (!settings || !stock) return false;
  return depletes(settings, settings.mode) && leftTotal(stock[settings.mode]) <= 0;
}

// ---------- 호스트 로직 ----------
let scheduling = false;
async function maybeStartNext() {
  if (!isHost || !settings || !stock || scheduling) return;
  scheduling = true;
  try { await fillLanes(); } finally { scheduling = false; }
}
async function fillLanes() {
  for (const id of LANE_IDS) {
    const ln = lanes[id];
    if (ln.phase !== "idle" || ln.starting) continue;
    // 남은 캡슐보다 많은 사람이 동시에 시작하지 않도록
    if (depletes(settings, settings.mode) && leftTotal(stock[settings.mode]) - inPlayCount() <= 0) return;
    const busy = new Set(LANE_IDS.map((k) => lanes[k].cur && lanes[k].cur.qkey).filter(Boolean));
    const list = sortedQueue().filter(([k]) => !busy.has(k));
    if (!list.length) return;
    await startLane(ln, list[0][0], list[0][1]);
  }
}

async function startLane(ln, qkey, e) {
  ln.starting = true;
  try {
    if (settings.mode === "event" && e.gid && settings.oneTry) {
      const a = (await get(r("attempts/" + e.gid))).val() || {};
      if ((a.used || 0) >= 1 + (a.bonus || 0)) { await set(r("queue/" + qkey), null); return; }
    }
    const t = now();
    const c = {
      qkey, label: e.label, gid: e.gid || null, mode: settings.mode,
      state: "control", startedAt: t, endsAt: t + (settings.controlSec || 10) * 1000,
    };
    ln.cur = c; ln.phase = "control"; ln.dir = 0; ln.lastBeep = -1;
    await update(r(), { ["lanes/" + ln.id]: c, ["queue/" + qkey]: null, ["control/" + ln.id]: { qkey, dir: 0, grab: 0 } });
    ln.claw.x = Math.max(ln.min(), Math.min(ln.max(), ln.home)); ln.claw.y = 0; ln.claw.open = 0.25;
    Sound.start();
    renderLane(ln);
  } catch (err) {
    console.error(err);
    if (ln.phase === "control" && ln.cur && ln.cur.qkey === qkey) { ln.cur = null; ln.phase = "idle"; }
  } finally {
    ln.starting = false;
  }
}

function onControl(all) {
  if (!isHost) return;
  for (const id of LANE_IDS) {
    const ln = lanes[id], c = all && all[id];
    if (ln.phase !== "control" || !ln.cur || !c || c.qkey !== ln.cur.qkey) continue;
    ln.dir = c.dir || 0;
    if (c.grab && c.grab >= ln.cur.startedAt) startDrop(ln);
  }
}

function onLanes(v) {
  // 관리자가 조종 중인 게임을 취소한 경우
  if (!isHost) return;
  for (const id of LANE_IDS) {
    const ln = lanes[id];
    if (ln.phase === "control" && (!v || !v[id])) { ln.cur = null; ln.phase = "idle"; ln.dir = 0; renderLane(ln); }
  }
  maybeStartNext();
}

async function drawPrize(mode) {
  const s = (stock && stock[mode]) || {};
  if (!depletes(settings, mode)) {
    const tot = RANKS.reduce((a, k) => a + ((s[k] && s[k].total) || 0), 0);
    if (tot <= 0) return { rank: 5, prize: (s.r5 && s.r5.name) || "꽝" };
    let x = Math.random() * tot;
    for (let i = 0; i < RANKS.length; i++) {
      x -= (s[RANKS[i]] && s[RANKS[i]].total) || 0;
      if (x < 0) return { rank: i + 1, prize: s[RANKS[i]].name };
    }
    return { rank: 5, prize: s.r5.name };
  }
  let chosen = null;
  await runTransaction(r("stock/" + mode), (st) => {
    if (!st) return st;
    chosen = null;
    const tot = RANKS.reduce((a, k) => a + Math.max(0, (st[k] && st[k].left) || 0), 0);
    if (tot <= 0) { chosen = { rank: 0, prize: "재고 소진" }; return; }
    let x = Math.random() * tot;
    for (let i = 0; i < RANKS.length; i++) {
      const k = RANKS[i], left = Math.max(0, (st[k] && st[k].left) || 0);
      x -= left;
      if (x < 0) { st[k].left = left - 1; chosen = { rank: i + 1, prize: st[k].name }; break; }
    }
    return st;
  });
  return chosen || { rank: 0, prize: "재고 소진" };
}

async function startDrop(ln) {
  if (ln.phase !== "control" || !ln.cur) return;
  ln.phase = "drop"; ln.dir = 0;
  const game = ln.cur, c = ln.claw;
  renderLane(ln);
  Sound.duck(true);
  update(r("lanes/" + ln.id), { state: "drop" }).catch(console.error);
  const prizeP = drawPrize(game.mode);

  if (shufP) await shufP;   // 섞는 중이면 끝날 때까지 기다림
  const R = capR();
  let target = null, best = Infinity;
  for (const cp of caps) {
    if (cp.hidden || cp.locked) continue;
    if (Math.abs(cp.x - c.x) < R * 1.3 && cp.y < best) { best = cp.y; target = cp; }
  }
  if (!target) {
    for (const cp of caps) {
      if (cp.hidden || cp.locked) continue;
      const d = Math.abs(cp.x - c.x); if (d < best) { best = d; target = cp; }
    }
  }
  if (target) target.locked = true;
  const capColor = target ? target.c : CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0];
  update(r("lanes/" + ln.id), { capColor }).catch(console.error);
  Sound.open(); await tween(c, "open", 1, 250);
  if (target) await tween(c, "x", Math.max(ln.min(), Math.min(ln.max(), target.x)), 200);
  const downY = target ? Math.max(0.05, target.y - HEAD_OFF - capOff()) : 0.6;
  Sound.drop(); await tween(c, "y", downY, 1300, (k) => k * (2 - k));
  Sound.clunk(); await tween(c, "open", 0.05, 300);
  if (target) { target.hidden = true; target.locked = false; c.carry = target; settleAfterGrab(); }
  await wait(250);
  Sound.rise(); await tween(c, "y", 0, 1100);
  await tween(c, "x", ln.chuteX, 900, easeIO);
  Sound.open(); await tween(c, "open", 1, 250);
  if (c.carry) {
    const cp = c.carry; c.carry = null;
    ln.falling = { x: ln.chuteX, y: HEAD_OFF + capOff(), c: cp.c, rot: cp.rot, a: 1 };
    await tween(ln.falling, "y", 0.9, 550, (k) => k * k);
    Sound.plop();
    await tween(ln.falling, "a", 0, 200);
    ln.falling = null;
  }

  const res = await prizeP;
  await commitResult(game, res);
  ln.phase = "reveal"; renderLane(ln);
  await reveal(ln, game, res, capColor);

  // 정리 → 털고 섞기
  try { await update(r(), { ["lanes/" + ln.id]: null, ["control/" + ln.id]: null }); } catch (e) { console.error(e); }
  if (target) { target.hidden = false; target.c = CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0]; target.x = randX(); target.y = -0.15; }
  c.open = 0.25;
  tween(c, "x", ln.home, 600);
  ln.phase = "shuffle"; renderLane(ln);
  await shakeAndShuffle();
  ln.cur = null; ln.phase = "idle";
  if (LANE_IDS.every((id) => lanes[id].phase === "idle")) Sound.duck(false);
  renderLane(ln); renderStock();
  setTimeout(maybeStartNext, 200);
}

async function commitResult(game, res) {
  const at = now();
  if (res.rank > 0) {
    const key = push(r("logs/" + game.mode)).key;
    try {
      await set(r(`logs/${game.mode}/${key}`), { label: game.label, gid: game.gid || null, rank: res.rank, prize: res.prize, at });
    } catch (e) { console.error(e); }
  }
  if (game.mode === "event" && game.gid && res.rank > 0) {
    try {
      await runTransaction(r("attempts/" + game.gid), (a) => {
        a = a || {};
        a.used = (a.used || 0) + 1;
        a.bonus = a.bonus || 0;
        a.last = { rank: res.rank, prize: res.prize, at };
        return a;
      });
    } catch (e) { console.error(e); }
  }
}

// ---------- 털고 섞기 ----------
let shuf = null, shakeUntil = 0, shufP = null;
function shakeAndShuffle() {
  const run = async () => {
    const t0 = performance.now();
    shakeUntil = t0 + 1300;
    const m = document.querySelector(".machine");
    m.classList.remove("rattle"); void m.offsetWidth; m.classList.add("rattle");
    Sound.rattle(1.2);
    const movers = caps.filter((cp) => !cp.hidden && !cp.locked);
    const fixed = caps.filter((cp) => !cp.hidden && cp.locked);
    for (let i = movers.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [movers[i], movers[j]] = [movers[j], movers[i]]; }
    movers.forEach((cp) => { cp.tx = randX(); });
    settle(movers, fixed);
    movers.forEach((cp) => {
      cp.sx = cp.x; cp.sy = cp.y;
      cp.lift = 0.08 + Math.random() * 0.25;
      cp.delay = Math.random() * 0.3;
      cp.spin = (Math.random() - 0.5) * 8;
    });
    shuf = { t0, ms: 1300 };
    await wait(1350);
    movers.forEach((cp) => { cp.x = cp.tx; cp.y = cp.ty; cp.rot += cp.spin; delete cp.sx; });
    shuf = null;
    m.classList.remove("rattle");
  };
  return chain(run);
}

/** 캡슐 하나가 빠진 뒤 위에 있던 캡슐들이 살짝 내려앉기 */
function settleAfterGrab() {
  return chain(async () => {
    const movers = caps.filter((cp) => !cp.hidden && !cp.locked).sort((a, b) => b.y - a.y);
    const fixed = caps.filter((cp) => !cp.hidden && cp.locked);
    movers.forEach((cp) => { cp.tx = cp.x; });
    settle(movers, fixed);
    movers.forEach((cp) => { cp.sx = cp.x; cp.sy = cp.y; cp.lift = 0; cp.delay = 0; cp.spin = 0; });
    shuf = { t0: performance.now(), ms: 350 };
    await wait(380);
    movers.forEach((cp) => { cp.x = cp.tx; cp.y = cp.ty; delete cp.sx; });
    shuf = null;
  });
}

function chain(run) {
  const prev = shufP || Promise.resolve();
  const p = prev.then(run);
  shufP = p;
  p.then(() => { if (shufP === p) shufP = null; });
  return p;
}

// ---------- 결과 공개 연출 (구역별 반쪽 화면) ----------
async function reveal(ln, game, res, capColor) {
  const ov = $("reveal" + ln.id), cap = ov.querySelector(".big-capsule");
  const color = RANK_COLORS[res.rank] || "#9aa0b4";
  ov.className = "reveal side-" + ln.id;
  ov.style.setProperty("--lane", ln.color);
  cap.className = "big-capsule";
  cap.style.setProperty("--capc", capColor);
  ov.querySelector(".reveal-who").innerHTML = `<span style="color:${ln.color}">${ln.tag}</span> ${escapeHtml(game.label)}`;
  const rk = ov.querySelector(".reveal-rank"), pz = ov.querySelector(".reveal-prize");
  if (res.rank === 0) { rk.textContent = "SOLD OUT"; pz.textContent = "캡슐이 모두 소진되었어요"; }
  else if (res.rank === 5) { rk.textContent = "꽝!"; pz.textContent = LOSE_LINES[(Math.random() * LOSE_LINES.length) | 0]; }
  else { rk.textContent = `${res.rank}등!`; pz.textContent = res.prize; }
  rk.style.color = color; rk.style.textShadow = `0 0 20px ${color}, 0 0 60px ${color}`;
  pz.style.color = res.rank === 1 ? "#ffd23f" : "#f2eeff";

  const suspense = res.rank === 1 ? 1800 : res.rank === 2 ? 1400 : 1000;
  Sound.drumroll(suspense / 1000);
  await wait(suspense);
  Sound.crack();
  // 메인 화면에서 캡슐이 열리는 순간에 폰에도 결과를 보냄
  update(r("lanes/" + ln.id), { state: "result", rank: res.rank, prize: res.prize, at: now() }).catch(console.error);
  cap.classList.add("open");
  ov.classList.add("shown", "r" + res.rank);
  Sound.result(res.rank);
  if (res.rank >= 1 && res.rank <= 3) confetti(ov.querySelector("canvas"), res.rank);
  await wait(res.rank === 1 ? 4500 : 2500);
  ov.className = "reveal hidden";
}

function confetti(c, rank) {
  const g = c.getContext("2d");
  c.width = c.clientWidth; c.height = c.clientHeight;
  const n = rank === 1 ? 220 : rank === 2 ? 110 : 60;
  const parts = Array.from({ length: n }, () => ({
    x: Math.random() * c.width, y: -Math.random() * c.height * 0.6,
    vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 5,
    s: 6 + Math.random() * 8, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    col: CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0],
  }));
  const t0 = performance.now(), dur = rank === 1 ? 4300 : 2400;
  (function f(t) {
    g.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.03;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.col; g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.restore();
    }
    if (t - t0 < dur) requestAnimationFrame(f); else g.clearRect(0, 0, c.width, c.height);
  })(t0);
}

// ---------- 호스트 하나만 ----------
let hbTimer = null;
function claimHost() {
  isHost = true;
  $("hostWarn").classList.add("hidden");
  const beat = () => set(r("host"), { id: HOST_ID, at: now() }).catch(console.error);
  beat(); clearInterval(hbTimer); hbTimer = setInterval(beat, 3000);
  cleanupStale();
}

async function cleanupStale() {
  // 이전 메인 화면이 게임 도중 꺼졌다면 정리
  try {
    if (LANE_IDS.every((id) => lanes[id].phase === "idle")) await update(r(), { lanes: null, control: null, current: null });
  } catch (e) { console.error(e); }
  maybeStartNext();
}

function onHost(h) {
  host = h;
  if (!started) return;
  if (h && h.id !== HOST_ID && now() - (h.at || 0) < 8000) {
    if (isHost) { isHost = false; clearInterval(hbTimer); }
    $("hostWarn").classList.remove("hidden");
  }
}

// ---------- QR ----------
function makeQR() {
  const url = new URL("play.html", location.href).href;
  $("qrUrl").textContent = url.replace(/^https?:\/\//, "");
  try {
    new QRCode($("qrBox"), { text: url, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) { $("qrBox").textContent = url; }
}

// ---------- 시작 ----------
async function boot() {
  resize(); buildPile();
  addEventListener("resize", resize);
  makeQR();
  for (const id of LANE_IDS) { $("tag" + id).style.color = LANE_INFO[id].color; renderLane(lanes[id]); }
  requestAnimationFrame(loop);

  try { await ensureDefaults(); } catch (e) {
    $("startErr").textContent = "Firebase에 연결하지 못했어요: " + (e.message || e);
  }
  watch("settings", (v) => { settings = v; renderMode(); renderStock(); renderQueue(); maybeStartNext(); });
  watch("stock", (v) => { stock = v; renderStock(); maybeStartNext(); });
  watch("queue", (v) => { queue = v || {}; renderQueue(); maybeStartNext(); });
  watch("control", onControl);
  watch("host", onHost);
  watch("lanes", onLanes);
  setInterval(maybeStartNext, 1500);

  $("startBtn").onclick = async () => {
    Sound.init(); Sound.resume();
    try { await document.documentElement.requestFullscreen?.(); } catch (e) {}
    $("startOv").classList.add("hidden");
    started = true;
    if (musicOn) Sound.bgm(true);
    setTimeout(resize, 300);
    const h = host;
    if (h && h.id !== HOST_ID && now() - (h.at || 0) < 8000) $("hostWarn").classList.remove("hidden");
    else claimHost();
  };
  $("takeover").onclick = () => claimHost();
  $("muteBtn").onclick = () => {
    musicOn = !musicOn; Sound.bgm(musicOn);
    $("muteBtn").classList.toggle("off", !musicOn);
  };
}
boot();
