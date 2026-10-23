/**
 * 은평 어린이 참여마당 — 저장용 구글 Apps Script
 * 구글 시트 > 확장 프로그램 > Apps Script 에 이 내용을 통째로 붙여넣고
 * '배포 > 새 배포 > 웹 앱'(액세스: 모든 사용자)으로 배포하세요.
 */

// ▼ 꼭 바꿔 주세요
const TEACHER_PASSWORD = '1234';   // 교사 화면 비밀번호 (학생에게 알려 주지 마세요)
const JOIN_CODE = '0000';          // 학생이 처음에 넣는 참여 코드 (''로 비우면 코드 없이 참여)
const SALT = 'eunpyeong-' + 'change-me'; // 아무 글자로나 바꿔 두면 투표자 이름을 더 알아보기 어려워져요

const TABLES = {
  proposals: { sheet: '제안', cols: ['id', 'category', 'dong', 'title', 'body', 'author', 'createdAt', 'images'],
    headers: ['번호', '분류', '동', '제목', '내용', '작성자', '작성 시각', '사진(드라이브 파일 ID)'] },
  likes: { sheet: '공감', cols: ['pid', 'name', 'at'], headers: ['제안 번호', '이름', '시각'] },
  comments: { sheet: '댓글', cols: ['id', 'pid', 'author', 'text', 'createdAt'],
    headers: ['번호', '제안 번호', '작성자', '내용', '작성 시각'] },
  votes: { sheet: '투표', cols: ['key', 'picks', 'at'], headers: ['투표자(암호)', '고른 제안 번호', '시각'] },
};
const TIME_COLS = ['createdAt', 'at'];
const JSON_COLS = ['picks', 'images'];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const CACHE_KEY = 'db-v1';

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function loadFromSheets_() {
  const db = {};
  Object.keys(TABLES).forEach(t => {
    const T = TABLES[t];
    const rows = sheet_(T.sheet, T.headers).getDataRange().getValues().slice(1);
    db[t] = rows.filter(r => r[0] !== '').map(r => {
      const o = {};
      T.cols.forEach((c, i) => {
        let v = r[i];
        if (TIME_COLS.indexOf(c) >= 0) v = v instanceof Date ? v.getTime() : Number(v) || 0;
        else if (JSON_COLS.indexOf(c) >= 0) { try { v = JSON.parse(v) || []; } catch (e) { v = []; } }
        else v = String(v);
        o[c] = v;
      });
      return o;
    });
  });
  const st = sheet_('설정', ['항목', '값']).getDataRange().getValues().slice(1);
  const s = Object.assign({}, CORE_DEFAULTS);
  st.forEach(r => {
    if (r[0] === 'phase' && CORE_PHASES.indexOf(String(r[1])) >= 0) s.phase = String(r[1]);
    if (r[0] === 'threshold') s.threshold = Number(r[1]) || CORE_DEFAULTS.threshold;
    if (r[0] === 'voteMax') s.voteMax = Number(r[1]) || CORE_DEFAULTS.voteMax;
  });
  db.settings = s;
  return db;
}

function save_(db, touched) {
  touched.forEach(t => {
    if (t === 'settings') {
      const sh = sheet_('설정', ['항목', '값']);
      sh.clearContents();
      sh.getRange(1, 1, 4, 2).setValues([['항목', '값'], ['phase', db.settings.phase],
        ['threshold', db.settings.threshold], ['voteMax', db.settings.voteMax]]);
      return;
    }
    const T = TABLES[t];
    const sh = sheet_(T.sheet, T.headers);
    sh.clearContents();
    const rows = [T.headers].concat(db[t].map(o => T.cols.map(c =>
      TIME_COLS.indexOf(c) >= 0 ? new Date(o[c]) : JSON_COLS.indexOf(c) >= 0 ? JSON.stringify(o[c] || []) : String(o[c]))));
    T.cols.forEach((c, i) => {
      if (TIME_COLS.indexOf(c) < 0) sh.getRange(1, i + 1, rows.length, 1).setNumberFormat('@');
    });
    sh.getRange(1, 1, rows.length, T.cols.length).setValues(rows);
  });
  cachePut_(db);
}

// 시트를 매번 읽지 않도록 20초 동안 기억해 둬요 (시트를 직접 고치면 20초 뒤에 반영돼요)
function load_() {
  const c = CacheService.getScriptCache().get(CACHE_KEY);
  if (c) { try { return JSON.parse(c); } catch (e) {} }
  const db = loadFromSheets_();
  cachePut_(db);
  return db;
}
function cachePut_(db) {
  try { CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(db), 20); }
  catch (e) { CacheService.getScriptCache().remove(CACHE_KEY); } // 너무 크면 기억하지 않아요
}

function key_(name) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SALT + '|' + name, Utilities.Charset.UTF_8);
  return 'v' + bytes.slice(0, 10).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/* ---------- 사진: 선생님 구글 드라이브의 '참여마당 사진' 폴더에 저장 ---------- */
function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('참여마당 사진');
  props.setProperty('PHOTO_FOLDER', f.getId());
  return f;
}
function saveImages_(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const folder = photoFolder_();
  return list.slice(0, CORE_MAX_IMAGES).map((d, i) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(d));
    if (!m) throw new Error('사진 형식이 올바르지 않아요.');
    const bytes = Utilities.base64Decode(m[2]);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('사진이 너무 커요.');
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    return folder.createFile(Utilities.newBlob(bytes, m[1], 'photo-' + Date.now() + '-' + i + '.' + ext)).getId();
  });
}
function trashImages_(ids) {
  (ids || []).forEach(id => { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} });
}
// 사진은 제안에 붙어 있는 것만 보여 줘요 (드라이브의 다른 파일은 절대 열지 않아요)
function imageData_(id) {
  const db = load_();
  if (!db.proposals.some(p => (p.images || []).indexOf(id) >= 0)) return { ok: false, error: '사진을 찾을 수 없어요.' };
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function doGet() {
  return json_({ ok: true, message: '참여마당 서버가 동작 중이에요.' });
}

function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '요청을 읽지 못했어요.' }); }
  const isTeacher = !!b.pw && String(b.pw) === TEACHER_PASSWORD;
  if (b.pw && !isTeacher) return json_({ ok: false, error: '선생님 비밀번호가 맞지 않아요.', code: 'badpw' });

  if (b.action === 'state') {
    return json_(core_state(load_(), core_clean(b.name, 20), isTeacher, JOIN_CODE !== '', key_));
  }
  if (b.action === 'image') {
    try { return json_(imageData_(String(b.id || ''))); }
    catch (err) { return json_({ ok: false, error: '사진을 불러오지 못했어요.' }); }
  }
  if (!isTeacher && JOIN_CODE !== '' && String(b.code || '') !== JOIN_CODE) {
    return json_({ ok: false, error: '참여 코드가 맞지 않아요.', code: 'badcode' });
  }
  if (b.action === 'checkCode') return json_({ ok: true });

  // 사진은 시간이 걸려서, 먼저 확인하고 드라이브에 저장한 뒤 제안을 기록해요
  let saved = [];
  if (b.action === 'propose') {
    const bad = core_checkPropose(load_(), b);
    if (bad) return json_({ ok: false, error: bad });
    try { saved = saveImages_(b.images); }
    catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
    b.images = saved;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const db = loadFromSheets_(); // 쓰기 전에는 항상 시트에서 새로 읽어요
    const gone = b.action === 'deleteProposal' ? ((db.proposals.find(p => p.id === b.pid) || {}).images || []) : [];
    const res = core_apply(db, b, isTeacher, key_);
    if (res.ok && res.touched && res.touched.length) save_(db, res.touched);
    if (!res.ok) trashImages_(saved);
    if (res.ok && gone.length) trashImages_(gone);
    return json_(res);
  } catch (err) {
    trashImages_(saved);
    return json_({ ok: false, error: '저장 중 문제가 생겼어요: ' + err });
  } finally {
    lock.releaseLock();
  }
}

// 수업 시연용 예시 제안 넣기: Apps Script 편집기 위쪽에서 이 함수를 고르고 ▶ 실행을 눌러요.
// 여러 번 실행해도 같은 제목은 한 번만 들어가요. 필요 없으면 교사 화면에서 지우면 돼요.
function addSampleProposals() {
  const samples = [
    ['안전', '신사1동', '신사동 길거리에 킥보드 전용도로를 만들어 주세요', '인도로 다니는 킥보드가 많아서 걸어가다가 부딪힐 뻔한 적이 있어요. 킥보드가 다니는 길을 따로 만들면 걷는 사람과 킥보드 타는 사람 모두 안전할 것 같아요.'],
    ['안전', '대조동', '학교 앞 좁은 골목의 불법주차를 줄여 주세요', '등굣길 골목에 차가 길가에 세워져 있어서 길이 더 좁아져요. 차 사이로 걸어가야 해서 위험해요. 주차 금지 표지판을 더 세우고 아침 시간에 단속해 주면 좋겠어요.'],
    ['환경', '응암1동', '불광천 산책로에 분리수거 쓰레기통을 더 놓아 주세요', '불광천을 걷다 보면 쓰레기통이 멀어서 길에 버려진 쓰레기가 많아요. 분리수거를 할 수 있는 쓰레기통을 일정한 간격으로 놓으면 불광천이 더 깨끗해질 것 같아요.'],
    ['공원·놀이터', '구산동', '놀이터에 그늘막을 설치해 주세요', '여름에는 미끄럼틀과 그네가 너무 뜨거워서 놀 수가 없어요. 그늘막이 있으면 더운 날에도 놀이터에서 놀 수 있고 어른들도 쉬어 갈 수 있어요.'],
    ['교통', '진관동', '진관동에 다니는 마을버스를 늘려 주세요', '마을버스가 자주 오지 않아서 학원이나 도서관에 갈 때 오래 기다려야 해요. 배차 간격을 줄이거나 노선을 늘려 주면 좋겠어요.'],
    ['문화·체육', '녹번동', '어린이가 이용할 수 있는 실내 운동 공간을 만들어 주세요', '비나 미세먼지가 심한 날에는 밖에서 운동할 곳이 없어요. 동네에 어린이가 줄넘기나 공놀이를 할 수 있는 실내 공간이 있으면 좋겠어요.'],
  ];
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const db = loadFromSheets_();
    const have = db.proposals.map(p => p.title);
    let added = 0;
    samples.forEach((s, i) => {
      if (have.indexOf(s[2]) >= 0) return;
      db.proposals.push({ id: 'ex' + (i + 1) + Date.now().toString(36), category: s[0], dong: s[1], title: s[2], body: s[3],
        author: '예시', createdAt: Date.now() - (samples.length - i) * 60000 });
      added++;
    });
    if (added) save_(db, ['proposals']);
    Logger.log('예시 제안 ' + added + '개를 넣었어요.');
  } finally {
    lock.releaseLock();
  }
}

/* ===== 아래는 core.js 와 같은 내용이에요 ===== */
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
