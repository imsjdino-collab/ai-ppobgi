// 관리자 페이지
import {
  r, watch, get, set, update, remove, runTransaction,
  ensureDefaults, RANKS, RANK_COLORS, LANE_IDS, LANE_INFO, gidOf, labelOf, safeStore, escapeHtml,
  activeRanks, isLose, rankText, nameKey, tidOf
} from "./db.js";
import { ADMIN_PIN } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const ss = safeStore("sessionStorage");
let settings = null, stock = null, logs = {}, queue = {}, lanes = {}, roster = {}, rosterDirty = false;
let stockTab = "event", logTab = "event", stockDirty = false;

function flash(id, text, err = false) {
  const el = $(id); el.textContent = text; el.className = "msg" + (err ? " err" : "");
  clearTimeout(el._t); el._t = setTimeout(() => { el.textContent = ""; }, 3000);
}

// ---------- 로그인 ----------
function tryLogin(pin) {
  if (pin === ADMIN_PIN) { ss.setItem("adm", "1"); $("login").classList.add("hidden"); $("adm").classList.remove("hidden"); start(); }
  else flash("pinMsg", "비밀번호가 달라요", true);
}
$("pinBtn").onclick = () => tryLogin($("pin").value);
$("pin").onkeydown = (e) => { if (e.key === "Enter") tryLogin($("pin").value); };
if (ss.getItem("adm") === "1") tryLogin(ADMIN_PIN);

// ---------- 시작 ----------
let startedOnce = false;
async function start() {
  if (startedOnce) return; startedOnce = true;
  try { await ensureDefaults(); } catch (e) { alert("Firebase 연결 실패: " + (e.message || e)); }
  watch("settings", (v) => { settings = v; renderSettings(); });
  watch("stock", (v) => { stock = v; if (!stockDirty) renderStock(); });
  watch("logs", (v) => { logs = v || {}; renderLogs(); });
  watch("queue", (v) => { queue = v || {}; renderQueue(); });
  watch("lanes", (v) => { lanes = v || {}; renderQueue(); });
  watch("roster", (v) => { roster = v || {}; if (!rosterDirty) renderRoster(); });
}

// ---------- 설정 ----------
function renderSettings() {
  if (!settings) return;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("on", b.dataset.mode === settings.mode));
  $("oneTry").checked = !!settings.oneTry;
  document.querySelectorAll('input[name="joinType"]').forEach((x) => { x.checked = x.value === (settings.joinType || "student"); });
  $("practiceDeplete").checked = !!settings.practiceDeplete;
  if (document.activeElement !== $("controlSec")) $("controlSec").value = settings.controlSec;
}
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.onclick = async () => {
    const m = b.dataset.mode;
    if (settings && settings.mode === m) return;
    const msg = m === "event"
      ? "본 행사 모드로 바꿀까요?\n학번 참여, 재고 차감, 1인 1회 제한이 적용돼요.\n지금 대기열은 비워져요."
      : "연습 모드로 바꿀까요?\n지금 대기열은 비워져요.";
    if (!confirm(msg)) return;
    await update(r(), { "settings/mode": m, queue: null });
    flash("setMsg", "모드를 바꿨어요");
  };
});
$("saveSettings").onclick = async () => {
  const sec = Math.max(3, Math.min(60, parseInt($("controlSec").value, 10) || 10));
  const jt = (document.querySelector('input[name="joinType"]:checked') || {}).value || "student";
  const ups = { oneTry: $("oneTry").checked, practiceDeplete: $("practiceDeplete").checked, controlSec: sec, joinType: jt };
  if (settings && jt !== settings.joinType && settings.mode === "event") {
    if (!confirm("참여 방식을 바꾸면 지금 대기열이 비워져요. 바꿀까요?")) return;
    await remove(r("queue"));
  }
  if (jt === "roster" && !Object.keys(roster).length) alert("이름 명단이 비어 있어요. 아래 '이름 명단'에 선생님 이름을 넣고 저장해 주세요.");
  await update(r("settings"), ups);
  flash("setMsg", "저장했어요");
};

// ---------- 재고 ----------
function renderStock() {
  if (!stock) return;
  const s = stock[stockTab] || {};
  const act = activeRanks(s);
  $("rankCount").value = String(act.length);
  const depl = stockTab === "event" || (settings && settings.practiceDeplete);
  const base = act.reduce((a, k) => a + Math.max(0, ((s[k] || {})[depl ? "left" : "total"]) || 0), 0);
  $("stockBody").innerHTML = RANKS.map((k, i) => {
    const it = s[k] || { name: "", total: 0, left: 0 };
    const w = Math.max(0, (depl ? it.left : it.total) || 0);
    const p = base && i < act.length ? ((w / base) * 100).toFixed(1) + "%" : "-";
    return `<tr data-k="${k}" class="${i < act.length ? "" : "off"}">
      <td><span class="rank-chip" style="background:${RANK_COLORS[i + 1]}">${i + 1}등</span></td>
      <td><input type="text" data-f="name" value="${escapeHtml(it.name)}"></td>
      <td><input type="number" min="0" data-f="total" value="${it.total || 0}"></td>
      <td><input type="number" min="0" data-f="left" value="${it.left || 0}"></td>
      <td>${p}</td></tr>`;
  }).join("");
  $("stockBody").querySelectorAll("input").forEach((inp) => inp.oninput = () => { stockDirty = true; });
}
document.querySelectorAll("#stockTabs .tab").forEach((t) => t.onclick = () => {
  if (stockDirty && !confirm("저장하지 않은 변경이 있어요. 버릴까요?")) return;
  stockDirty = false; stockTab = t.dataset.t;
  document.querySelectorAll("#stockTabs .tab").forEach((x) => x.classList.toggle("on", x === t));
  renderStock();
});
$("rankCount").onchange = () => {
  stockDirty = true;
  const n = +$("rankCount").value;
  $("stockBody").querySelectorAll("tr").forEach((tr, i) => tr.classList.toggle("off", i >= n));
};
function readStockForm() {
  const out = { count: +$("rankCount").value || 5 };
  $("stockBody").querySelectorAll("tr").forEach((tr) => {
    const k = tr.dataset.k;
    const g = (f) => tr.querySelector(`[data-f="${f}"]`).value;
    out[k] = { name: g("name").trim() || "-", total: Math.max(0, parseInt(g("total"), 10) || 0), left: Math.max(0, parseInt(g("left"), 10) || 0) };
  });
  return out;
}
$("saveStock").onclick = async () => {
  await set(r("stock/" + stockTab), readStockForm());
  stockDirty = false; renderStock(); flash("stockMsg", "저장했어요");
};
$("refill").onclick = async () => {
  if (!confirm("남은 수량을 모두 총 수량으로 되돌릴까요?")) return;
  const f = readStockForm();
  for (const k of RANKS) if (f[k]) f[k].left = f[k].total;
  await set(r("stock/" + stockTab), f);
  stockDirty = false; renderStock(); flash("stockMsg", "채웠어요");
};

// ---------- 학번 기회 ----------
function fill(sel, n) { sel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join(""); }
fill($("aG"), 3); fill($("aC"), 13); fill($("aN"), 35);
let curGid = null;
const selGid = () => curGid || gidOf($("aG").value, $("aC").value, $("aN").value);
async function lookup() {
  const gid = selGid();
  if (gid.startsWith("T_") && !roster[gid.slice(2)]) {
    $("aInfo").innerHTML = `<span style="color:var(--pink)">명단에 없는 이름이에요: ${escapeHtml(gid.slice(2))}</span>`;
  }
  const a = (await get(r("attempts/" + gid))).val() || {};
  const used = a.used || 0, bonus = a.bonus || 0;
  const last = a.last ? ` · 마지막 결과: <b style="color:${RANK_COLORS[isLose(a.last.prize) ? 5 : a.last.rank]}">${rankText(a.last.rank, a.last.prize)}</b> ${isLose(a.last.prize) ? "" : escapeHtml(a.last.prize)}` : "";
  if (gid.startsWith("T_") && !roster[gid.slice(2)]) return;
  $("aInfo").innerHTML = `<b>${labelOf(gid)}</b> — 참여 ${used}회 / 가능 ${1 + bonus}회 (추가 기회 ${bonus})${last}`;
}
$("aLook").onclick = () => { curGid = null; lookup(); };
["aG", "aC", "aN"].forEach((id) => $(id).onchange = () => { curGid = null; lookup(); });
const byName = () => {
  const k = nameKey($("aName").value);
  if (!k) return;
  curGid = tidOf(k); lookup();
};
$("aLookName").onclick = byName;
$("aName").onkeydown = (e) => { if (e.key === "Enter") byName(); };
$("aPlus").onclick = async () => {
  const gid = selGid();
  await runTransaction(r("attempts/" + gid), (a) => { a = a || {}; a.used = a.used || 0; a.bonus = (a.bonus || 0) + 1; return a; });
  flash("aMsg", labelOf(gid) + "에게 기회 1회를 더 줬어요"); lookup();
};
$("aReset").onclick = async () => {
  const gid = selGid();
  if (!confirm(labelOf(gid) + "의 참여 기록을 지울까요? (다시 참여할 수 있게 돼요)")) return;
  await remove(r("attempts/" + gid));
  flash("aMsg", "초기화했어요"); lookup();
};

// ---------- 대기열 ----------
function renderQueue() {
  const ST = { control: "조종 중", drop: "뽑는 중", result: "결과 발표" };
  $("nowInfo").innerHTML = LANE_IDS.map((id) => {
    const g = lanes[id], info = LANE_INFO[id];
    return `<div class="lane-line"><b style="color:${info.color}">${info.tag}</b> ` +
      (g && g.label ? `<b>${escapeHtml(g.label)}</b> (${ST[g.state] || g.state}) <button class="btn danger" data-skip="${id}">취소</button>` : `<span style="color:var(--muted)">비어 있음</span>`) +
      `</div>`;
  }).join("");
  $("nowInfo").querySelectorAll("[data-skip]").forEach((b) => b.onclick = () => skipLane(b.dataset.skip));
  const list = Object.entries(queue).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  $("qAdmin").innerHTML = list.length
    ? list.map(([k, v]) => `<li>${escapeHtml(v.label)} <small style="color:var(--muted)">${v.mode === "event" ? "본 행사" : "연습"}</small><button class="btn danger" data-k="${escapeHtml(k)}">빼기</button></li>`).join("")
    : `<li style="list-style:none;color:var(--muted);margin-left:-1.4em">대기열이 비어 있어요</li>`;
  $("qAdmin").querySelectorAll("button").forEach((b) => b.onclick = () => remove(r("queue/" + b.dataset.k)));
}
async function skipLane(id) {
  const g = lanes[id];
  if (!g) return;
  if (g.state !== "control") { alert("이미 뽑는 중이라 취소할 수 없어요. 결과가 나올 때까지 기다려 주세요."); return; }
  if (!confirm(`${LANE_INFO[id].tag} ${g.label}의 게임을 취소할까요? (기회는 차감되지 않아요)`)) return;
  await update(r(), { ["lanes/" + id]: null, ["control/" + id]: null });
}
$("clearQueue").onclick = async () => { if (confirm("대기열을 모두 비울까요?")) await remove(r("queue")); };

// ---------- 기록 ----------
function logRows() {
  return Object.values(logs[logTab] || {}).sort((a, b) => (b.at || 0) - (a.at || 0));
}
const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; };
function renderLogs() {
  const rows = logRows();
  const cnt = {};
  rows.forEach((x) => { const t = rankText(x.rank, x.prize); cnt[t] = (cnt[t] || 0) + 1; });
  const order = ["1등", "2등", "3등", "4등", "5등", "꽝"].filter((t) => cnt[t]);
  $("logSummary").innerHTML = `<span class="chip" style="--c:var(--text)">총 ${rows.length}회</span>` +
    order.map((t) => `<span class="chip" style="--c:${RANK_COLORS[t === "꽝" ? 5 : +t[0]]}">${t} ${cnt[t]}</span>`).join("");
  $("logBody").innerHTML = rows.slice(0, 500).map((x) =>
    `<tr><td>${fmt(x.at)}</td><td>${escapeHtml(x.label)}</td><td><span class="rank-chip" style="background:${RANK_COLORS[isLose(x.prize) ? 5 : x.rank]}">${rankText(x.rank, x.prize)}</span></td><td>${escapeHtml(x.prize)}</td></tr>`
  ).join("");
}
document.querySelectorAll("#logTabs .tab").forEach((t) => t.onclick = () => {
  logTab = t.dataset.t;
  document.querySelectorAll("#logTabs .tab").forEach((x) => x.classList.toggle("on", x === t));
  renderLogs();
});
$("csv").onclick = () => {
  const rows = logRows().reverse();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["시간", "학년", "반", "번호", "참여자", "등수", "상품"].map(esc).join(",")];
  for (const x of rows) {
    const [g, c, n] = x.gid && !x.gid.startsWith("T_") ? x.gid.split("-").map(Number) : ["", "", ""];
    lines.push([fmt(x.at), g, c, n, x.label, rankText(x.rank, x.prize), x.prize].map(esc).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `뽑기기록_${logTab === "event" ? "본행사" : "연습"}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$("clearLogs").onclick = async () => {
  if (!confirm(`${logTab === "event" ? "본 행사" : "연습/수업용"} 결과 기록을 모두 지울까요?`)) return;
  await remove(r("logs/" + logTab));
};

// ---------- 전체 초기화 ----------
$("fullReset").onclick = async () => {
  if ($("resetConfirm").value.trim() !== "초기화") { flash("resetMsg", "'초기화'라고 입력해 주세요", true); return; }
  const ev = (await get(r("stock/event"))).val() || {};
  const ups = { attempts: null, "logs/event": null, queue: null, lanes: null, control: null };
  for (const k of RANKS) if (ev[k]) ups[`stock/event/${k}/left`] = ev[k].total || 0;
  await update(r(), ups);
  $("resetConfirm").value = "";
  stockDirty = false; renderStock();
  flash("resetMsg", "본 행사 데이터를 초기화했어요");
};

// ---------- 이름 명단 ----------
function rosterNames() {
  return Object.entries(roster).map(([k, v]) => (typeof v === "string" ? v : k)).sort((a, b) => a.localeCompare(b, "ko"));
}
function renderRoster() {
  const names = rosterNames();
  $("rosterText").value = names.join("\n");
  $("rosterCount").textContent = `현재 ${names.length}명`;
}
$("rosterText").oninput = () => { rosterDirty = true; };
$("saveRoster").onclick = async () => {
  const lines = $("rosterText").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const map = {}, dup = [];
  for (const nm of lines) {
    const k = nameKey(nm);
    if (!k) continue;
    if (map[k]) dup.push(nm); else map[k] = nm;
  }
  if (dup.length) {
    alert("같은 이름이 있어요: " + [...new Set(dup)].join(", ") + "\n김개포1, 김개포2처럼 숫자를 붙여서 다시 저장해 주세요.");
    return;
  }
  if (!confirm(`명단을 ${Object.keys(map).length}명으로 저장할까요? (기존 명단은 바뀌어요)`)) return;
  await set(r("roster"), Object.keys(map).length ? map : null);
  rosterDirty = false; renderRoster();
  flash("rosterMsg", "저장했어요");
};
