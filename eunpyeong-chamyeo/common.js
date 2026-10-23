/* 학생 화면과 교사 화면이 함께 쓰는 코드 (core.js 다음에 불러와요) */
const CFG = window.APP_CONFIG;
const PHASE_NAMES = { propose: "제안 받는 중", vote: "투표 진행 중", result: "결과 발표" };

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (isNaN(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

let toastTimer;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

const HEART_SVG = '<svg class="ico heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.3 8.4 2.2 4 6.3 4c2.3 0 3.9 1.3 5.7 3.4C13.8 5.3 15.4 4 17.7 4 21.8 4 23.7 8.4 22 11.7 19.5 16.4 12 21 12 21z"/></svg>';
const BUBBLE_SVG = '<svg class="ico bubble" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v14H8l-5 4z"/><rect x="7" y="8" width="10" height="2" fill="var(--surface)"/><rect x="7" y="11.5" width="6" height="2" fill="var(--surface)"/></svg>';
const BRAND_SVG = '<svg width="36" height="36" viewBox="0 0 34 34" aria-hidden="true"><circle cx="11" cy="15" r="9" fill="var(--leaf)"/><circle cx="22" cy="12" r="10" fill="var(--accent)"/><rect x="15.5" y="18" width="3" height="14" rx="1.5" fill="var(--fg)"/></svg>';

/* ---------- 저장소 ----------
 * apiUrl 이 있으면 구글 시트, 없으면 이 기기(localStorage)에 저장 */
const LocalServer = {
  key: "eunpyeong-chamyeo:local-v1",
  password: "1234", // 연습 모드의 교사 비밀번호
  load() {
    let db;
    try { db = JSON.parse(localStorage.getItem(this.key)); } catch (e) {}
    db = db || {};
    return {
      proposals: db.proposals || [], likes: db.likes || [], comments: db.comments || [], votes: db.votes || [],
      settings: Object.assign({}, CORE_DEFAULTS, db.settings || {}),
    };
  },
  save(db) { try { localStorage.setItem(this.key, JSON.stringify(db)); } catch (e) {} },
  // 연습 모드에서는 이름을 간단히 섞어서 투표자 표시로 써요
  keyOf(name) {
    let h = 0x811c9dc5;
    for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return "v" + h.toString(16);
  },
  handle(b) {
    if (b.pw && b.pw !== this.password) return { ok: false, error: "선생님 비밀번호가 맞지 않아요.", code: "badpw" };
    const isTeacher = !!b.pw;
    const db = this.load();
    if (b.action === "state") return core_state(db, core_clean(b.name, 20), isTeacher, false, n => this.keyOf(n));
    if (b.action === "checkCode") return { ok: true };
    const res = core_apply(db, b, isTeacher, n => this.keyOf(n));
    if (res.ok) this.save(db);
    return res;
  },
};

const Api = {
  isLocal: !CFG.apiUrl,
  async call(body) {
    if (this.isLocal) return JSON.parse(JSON.stringify(LocalServer.handle(body)));
    // text/plain 으로 보내야 Apps Script 에서 막히지 않아요
    const res = await fetch(CFG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

// 화면이 보일 때만 주기적으로 새로고침 (Apps Script 사용량을 아껴요)
function startPolling(fn) {
  setInterval(() => { if (document.visibilityState === "visible") fn(); }, Math.max(5, CFG.refreshSeconds || 15) * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fn(); });
  if (Api.isLocal) addEventListener("storage", e => { if (e.key === LocalServer.key) fn(); });
}

// 투표 순위 (같은 표면 같은 순위)
function rankProposals(state) {
  const n = state.results || {};
  const list = state.proposals.filter(p => p.likes >= state.settings.threshold)
    .map(p => ({ p, v: n[p.id] || 0 })).sort((a, b) => b.v - a.v || a.p.createdAt - b.p.createdAt);
  let rank = 0, prev = -1;
  list.forEach((r, i) => { if (r.v !== prev) { rank = i + 1; prev = r.v; } r.rank = rank; });
  return list;
}

function fillSiteText() {
  document.querySelectorAll("[data-site-name]").forEach(el => { el.textContent = CFG.siteName; });
  document.querySelectorAll("[data-region]").forEach(el => { el.textContent = CFG.regionName; });
  document.querySelectorAll("[data-mode-note]").forEach(el => {
    el.textContent = Api.isLocal ? "연습 모드: 이 기기에만 저장돼요. 다른 기기와 공유되지 않아요." : "";
    el.hidden = !Api.isLocal;
  });
}
document.addEventListener("DOMContentLoaded", fillSiteText);
