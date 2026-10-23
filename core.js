/* 제안·공감·투표 규칙 — 연습 모드(이 기기)와 구글 시트 서버가 똑같이 씁니다.
 * 고치면 apps-script/Code.gs 아래쪽의 같은 부분도 똑같이 고쳐 주세요. */
const CORE_PHASES = ["propose", "vote", "result"];
const CORE_DEFAULTS = { phase: "propose", threshold: 5, voteMax: 1 };
const CORE_MAX_IMAGES = 3; // 제안 하나에 붙일 수 있는 사진 수

function core_clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim().slice(0, max);
}

function core_likeCounts(db) {
  const n = {};
  db.likes.forEach(l => { n[l.pid] = (n[l.pid] || 0) + 1; });
  return n;
}

function core_candidates(db) {
  const n = core_likeCounts(db);
  return db.proposals.filter(p => (n[p.id] || 0) >= db.settings.threshold).map(p => p.id);
}

// 화면에 보낼 내용. 누가 무엇에 투표했는지는 절대 보내지 않아요.
function core_state(db, name, isTeacher, needCode, keyFn) {
  const s = db.settings;
  const likes = core_likeCounts(db);
  const cc = {};
  db.comments.forEach(c => { cc[c.pid] = (cc[c.pid] || 0) + 1; });
  const myKey = name ? keyFn(name) : null;
  const mine = db.votes.find(v => v.key === myKey);
  let results = null;
  if (s.phase === "result" || isTeacher) {
    results = {};
    db.votes.forEach(v => v.picks.forEach(p => { results[p] = (results[p] || 0) + 1; }));
  }
  return {
    ok: true,
    settings: { phase: s.phase, threshold: s.threshold, voteMax: s.voteMax },
    proposals: db.proposals.map(p => Object.assign({}, p, { likes: likes[p.id] || 0, comments: cc[p.id] || 0 })),
    comments: db.comments,
    myLikes: name ? db.likes.filter(l => l.name === name).map(l => l.pid) : [],
    myVote: mine ? mine.picks : null,
    voters: db.votes.length,
    results,
    teacher: !!isTeacher,
    needCode: !!needCode,
  };
}

// 제안을 올리기 전에 미리 확인해요 (사진을 저장하기 전에 쓰려고요)
function core_checkPropose(db, b) {
  if (!core_clean(b.name, 20)) return "이름을 적어 주세요.";
  if (db.settings.phase !== "propose") return "지금은 제안 기간이 아니에요.";
  if (!core_clean(b.title, 40) || !core_clean(b.body, 800)) return "제목과 내용을 모두 적어 주세요.";
  if (!core_clean(b.dong, 20)) return "제안할 동을 골라 주세요.";
  return "";
}

// 제안을 고치기 전에 미리 확인해요 (쓴 사람만, 제안 기간에만)
function core_checkEdit(db, b, isTeacher) {
  const p = db.proposals.find(x => x.id === b.pid);
  if (!p) return "지워진 제안이에요.";
  const name = core_clean(b.name, 20);
  if (!isTeacher && !(name && p.author === name)) return "내가 쓴 제안만 고칠 수 있어요.";
  if (db.settings.phase !== "propose") return "제안 기간이 끝나서 고칠 수 없어요.";
  if (!core_clean(b.title, 40) || !core_clean(b.body, 800)) return "제목과 내용을 모두 적어 주세요.";
  if (!core_clean(b.dong, 20)) return "제안할 동을 골라 주세요.";
  return "";
}
// 고칠 때 남겨 둘 기존 사진 (원래 이 제안에 있던 사진만)
function core_keptImages(p, keep) {
  const had = p.images || [];
  return (Array.isArray(keep) ? keep : []).filter((x, i, a) => had.indexOf(x) >= 0 && a.indexOf(x) === i);
}

// 요청 하나를 처리해요. 바뀐 표 이름을 touched 에 담아 돌려줘요.
function core_apply(db, b, isTeacher, keyFn) {
  const s = db.settings;
  const name = core_clean(b.name, 20);
  const fail = msg => ({ ok: false, error: msg });
  const needName = ["propose", "like", "comment", "vote"].indexOf(b.action) >= 0;
  if (needName && !name) return fail("이름을 적어 주세요.");
  const find = pid => db.proposals.find(p => p.id === pid);

  switch (b.action) {
    case "propose": {
      const bad = core_checkPropose(db, b);
      if (bad) return fail(bad);
      const title = core_clean(b.title, 40), body = core_clean(b.body, 800);
      const dong = core_clean(b.dong, 20), category = core_clean(b.category, 20);
      const images = (Array.isArray(b.images) ? b.images : []).filter(x => typeof x === "string" && x).slice(0, CORE_MAX_IMAGES);
      const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.proposals.push({ id, category, dong, title, body, author: name, createdAt: Date.now(), images });
      return { ok: true, id, touched: ["proposals"] };
    }
    case "editProposal": {
      const bad = core_checkEdit(db, b, isTeacher);
      if (bad) return fail(bad);
      const p = find(b.pid);
      const keep = core_keptImages(p, b.keep);
      const added = (Array.isArray(b.added) ? b.added : []).filter(x => typeof x === "string" && x);
      const removed = (p.images || []).filter(x => keep.indexOf(x) < 0);
      p.title = core_clean(b.title, 40); p.body = core_clean(b.body, 800);
      p.dong = core_clean(b.dong, 20); p.category = core_clean(b.category, 20);
      p.images = keep.concat(added).slice(0, CORE_MAX_IMAGES);
      p.editedAt = Date.now();
      return { ok: true, removed, touched: ["proposals"] };
    }
    case "like": {
      if (s.phase !== "propose") return fail("공감 기간이 끝났어요.");
      if (!find(b.pid)) return fail("지워진 제안이에요.");
      const i = db.likes.findIndex(l => l.pid === b.pid && l.name === name);
      if (i >= 0) db.likes.splice(i, 1);
      else db.likes.push({ pid: b.pid, name, at: Date.now() });
      return { ok: true, liked: i < 0, touched: ["likes"] };
    }
    case "comment": {
      const text = core_clean(b.text, 300);
      if (!text) return fail("댓글 내용을 적어 주세요.");
      if (!find(b.pid)) return fail("지워진 제안이에요.");
      const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.comments.push({ id, pid: b.pid, author: name, text, createdAt: Date.now() });
      return { ok: true, touched: ["comments"] };
    }
    case "vote": {
      if (s.phase !== "vote") return fail("지금은 투표 기간이 아니에요.");
      const cands = core_candidates(db);
      const picks = (Array.isArray(b.picks) ? b.picks : []).filter((p, i, a) => a.indexOf(p) === i);
      if (!picks.length) return fail("제안을 하나 이상 골라 주세요.");
      if (picks.length > s.voteMax) return fail(s.voteMax + "개까지만 고를 수 있어요.");
      if (picks.some(p => cands.indexOf(p) < 0)) return fail("투표 후보가 아닌 제안이 있어요. 새로고침해 주세요.");
      const key = keyFn(name);
      db.votes = db.votes.filter(v => v.key !== key);
      db.votes.push({ key, picks, at: Date.now() });
      return { ok: true, touched: ["votes"] };
    }
    case "deleteProposal": {
      const p = find(b.pid);
      if (!p) return { ok: true, touched: [] };
      if (!isTeacher && !(name && p.author === name && s.phase === "propose")) return fail("이 제안은 지울 수 없어요.");
      db.proposals = db.proposals.filter(x => x.id !== b.pid);
      db.likes = db.likes.filter(x => x.pid !== b.pid);
      db.comments = db.comments.filter(x => x.pid !== b.pid);
      return { ok: true, touched: ["proposals", "likes", "comments"] };
    }
    case "deleteComment": {
      const c = db.comments.find(x => x.id === b.cid);
      if (!c) return { ok: true, touched: [] };
      if (!isTeacher && !(name && c.author === name)) return fail("이 댓글은 지울 수 없어요.");
      db.comments = db.comments.filter(x => x.id !== b.cid);
      return { ok: true, touched: ["comments"] };
    }
    case "settings": {
      if (!isTeacher) return fail("선생님만 바꿀 수 있어요.");
      if (CORE_PHASES.indexOf(b.phase) >= 0) s.phase = b.phase;
      const t = parseInt(b.threshold, 10), m = parseInt(b.voteMax, 10);
      if (t >= 1 && t <= 100) s.threshold = t;
      if (m >= 1 && m <= 10) s.voteMax = m;
      return { ok: true, touched: ["settings"] };
    }
    case "resetVotes": {
      if (!isTeacher) return fail("선생님만 할 수 있어요.");
      db.votes = [];
      return { ok: true, touched: ["votes"] };
    }
  }
  return fail("알 수 없는 요청이에요.");
}
