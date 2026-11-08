// 폰 조종기
import {
  r, watch, get, set, update, onDisconnect, now,
  RANK_COLORS, LANE_IDS, LANE_INFO, depletes, leftTotal, gidOf, labelOf, LOSE_LINES, safeStore, escapeHtml
} from "./db.js";

const $ = (id) => document.getElementById(id);
const ls = safeStore("localStorage"), ss = safeStore("sessionStorage");
const CLIENT = ls.getItem("clientId") || Math.random().toString(36).slice(2, 12);
ls.setItem("clientId", CLIENT);

let settings = null, current = null, queue = {}, stock = null, connected = false;
let lanes = {}, myLane = null;   // current = 내가 들어가 있는 구역의 게임
let ui = "loading";
let me = null;            // { key, label, gid, mode, joinedAt }
let lastResult = null;    // { rank, prize, at }
let missingTimer = null, timerInt = null, clockInt = null, grabbed = false;
let turnSeen = 0;          // 이미 처리한 차례(startedAt) — 같은 기기로 여러 번 할 때 구분

try { me = JSON.parse(ss.getItem("me") || "null"); } catch (e) { me = null; }
const saveMe = () => ss.setItem("me", JSON.stringify(me));

function show(v) {
  ui = v;
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("on", el.id === "v-" + v));
  clearInterval(timerInt); timerInt = null;
  if (v !== "result") { clearInterval(clockInt); clockInt = null; }
  if (v === "turn") startTurnUI();
}

// ---------- 참여 폼 ----------
function fillSelect(sel, n, pad = false) {
  sel.innerHTML = `<option value="">-</option>` + Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
}
fillSelect($("selG"), 3); fillSelect($("selC"), 13); fillSelect($("selN"), 35);
const lastSel = (() => { try { return JSON.parse(ls.getItem("lastSel") || "null"); } catch (e) { return null; } })();
if (lastSel) { $("selG").value = lastSel.g; $("selC").value = lastSel.c; $("selN").value = lastSel.n; }
$("nick").value = ls.getItem("nick") || "";

function renderJoinForm() {
  const ev = settings && settings.mode === "event";
  $("joinEvent").classList.toggle("hidden", !ev);
  $("joinPractice").classList.toggle("hidden", ev);
  $("joinTitle").textContent = ev ? "학번을 선택하세요" : "닉네임을 입력하세요";
  $("joinHint").textContent = ev
    ? (settings.oneTry ? "한 사람당 한 번만 할 수 있어요. 친구 학번으로 하면 그 친구의 기회가 사라져요!" : "지금은 여러 번 참여할 수 있어요.")
    : "연습 모드예요. 몇 번이든 할 수 있어요!";
}

function setMsg(t, ok = false) { const m = $("joinMsg"); m.textContent = t || ""; m.className = "msg" + (ok ? " ok" : ""); }

function isSoldOut() {
  return settings && stock && depletes(settings, settings.mode) && leftTotal(stock[settings.mode]) <= 0;
}

async function join() {
  if (!settings) return;
  setMsg("");
  if (isSoldOut()) return show("soldout");
  const btn = $("joinBtn"); btn.disabled = true;
  try {
    let info;
    if (settings.mode === "event") {
      const g = $("selG").value, c = $("selC").value, n = $("selN").value;
      if (!g || !c || !n) { setMsg("학년, 반, 번호를 모두 골라 주세요"); return; }
      ls.setItem("lastSel", JSON.stringify({ g, c, n }));
      const gid = gidOf(g, c, n);
      info = { key: "S" + gid, label: labelOf(gid), gid, mode: "event" };
      if (settings.oneTry) {
        const a = (await get(r("attempts/" + gid))).val() || {};
        if ((a.used || 0) >= 1 + (a.bonus || 0)) {
          $("doneWho").textContent = info.label;
          $("doneLast").innerHTML = a.last
            ? `내 결과: <b style="color:${RANK_COLORS[a.last.rank]}">${a.last.rank === 5 ? "꽝" : a.last.rank + "등"}</b> ${a.last.rank === 5 ? "" : escapeHtml(a.last.prize)}`
            : "";
          return show("done");
        }
      }
    } else {
      const nick = $("nick").value.trim().replace(/[.#$\[\]\/]/g, "");
      if (!nick) { setMsg("닉네임을 입력해 주세요"); return; }
      ls.setItem("nick", nick);
      info = { key: "P" + CLIENT, label: nick, gid: null, mode: "practice" };
    }
    if ((queue && queue[info.key]) || LANE_IDS.some((id) => lanes[id] && lanes[id].qkey === info.key)) {
      setMsg(settings.mode === "event" ? "이 학번은 이미 대기 중이에요" : "이미 대기 중이에요");
      return;
    }
    me = { ...info, joinedAt: now() };
    lastResult = null;
    saveMe();
    await enqueue();
    show("wait");
    renderWait();
  } catch (e) {
    console.error(e); setMsg("연결에 문제가 있어요. 다시 시도해 주세요.");
  } finally { btn.disabled = false; }
}

async function enqueue() {
  const qr = r("queue/" + me.key);
  await set(qr, { label: me.label, gid: me.gid, mode: me.mode, joinedAt: me.joinedAt });
  onDisconnect(qr).remove();
}

$("joinBtn").onclick = join;
$("leaveBtn").onclick = async () => {
  if (me) { try { await set(r("queue/" + me.key), null); } catch (e) {} }
  me = null; saveMe(); show("join");
};
$("doneBack").onclick = () => show("join");
$("againBtn").onclick = () => { show("join"); join(); };

// ---------- 대기 ----------
function renderWait() {
  if (!me) return;
  $("waitWho").textContent = me.label;
  const list = Object.entries(queue || {})
    .filter(([, v]) => v && v.mode === me.mode)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const idx = list.findIndex(([k]) => k === me.key);
  const ahead = idx < 0 ? list.length : idx;
  const pos = $("waitPos");
  pos.textContent = ahead;
  pos.classList.toggle("next", ahead === 0);
  $("waitText").textContent = ahead === 0 ? "곧 내 차례! 준비하세요" : "명이 앞에서 기다리고 있어요";
}

// ---------- 조종 ----------
let dirNow = 0;
function sendDir(d) {
  if (ui !== "turn" || grabbed || d === dirNow) return;
  dirNow = d;
  update(r("control/" + myLane), { dir: d }).catch(console.error);
}
function bindHold(el, d) {
  const on = (e) => { e.preventDefault(); el.classList.add("down"); try { el.setPointerCapture(e.pointerId); } catch (_) {} sendDir(d); navigator.vibrate?.(15); };
  const off = (e) => { el.classList.remove("down"); if (dirNow === d) sendDir(0); };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointercancel", off);
  el.addEventListener("lostpointercapture", off);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
bindHold($("btnL"), -1);
bindHold($("btnR"), 1);
$("btnGrab").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (ui !== "turn" || grabbed) return;
  grabbed = true; dirNow = 0;
  $("btnGrab").disabled = true;
  navigator.vibrate?.([40, 30, 80]);
  update(r("control/" + myLane), { dir: 0, grab: now() }).catch(console.error);
});

function startTurnUI() {
  grabbed = false; dirNow = 0;
  $("btnGrab").disabled = false;
  const info = LANE_INFO[myLane] || LANE_INFO.L;
  const lt = $("laneTag");
  lt.textContent = `${info.tag} · ${info.side} 집게`;
  lt.style.color = info.color; lt.style.borderColor = info.color;
  document.querySelector("#v-turn").style.setProperty("--lane", info.color);
  navigator.vibrate?.([200, 100, 200, 100, 300]);
  const tick = () => {
    if (!current || !current.endsAt) return;
    const sec = Math.max(0, Math.ceil((current.endsAt - now()) / 1000));
    const el = $("turnTimer");
    el.textContent = sec;
    el.classList.toggle("warn", sec <= 3);
  };
  tick();
  timerInt = setInterval(tick, 100);
}

// ---------- 결과 ----------
async function showResult(res) {
  lastResult = res;
  show("result");
  const color = RANK_COLORS[res.rank] || "#9aa0b4";
  $("resCard").style.setProperty("--c", color);
  $("resWho").textContent = me ? me.label : "";
  if (res.rank === 0) { $("resRank").textContent = "SOLD OUT"; $("resPrize").textContent = "캡슐이 모두 소진되었어요"; }
  else if (res.rank === 5) { $("resRank").textContent = "꽝!"; $("resPrize").textContent = LOSE_LINES[(Math.random() * LOSE_LINES.length) | 0]; }
  else { $("resRank").textContent = res.rank + "등!"; $("resPrize").textContent = res.prize; }
  const isEvent = me && me.mode === "event";
  $("resNote").textContent = isEvent && res.rank >= 1 && res.rank <= 4 ? "이 화면을 선생님께 보여주세요!" : isEvent ? "참여해 줘서 고마워요!" : "연습 모드 결과예요";
  navigator.vibrate?.(res.rank === 1 ? [300, 100, 300, 100, 600] : [150]);
  const clock = () => {
    const d = new Date();
    $("resClock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };
  clock(); clearInterval(clockInt); clockInt = setInterval(clock, 1000);

  // 한 번 더 할 수 있는지
  let canAgain = !isEvent;
  if (isEvent && me.gid) {
    if (!settings.oneTry) canAgain = true;
    else {
      try {
        await new Promise((res2) => setTimeout(res2, 800));
        const a = (await get(r("attempts/" + me.gid))).val() || {};
        canAgain = (a.used || 0) < 1 + (a.bonus || 0);
      } catch (e) {}
    }
  }
  $("againBtn").classList.toggle("hidden", !canAgain || isSoldOut());
}

// ---------- 동기화 ----------
function sync() {
  if (!settings) return;
  const tag = $("modeTag");
  tag.className = "mode-tag " + settings.mode;
  tag.textContent = settings.mode === "event" ? "★ 본 행사" : "연습 모드";

  if (ui === "loading") {
    // 새로고침 복구
    if (me && me.mode === settings.mode) {
      show("wait");
      if (!(current && current.qkey === me.key)) enqueue().catch(console.error);
    } else { me = null; saveMe(); renderJoinForm(); show("join"); }
  }

  const mine = me && current && current.qkey === me.key;
  if (mine) {
    clearTimeout(missingTimer); missingTimer = null;
    if (current.capColor) document.documentElement.style.setProperty("--capc", current.capColor);
    if (current.state === "control" && current.startedAt !== turnSeen) { turnSeen = current.startedAt; show("turn"); }
    else if (current.state === "drop" && ui !== "drop") show("drop");
    else if (current.state === "result" && ui !== "result" && current.rank !== undefined) {
      showResult({ rank: current.rank, prize: current.prize, at: current.at });
      ss.setItem("me", "null"); // 새로고침해도 다시 줄 서지 않게
    }
    return;
  }

  if (ui === "turn" || ui === "drop") {
    // 게임이 중간에 취소됨(관리자)
    show("join"); renderJoinForm(); setMsg("게임이 취소되었어요. 다시 참여해 주세요.");
    return;
  }

  if (ui === "join") renderJoinForm();

  if (ui === "wait") {
    if (me.mode !== settings.mode) { me = null; saveMe(); show("join"); renderJoinForm(); setMsg("운영 모드가 바뀌었어요. 다시 참여해 주세요."); return; }
    if (isSoldOut()) { show("soldout"); return; }
    renderWait();
    if (!queue[me.key] && connected) {
      if (!missingTimer) missingTimer = setTimeout(() => {
        missingTimer = null;
        if (ui === "wait" && me && !queue[me.key] && !(current && current.qkey === me.key)) {
          me = null; saveMe(); show("join"); renderJoinForm(); setMsg("대기열에서 빠졌어요. 다시 참여해 주세요.");
        }
      }, 2500);
    } else { clearTimeout(missingTimer); missingTimer = null; }
  }

  if (ui === "join" && isSoldOut()) show("soldout");
  if (ui === "soldout" && !isSoldOut()) { show("join"); renderJoinForm(); }
}

watch("settings", (v) => { settings = v; sync(); });
watch("lanes", (v) => {
  lanes = v || {};
  myLane = me ? LANE_IDS.find((id) => lanes[id] && lanes[id].qkey === me.key) || null : null;
  current = myLane ? lanes[myLane] : null;
  sync();
});
watch("queue", (v) => { queue = v || {}; sync(); });
watch("stock", (v) => { stock = v; sync(); });
watch(".info/connected", (v) => {
  const was = connected; connected = !!v;
  // 화면이 꺼졌다 켜져서 다시 연결되면, 원래 순서 그대로 대기열에 복귀
  if (connected && !was && ui === "wait" && me && !(current && current.qkey === me.key)) {
    enqueue().catch(console.error);
  }
  sync();
});
