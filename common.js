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
const CAMERA_SVG = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="var(--muted)"><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 11a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0-2a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
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
  save(db) { try { localStorage.setItem(this.key, JSON.stringify(db)); return true; } catch (e) { return false; } },
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
    // 연습 모드에서는 사진을 글자(data URL)로 바꿔 이 기기에 그대로 저장해요
    if (b.action === "image") return { ok: true, data: b.id };
    if (b.action === "editProposal") b.added = Array.isArray(b.images) ? b.images : [];
    const res = core_apply(db, b, isTeacher, n => this.keyOf(n));
    if (res.ok && !this.save(db)) return { ok: false, error: "이 기기의 저장 공간이 가득 찼어요. 사진을 줄이거나 다른 제안을 지워 주세요." };
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

/* ---------- 사진 ---------- */
// 올리기 전에 크기를 줄여요 (긴 쪽 1280px, 연습 모드는 800px)
function resizeImage(file) {
  const max = Api.isLocal ? 800 : 1280, quality = Api.isLocal ? 0.7 : 0.82;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // 투명한 PNG 바탕을 흰색으로
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이 사진은 열 수 없어요. JPG나 PNG 사진으로 올려 주세요.")); };
    img.src = url;
  });
}

// 사진 불러오기 (한 번 불러온 사진은 기억해 둬요)
const imageCache = {};
function loadImage(id) {
  if (!imageCache[id]) {
    imageCache[id] = Api.call({ action: "image", id }).then(r => {
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }).catch(e => { delete imageCache[id]; throw e; });
  }
  return imageCache[id];
}
// 화면의 [data-img] 칸에 사진을 채워요
function fillImages(root) {
  (root || document).querySelectorAll("[data-img]:not([data-loaded])").forEach(el => {
    el.setAttribute("data-loaded", "1");
    loadImage(el.dataset.img).then(src => {
      const img = new Image();
      img.src = src; img.alt = el.dataset.alt || "첨부 사진";
      el.innerHTML = ""; el.appendChild(img);
      el.classList.add("ready");
    }).catch(() => { el.textContent = "사진을 불러오지 못했어요"; el.removeAttribute("data-loaded"); });
  });
}
// 사진 크게 보기
function showPhoto(src) {
  const ov = document.createElement("div");
  ov.className = "overlay photo-view";
  ov.innerHTML = `<img alt="첨부 사진 크게 보기"><button class="btn ghost small" type="button">닫기</button>`;
  ov.querySelector("img").src = src;
  const close = () => ov.remove();
  ov.onclick = close;
  ov.tabIndex = -1; ov.onkeydown = e => { if (e.key === "Escape") close(); };
  document.body.appendChild(ov); ov.focus();
}
document.addEventListener("click", e => {
  const el = e.target.closest("[data-img].ready");
  if (el) loadImage(el.dataset.img).then(showPhoto);
});

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
