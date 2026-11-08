// 메인 화면: 뽑기 기계 화면 + 게임 진행(대기열, 타이머, 추첨)을 맡는 "호스트"
import {
  r, watch, get, set, update, remove, runTransaction, push, now,
  ensureDefaults, RANKS, RANK_COLORS, depletes, leftTotal, LOSE_LINES, safeStore, escapeHtml
} from "./db.js";
import { Sound } from "./sound.js";

const $ = (id) => document.getElementById(id);
const store = safeStore("sessionStorage");
const HOST_ID = store.getItem("hostId") || Math.random().toString(36).slice(2, 10);
store.setItem("hostId", HOST_ID);

// ---------- 상태 ----------
let settings = null, stock = null, queue = {}, control = null, host = null;
let started = false, isHost = false;
let phase = "idle";          // idle | control | drop | reveal
let cur = null;              // 현재 게임(로컬 사본)
let dir = 0, starting = false, lastBeep = -1, lastMoveSnd = 0;
let musicOn = true;

// ---------- 캔버스 & 기계 ----------
const cv = $("cv"), cx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
const G = { x0: 0, y0: 0, w: 0, h: 0 };    // 유리창 영역(px)
const CHUTE = 0.17;                       // 왼쪽 출구 폭(유리 폭 대비)
const CAP_COLORS = ["#ff3ea5", "#22e4ff", "#ffd23f", "#7cff6b", "#9b8cff", "#ff8a3d"];
const claw = { x: 0.6, y: 0, open: 0.25, carry: null, sway: 0 };
let caps = [];

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const rect = cv.getBoundingClientRect();
  W = rect.width; H = rect.height;
  cv.width = W * DPR; cv.height = H * DPR;
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  G.x0 = W * 0.03; G.y0 = H * 0.04; G.w = W * 0.94; G.h = H * 0.92;
}

const capR = () => 0.042;                   // 유리 폭 대비 반지름
const aspect = () => G.h / G.w;             // y(유리 높이 비율) 환산용

function buildPile() {
  caps = [];
  const R = capR(), xs = CHUTE + 0.04, xe = 0.985;
  const rowH = (R * 2 * 0.86) / aspect();   // 유리 높이 비율
  for (let row = 0; row < 6; row++) {
    const off = row % 2 ? R : 0;
    for (let x = xs + R + off; x < xe - R; x += R * 2.02) {
      const hump = 0.5 + 0.5 * Math.sin(x * 9 + 1.3);
      if (row >= 3 && Math.random() > 0.35 + hump * 0.5) continue;
      if (row >= 5 && Math.random() > 0.4) continue;
      caps.push({
        x: x + (Math.random() - 0.5) * R * 0.3,
        y: 1 - (R / aspect()) - row * rowH - Math.random() * 0.004,
        c: CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0],
        rot: Math.random() * Math.PI * 2,
        hidden: false, dropIn: 0,
      });
    }
  }
}

function minX() { return CHUTE + 0.04 + capR(); }
function maxX() { return 0.985 - capR(); }
function clawHomeY() { return 0.0; }

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

function draw(t) {
  cx.clearRect(0, 0, W, H);
  const { x0, y0, w, h } = G;
  const px = (nx) => x0 + nx * w, py = (ny) => y0 + ny * h;
  const R = capR() * w;

  // 유리 배경
  const bg = cx.createLinearGradient(0, y0, 0, y0 + h);
  bg.addColorStop(0, "rgba(34,228,255,0.05)"); bg.addColorStop(1, "rgba(255,62,165,0.10)");
  cx.fillStyle = bg; cx.fillRect(x0, y0, w, h);

  // 출구(왼쪽)
  const chW = CHUTE * w;
  cx.save();
  cx.strokeStyle = "#ffd23f"; cx.lineWidth = 3; cx.shadowColor = "#ffd23f"; cx.shadowBlur = 14;
  cx.strokeRect(x0 + 6, y0 + h * 0.45, chW - 12, h * 0.55 - 6);
  cx.restore();
  cx.fillStyle = "rgba(255,210,63,0.08)"; cx.fillRect(x0 + 6, y0 + h * 0.45, chW - 12, h * 0.55 - 6);
  cx.fillStyle = "#ffd23f"; cx.font = `${Math.max(14, h * 0.05)}px "Do Hyeon", sans-serif`;
  cx.textAlign = "center"; cx.fillText("OUT", x0 + chW / 2, y0 + h * 0.45 + h * 0.08);
  cx.font = `${Math.max(16, h * 0.08)}px sans-serif`;
  cx.fillText("▼", x0 + chW / 2, y0 + h * 0.45 + h * 0.2 + Math.sin(t / 250) * 4);

  // 캡슐 더미
  for (const c of caps) {
    if (c.hidden) continue;
    let yy = c.y;
    if (c.dropIn > 0) yy = c.y - c.dropIn;
    drawCapsule(px(c.x), py(yy), R, c.c, c.rot);
  }

  // 레일
  cx.save();
  cx.fillStyle = "#2b2150"; cx.fillRect(x0, y0, w, h * 0.035);
  cx.strokeStyle = "#22e4ff"; cx.shadowColor = "#22e4ff"; cx.shadowBlur = 10; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(x0, y0 + h * 0.035); cx.lineTo(x0 + w, y0 + h * 0.035); cx.stroke();
  cx.restore();

  // 집게
  const hx = px(claw.x) + Math.sin(claw.sway) * 3;
  const topY = y0 + h * 0.035;
  const headY = topY + h * 0.05 + claw.y * h;
  // 트롤리
  cx.fillStyle = "#3b2d6e"; cx.fillRect(px(claw.x) - R * 0.9, y0, R * 1.8, h * 0.05);
  // 줄
  cx.strokeStyle = "#cfc7ff"; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(px(claw.x), topY + h * 0.015); cx.lineTo(hx, headY); cx.stroke();
  // 몸통
  cx.save();
  cx.shadowColor = "#ff3ea5"; cx.shadowBlur = 16;
  cx.fillStyle = "#ff3ea5";
  roundRect(hx - R * 0.75, headY - R * 0.15, R * 1.5, R * 0.75, R * 0.2); cx.fill();
  cx.restore();
  cx.fillStyle = "#ffd23f"; cx.beginPath(); cx.arc(hx, headY + R * 0.22, R * 0.14, 0, Math.PI * 2); cx.fill();

  // 들고 있는 캡슐
  if (claw.carry) drawCapsule(hx, headY + R * 0.65 + R, R, claw.carry.c, claw.carry.rot);

  // 집게 발 (3개)
  const ang = 0.15 + claw.open * 0.75;
  cx.save();
  cx.strokeStyle = "#e8e2ff"; cx.lineWidth = Math.max(3, R * 0.16); cx.lineCap = "round";
  cx.shadowColor = "#22e4ff"; cx.shadowBlur = 8;
  for (const s of [-1, 1]) {
    const bx = hx + s * R * 0.55, by = headY + R * 0.55;
    const len = R * 1.25;
    const mx = bx + s * Math.sin(ang) * len, my = by + Math.cos(ang) * len;
    const tx = mx - s * Math.sin(ang * 0.9) * len * 0.6, ty = my + len * 0.5;
    cx.beginPath(); cx.moveTo(bx, by); cx.lineTo(mx, my); cx.lineTo(tx, ty); cx.stroke();
  }
  cx.beginPath(); cx.moveTo(hx, headY + R * 0.6); cx.lineTo(hx, headY + R * 1.5); cx.stroke();
  cx.restore();

  // 떨어지는 캡슐(출구로)
  if (falling) drawCapsule(px(falling.x), py(falling.y), R, falling.c, falling.rot, falling.a);

  // 유리 반사
  cx.save();
  cx.globalAlpha = 0.07; cx.fillStyle = "#fff";
  cx.beginPath(); cx.moveTo(x0 + w * 0.62, y0); cx.lineTo(x0 + w * 0.72, y0); cx.lineTo(x0 + w * 0.5, y0 + h); cx.lineTo(x0 + w * 0.4, y0 + h); cx.fill();
  cx.restore();
  cx.strokeStyle = "rgba(255,62,165,0.6)"; cx.lineWidth = 2; cx.strokeRect(x0, y0, w, h);

  // 대기 중 안내
  if (phase === "idle" && started && isHost) {
    cx.fillStyle = "rgba(242,238,255," + (0.55 + 0.35 * Math.sin(t / 400)) + ")";
    cx.font = `${Math.max(16, h * 0.06)}px "Galmuri11", "Do Hyeon", sans-serif`;
    cx.textAlign = "center";
    cx.fillText("QR을 찍고 도전하세요!", x0 + w * 0.58, y0 + h * 0.3);
  }
}
let falling = null;

function roundRect(x, y, w, h, rr) {
  cx.beginPath();
  cx.moveTo(x + rr, y); cx.arcTo(x + w, y, x + w, y + h, rr); cx.arcTo(x + w, y + h, x, y + h, rr);
  cx.arcTo(x, y + h, x, y, rr); cx.arcTo(x, y, x + w, y, rr); cx.closePath();
}

// ---------- 트윈 ----------
const tweens = [];
function tween(obj, key, to, ms, ease = (k) => 1 - Math.pow(1 - k, 3)) {
  return new Promise((res) => {
    tweens.push({ obj, key, from: obj[key], to, ms, t0: performance.now(), ease, res });
  });
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

let lastT = performance.now();
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    const k = Math.min(1, (t - tw.t0) / tw.ms);
    tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(k);
    if (k >= 1) { tweens.splice(i, 1); tw.res(); }
  }
  for (const c of caps) if (c.dropIn > 0) c.dropIn = Math.max(0, c.dropIn - dt * 1.4);

  if (phase === "control" && cur) {
    if (dir) {
      claw.x = Math.max(minX(), Math.min(maxX(), claw.x + dir * 0.42 * dt));
      claw.sway += dt * 10;
      if (t - lastMoveSnd > 90) { Sound.move(); lastMoveSnd = t; }
    } else claw.sway *= 0.9;
    const remain = cur.endsAt - now();
    const sec = Math.ceil(remain / 1000);
    const tm = $("timer");
    tm.textContent = Math.max(0, sec);
    tm.className = "timer" + (sec <= 3 ? " warn" : "");
    if (sec <= 3 && sec >= 1 && sec !== lastBeep) { Sound.beep(false); lastBeep = sec; }
    if (remain <= 0) startDrop();
  }
  draw(t);
  requestAnimationFrame(loop);
}

// ---------- HUD ----------
function renderStock() {
  if (!settings || !stock) return;
  const m = settings.mode, s = stock[m] || {};
  const bar = $("stockBar");
  const prev = bar._prev || {};
  bar.innerHTML = RANKS.map((k, i) => {
    const it = s[k] || { name: "-", left: 0, total: 0 };
    const rank = i + 1;
    const showLeft = depletes(settings, m);
    return `<div class="stock r${rank}${showLeft && it.left <= 0 ? " zero" : ""}${prev[k] !== undefined && prev[k] !== it.left ? " bump" : ""}" style="--c:${RANK_COLORS[rank]}">
      <div class="rk">${rank}등</div>
      <div class="nm">${escapeHtml(it.name)}</div>
      <div class="lf">${showLeft ? `<b>${it.left}</b><small> / ${it.total}</small>` : `<small>연습용</small>`}</div>
    </div>`;
  }).join("");
  bar._prev = Object.fromEntries(RANKS.map((k) => [k, (s[k] || {}).left]));
  $("soldout").classList.toggle("hidden", !isSoldOut());
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
  const MAX = 7;
  $("qList").innerHTML = list.length
    ? list.slice(0, MAX).map(([, v], i) => `<li><span class="n">${i + 1}</span><span>${escapeHtml(v.label)}</span></li>`).join("") +
      (list.length > MAX ? `<li class="more">외 ${list.length - MAX}명</li>` : "")
    : `<li class="empty">아직 아무도 없어요</li>`;
}

function renderNow() {
  if (cur) {
    $("nowName").textContent = cur.label;
    if (phase === "drop") { $("timer").textContent = "두근두근..."; $("timer").className = "timer small"; }
    if (phase === "reveal") { $("timer").textContent = "결과 발표!"; $("timer").className = "timer small"; }
  } else {
    $("nowName").textContent = "대기 중...";
    $("timer").textContent = ""; $("timer").className = "timer";
  }
}

function isSoldOut() {
  if (!settings || !stock) return false;
  return depletes(settings, settings.mode) && leftTotal(stock[settings.mode]) <= 0;
}

// ---------- 호스트 로직 ----------
async function maybeStartNext() {
  if (!isHost || phase !== "idle" || starting || !settings || !stock) return;
  if (isSoldOut()) return;
  const list = sortedQueue();
  if (!list.length) return;
  starting = true;
  try {
    const [qkey, e] = list[0];
    if (settings.mode === "event" && e.gid && settings.oneTry) {
      const a = (await get(r("attempts/" + e.gid))).val() || {};
      if ((a.used || 0) >= 1 + (a.bonus || 0)) { await remove(r("queue/" + qkey)); return; }
    }
    const t = now();
    const c = {
      qkey, label: e.label, gid: e.gid || null, mode: settings.mode,
      state: "control", startedAt: t, endsAt: t + (settings.controlSec || 10) * 1000,
    };
    await update(r(), { current: c, ["queue/" + qkey]: null, control: { qkey, dir: 0, grab: 0 } });
    cur = c; phase = "control"; dir = 0; lastBeep = -1;
    claw.x = Math.max(minX(), Math.min(maxX(), 0.58)); claw.y = clawHomeY(); claw.open = 0.25;
    Sound.start();
    renderNow();
  } catch (err) {
    console.error(err);
  } finally {
    starting = false;
  }
}

function onControl(c) {
  control = c;
  if (!isHost || phase !== "control" || !cur || !c || c.qkey !== cur.qkey) return;
  dir = c.dir || 0;
  if (c.grab && c.grab >= cur.startedAt) startDrop();
}

async function drawPrize(mode) {
  const s = (stock && stock[mode]) || {};
  if (!depletes(settings, mode)) {
    // 연습 모드(재고 유지): 총 수량 비율로만 추첨
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

async function startDrop() {
  if (phase !== "control" || !cur) return;
  phase = "drop"; dir = 0;
  const game = cur;
  renderNow();
  Sound.duck(true);
  update(r("current"), { state: "drop" }).catch(console.error);
  const prizeP = drawPrize(game.mode);

  // 집게 애니메이션
  const R = capR();
  let target = null, best = Infinity;
  for (const c of caps) {
    if (c.hidden) continue;
    if (Math.abs(c.x - claw.x) < R * 1.3 && c.y < best) { best = c.y; target = c; }
  }
  if (!target) {
    for (const c of caps) { if (c.hidden) continue; const d = Math.abs(c.x - claw.x); if (d < best) { best = d; target = c; } }
  }
  Sound.open(); await tween(claw, "open", 1, 250);
  if (target) await tween(claw, "x", target.x, 200);
  const headOff = 0.05 + 0.035;                 // 레일+몸통 높이(유리 비율)
  const capOff = (R * 0.65 + R) / aspect();       // 몸통→캡슐 중심
  const downY = target ? Math.max(0.05, target.y - headOff - capOff) : 0.6;
  Sound.drop(); await tween(claw, "y", downY, 1300, (k) => k * (2 - k));
  Sound.clunk(); await tween(claw, "open", 0.05, 300);
  if (target) { target.hidden = true; claw.carry = target; }
  await wait(250);
  Sound.rise(); await tween(claw, "y", clawHomeY(), 1100);
  await tween(claw, "x", CHUTE / 2, 1000, (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  Sound.open(); await tween(claw, "open", 1, 250);
  if (claw.carry) {
    const c = claw.carry; claw.carry = null;
    falling = { x: CHUTE / 2, y: 0.05 + headOff + capOff, c: c.c, rot: c.rot, a: 1 };
    await tween(falling, "y", 0.9, 550, (k) => k * k);
    Sound.plop();
    await tween(falling, "a", 0, 200);
    falling = null;
  }

  const res = await prizeP;
  await commitResult(game, res);
  phase = "reveal"; renderNow();
  await reveal(game, res);

  // 정리
  try { await update(r(), { current: null, control: null }); } catch (e) { console.error(e); }
  if (target) { target.hidden = false; target.c = CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0]; target.dropIn = 0.6; }
  cur = null; phase = "idle"; claw.open = 0.25;
  tween(claw, "x", 0.58, 600);
  Sound.duck(false);
  renderNow();
  setTimeout(maybeStartNext, 400);
}

async function commitResult(game, res) {
  const at = now();
  const ups = {
    "current/state": "result", "current/rank": res.rank, "current/prize": res.prize, "current/at": at,
  };
  if (res.rank > 0) {
    const key = push(r("logs/" + game.mode)).key;
    ups[`logs/${game.mode}/${key}`] = { label: game.label, gid: game.gid || null, rank: res.rank, prize: res.prize, at };
  }
  try { await update(r(), ups); } catch (e) { console.error(e); }
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

// ---------- 결과 공개 연출 ----------
async function reveal(game, res) {
  const ov = $("reveal"), cap = $("bigCap");
  const color = RANK_COLORS[res.rank] || "#9aa0b4";
  ov.className = "reveal";
  cap.className = "big-capsule";
  cap.style.setProperty("--capc", CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0]);
  $("revealWho").textContent = game.label;
  const rk = $("revealRank"), pz = $("revealPrize");
  if (res.rank === 0) { rk.textContent = "SOLD OUT"; pz.textContent = "캡슐이 모두 소진되었어요"; }
  else if (res.rank === 5) { rk.textContent = "꽝!"; pz.textContent = LOSE_LINES[(Math.random() * LOSE_LINES.length) | 0]; }
  else { rk.textContent = `${res.rank}등!`; pz.textContent = res.prize; }
  rk.style.color = color; rk.style.textShadow = `0 0 20px ${color}, 0 0 60px ${color}`;
  pz.style.color = res.rank === 1 ? "#ffd23f" : "#f2eeff";

  const suspense = res.rank === 1 ? 2600 : res.rank === 2 ? 2100 : 1600;
  Sound.drumroll(suspense / 1000);
  await wait(suspense);
  Sound.crack();
  cap.classList.add("open");
  ov.classList.add("shown", "r" + res.rank);
  Sound.result(res.rank);
  if (res.rank >= 1 && res.rank <= 3) confetti(res.rank);
  await wait(res.rank === 1 ? 7000 : 4200);
  ov.className = "reveal hidden";
}

function confetti(rank) {
  const c = $("confetti"), g = c.getContext("2d");
  c.width = innerWidth; c.height = innerHeight;
  const n = rank === 1 ? 320 : rank === 2 ? 160 : 80;
  const parts = Array.from({ length: n }, () => ({
    x: Math.random() * c.width, y: -Math.random() * c.height * 0.6,
    vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 5,
    s: 6 + Math.random() * 8, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    col: CAP_COLORS[(Math.random() * CAP_COLORS.length) | 0],
  }));
  const t0 = performance.now(), dur = rank === 1 ? 6500 : 3800;
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
  maybeStartNext();
}

async function cleanupStale() {
  // 이전 메인 화면이 게임 도중 꺼졌다면 정리
  try {
    const c = (await get(r("current"))).val();
    if (c && phase === "idle") await update(r(), { current: null, control: null });
  } catch (e) { console.error(e); }
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
  addEventListener("resize", () => { resize(); });
  makeQR();
  requestAnimationFrame(loop);

  try { await ensureDefaults(); } catch (e) {
    $("startErr").textContent = "Firebase에 연결하지 못했어요: " + (e.message || e);
  }
  watch("settings", (v) => { settings = v; renderMode(); renderStock(); renderQueue(); maybeStartNext(); });
  watch("stock", (v) => { stock = v; renderStock(); maybeStartNext(); });
  watch("queue", (v) => { queue = v || {}; renderQueue(); maybeStartNext(); });
  watch("control", onControl);
  watch("host", onHost);
  watch("current", (v) => {
    // 관리자가 현재 게임을 건너뛴 경우
    if (isHost && !v && phase === "control") { cur = null; phase = "idle"; renderNow(); maybeStartNext(); }
  });
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
