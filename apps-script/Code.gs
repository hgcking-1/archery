/**
 * 3학년 양궁 기록장 — 구글 시트 저장용 서버 (Google Apps Script)
 *
 * 이 파일을 선생님의 구글 시트(확장 프로그램 > Apps Script)에 붙여넣고
 * 웹 앱으로 배포하면, 학생들이 각자 기기에서 기록해도 한 시트에 모입니다.
 * 자세한 순서는 저장소 README.md 의 "여러 기기에서 함께 쓰기"를 보세요.
 */

// ▼▼ 선생님 비밀번호를 바꾸세요. 이 파일은 선생님 구글 계정에서만 보여요. ▼▼
const TEACHER_PASSWORD = "CHANGE-ME";
// ▲▲ 여기까지 ▲▲

const TZ = "Asia/Seoul";
const MAX_ARROWS = 30;
const SCORE_KEYS = ["X", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "M"];
const TOKEN_HOURS = 12;          // 한 번 로그인하면 이 시간 동안 유지
const MAX_FAILS = 5;             // 비밀번호를 이만큼 틀리면
const LOCK_SECONDS = 600;        // 이 시간(초) 동안 잠김

// 시트(탭)별 열 이름. 첫 번째 열이 기록을 찾는 열쇠예요.
const TABLES = {
  students: ["sid", "cls", "no", "name", "pin", "anon"],
  sessions: ["key", "sid", "cls", "date", "count", "total", "xs", "avg", "updatedAt", "arrows"],
  pub: ["key", "cls", "date", "count", "total", "xs", "avg"]
};
const NUMERIC = { cls: 1, no: 1, count: 1, total: 1, xs: 1, avg: 1, updatedAt: 1 };

/* ===================== 요청 받기 ===================== */

function doGet() {
  return json({ ok: true, data: "archery server ready" });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return json({ ok: false, code: "bad" }); }
  try {
    const fn = ACTIONS[req.action];
    if (!fn) throw fail("bad");
    return json({ ok: true, data: fn(req) });
  } catch (x) {
    if (!x.code) console.error(x);                 // 예상 못 한 오류는 로그에만 남기고 자세한 내용은 돌려주지 않음
    return json({ ok: false, code: x.code || "error" });
  }
}

const ACTIONS = {
  studentLogin, teacherLogin, me, board, mySessions, getSession, saveSession,
  listStudents, saveRoster, savePin, allSessions, teacherSaveSession, deleteSession, exportAll, importMerge
};

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail(code) { const e = new Error(code); e.code = code; return e; }

/* ===================== 로그인 ===================== */

function studentLogin(req) {
  const sid = String(req.sid || ""), pin = String(req.pin || "");
  if (tooMany(sid)) throw fail("locked");
  const list = getStudents();
  if (!list.length) throw fail("noroster");
  const s = list.find(x => x.sid === sid);
  if (!s || s.pin !== pin) { bump(sid); throw fail("wrong"); }
  return { token: makeToken("student", sid), sid };
}

function teacherLogin(req) {
  if (TEACHER_PASSWORD === "CHANGE-ME") throw fail("unconfigured");
  if (tooMany("teacher")) throw fail("locked");
  if (String(req.pw || "") !== TEACHER_PASSWORD) { bump("teacher"); throw fail("wrong"); }
  return { token: makeToken("teacher", "") };
}

function tooMany(id) { return Number(CacheService.getScriptCache().get("f_" + id) || 0) >= MAX_FAILS; }
function bump(id) {
  const c = CacheService.getScriptCache();
  c.put("f_" + id, String(Number(c.get("f_" + id) || 0) + 1), LOCK_SECONDS);
}

// 로그인 표: "종류|학번|만료시각" 을 서명한 글자. 서버에 따로 저장하지 않아도 확인할 수 있어요.
function secret() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("SECRET");
  if (!s) {
    withLock(() => {
      s = p.getProperty("SECRET");
      if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty("SECRET", s); }
    });
  }
  return s;
}
function sign(text) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret())); }
function makeToken(kind, sid) {
  const body = kind + "|" + sid + "|" + (Date.now() + TOKEN_HOURS * 3600 * 1000);
  return Utilities.base64EncodeWebSafe(body) + "." + sign(body);
}
function readToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw fail("auth");
  let body;
  try { body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (x) { throw fail("auth"); }
  if (sign(body) !== parts[1]) throw fail("auth");
  const f = body.split("|");
  if (Date.now() > Number(f[2])) throw fail("auth");
  return { kind: f[0], sid: f[1] };
}
function studentOf(req) {
  const who = readToken(req.token);
  if (who.kind !== "student") throw fail("auth");
  const s = getStudents().find(x => x.sid === who.sid);
  if (!s) throw fail("auth");
  return s;
}
function requireTeacher(req) { if (readToken(req.token).kind !== "teacher") throw fail("auth"); }

/* ===================== 학생 ===================== */

function me(req) {
  const s = studentOf(req);
  return { sid: s.sid, cls: s.cls, no: s.no, name: s.name, anon: s.anon };
}

// 우리 반 이름·기록(화살 점수는 빼고)과 전체 반 평균 자료
function board(req) {
  const s = studentOf(req);
  return {
    names: getStudents().filter(x => x.cls === s.cls).map(x => ({ sid: x.sid, name: x.name })),
    cls: readTable("sessions", 9).filter(x => x.cls === s.cls).map(x => ({ sid: x.sid, cls: x.cls, date: x.date, count: x.count, total: x.total, xs: x.xs, avg: x.avg })),
    pub: readTable("pub").map(p => ({ id: p.key, cls: p.cls, date: p.date, count: p.count, total: p.total, xs: p.xs, avg: p.avg }))
  };
}

function mySessions(req) {
  const s = studentOf(req);
  return readTable("sessions").filter(x => x.sid === s.sid).map(parseSession).sort((a, b) => a.date < b.date ? -1 : 1);
}

function getSession(req) {
  const s = studentOf(req), date = cleanDate(req.date);
  if (!date) throw fail("bad");
  const row = readTable("sessions").find(x => x.key === s.sid + "_" + date);
  return row ? parseSession(row) : null;
}

// 학생은 "오늘" 기록만 저장할 수 있고, 합계·평균은 서버가 다시 계산해요.
function saveSession(req) {
  const s = studentOf(req), date = cleanDate(req.rec && req.rec.date);
  if (!date || date !== today()) throw fail("date");
  putSession(s, date, req.rec.arrows, Date.now());
  return true;
}

/* ===================== 선생님 ===================== */

function listStudents(req) { requireTeacher(req); return readTable("students"); }

function saveRoster(req) {
  requireTeacher(req);
  return withLock(() => {
    const map = {};
    readTable("students").forEach(s => map[s.sid] = s);
    let n = 0;
    (req.rows || []).forEach(r => {
      const s = cleanStudent(Object.assign({}, r, { anon: "" }));
      if (!s) return;
      s.anon = (map[s.sid] && map[s.sid].anon) || s.anon;     // 이미 있는 학생의 익명 번호는 그대로 둠
      map[s.sid] = s; n++;
    });
    writeTable("students", Object.keys(map).map(k => map[k]));
    dropStudentsCache();
    return n;
  });
}

function savePin(req) {
  requireTeacher(req);
  if (!/^\d{4}$/.test(String(req.pin))) throw fail("bad");
  return withLock(() => {
    const s = readTable("students").find(x => x.sid === String(req.sid));
    if (!s) throw fail("bad");
    s.pin = String(req.pin);
    upsert("students", s.sid, s);
    dropStudentsCache();
    return true;
  });
}

function allSessions(req) { requireTeacher(req); return readTable("sessions").map(parseSession); }

function teacherSaveSession(req) {
  requireTeacher(req);
  const s = getStudents().find(x => x.sid === String(req.sid)), date = cleanDate(req.rec && req.rec.date);
  if (!s || !date) throw fail("bad");
  putSession(s, date, req.rec.arrows, Date.now());
  return true;
}

function deleteSession(req) {
  requireTeacher(req);
  const s = getStudents().find(x => x.sid === String(req.sid)), date = cleanDate(req.date);
  if (!s || !date) throw fail("bad");
  withLock(() => { removeRow("sessions", s.sid + "_" + date); removeRow("pub", date + "_" + s.anon); });
  return true;
}

function exportAll(req) {
  requireTeacher(req);
  return { students: readTable("students"), sessions: readTable("sessions").map(parseSession) };
}

// 백업 파일 합치기: 없는 학생·기록은 더하고, 같은 날 기록은 더 나중에 저장한 쪽을 남김
function importMerge(req) {
  requireTeacher(req);
  return withLock(() => {
    const out = { students: 0, sessions: 0 };
    const stuMap = {}, sesMap = {}, pubMap = {};
    readTable("students").forEach(s => stuMap[s.sid] = s);
    readTable("sessions").forEach(s => sesMap[s.key] = s);
    readTable("pub").forEach(p => pubMap[p.key] = p);
    (req.students || []).forEach(raw => {
      const s = cleanStudent(raw);
      if (s && !stuMap[s.sid]) { stuMap[s.sid] = s; out.students++; }
    });
    (req.sessions || []).forEach(raw => {
      const stu = raw && stuMap[String(raw.sid)], date = cleanDate(raw && raw.date);
      if (!stu || !date) return;
      const a = cleanArrows(raw.arrows), sm = summarize(a), up = Number(raw.updatedAt) || 0;
      const key = stu.sid + "_" + date, old = sesMap[key];
      if (old && !(up > old.updatedAt || (up === old.updatedAt && sm.count > old.count))) return;
      sesMap[key] = { key, sid: stu.sid, cls: stu.cls, date, count: sm.count, total: sm.total, xs: sm.xs, avg: sm.avg, updatedAt: up, arrows: JSON.stringify(a) };
      const pk = date + "_" + stu.anon;
      pubMap[pk] = { key: pk, cls: stu.cls, date, count: sm.count, total: sm.total, xs: sm.xs, avg: sm.avg };
      out.sessions++;
    });
    writeTable("students", Object.keys(stuMap).map(k => stuMap[k]));
    writeTable("sessions", Object.keys(sesMap).map(k => sesMap[k]));
    writeTable("pub", Object.keys(pubMap).map(k => pubMap[k]));
    dropStudentsCache();
    return out;
  });
}

/* ===================== 값 검사·계산 ===================== */

function today() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }

function cleanDate(d) {
  d = String(d || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) ? d : "";
}

function cleanStudent(r) {
  if (!r || !/^3[1-6]\d{2}$/.test(String(r.sid)) || !/^\d{4}$/.test(String(r.pin))) return null;
  const sid = String(r.sid);
  return {
    sid, cls: Number(sid[1]), no: Number(sid.slice(2)), name: String(r.name || "").slice(0, 20), pin: String(r.pin),
    anon: /^[0-9a-z]{6,20}$/.test(String(r.anon || "")) ? String(r.anon) : Utilities.getUuid().replace(/-/g, "").slice(0, 14)
  };
}

function cleanArrows(list) {
  if (!Array.isArray(list)) throw fail("bad");
  return list.slice(0, MAX_ARROWS).map(a => typeof a === "string" ? { k: a } : a)
    .filter(a => a && SCORE_KEYS.indexOf(a.k) >= 0)
    .map(a => typeof a.x === "number" && typeof a.y === "number" && isFinite(a.x) && isFinite(a.y)
      ? { k: a.k, x: Math.max(-1.1, Math.min(1.1, a.x)), y: Math.max(-1.1, Math.min(1.1, a.y)) } : { k: a.k });
}

function summarize(arrows) {
  const total = arrows.reduce((t, a) => t + (a.k === "X" ? 10 : a.k === "M" ? 0 : Number(a.k)), 0);
  return { count: arrows.length, total, xs: arrows.filter(a => a.k === "X").length,
           avg: arrows.length ? Math.round(total / arrows.length * 100) / 100 : 0 };
}

function parseSession(row) {
  let arrows = [];
  try { arrows = JSON.parse(row.arrows); } catch (x) {}
  return { sid: row.sid, cls: row.cls, date: row.date, count: row.count, total: row.total, xs: row.xs, avg: row.avg, updatedAt: row.updatedAt, arrows };
}

// 하루 기록(이름 있음)과 이름 없는 기록(전체 순위용)을 함께 저장
function putSession(stu, date, arrows, now) {
  const a = cleanArrows(arrows), sm = summarize(a);
  withLock(() => {
    upsert("sessions", stu.sid + "_" + date, { key: stu.sid + "_" + date, sid: stu.sid, cls: stu.cls, date, count: sm.count, total: sm.total, xs: sm.xs, avg: sm.avg, updatedAt: now, arrows: JSON.stringify(a) });
    upsert("pub", date + "_" + stu.anon, { key: date + "_" + stu.anon, cls: stu.cls, date, count: sm.count, total: sm.total, xs: sm.xs, avg: sm.avg });
  });
}

/* ===================== 시트 읽고 쓰기 ===================== */

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// 맨 앞 `cols`개 열만 읽음 (기본: 전부)
function readTable(name, cols) {
  const sh = sheet(name), h = TABLES[name].slice(0, cols || TABLES[name].length), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, h.length).getValues().map(r => {
    const o = {};
    h.forEach((k, i) => o[k] = NUMERIC[k] ? (Number(r[i]) || 0) : String(r[i]));
    return o;
  });
}

function toRow(name, o) { return TABLES[name].map(k => o[k] == null ? "" : String(o[k])); }   // 전부 글자로 저장 (0123, 날짜가 바뀌지 않게)

function writeTable(name, rows) {
  const sh = sheet(name), w = TABLES[name].length, old = Math.max(0, sh.getLastRow() - 1);
  if (old) sh.getRange(2, 1, old, w).clearContent();
  if (rows.length) {
    const r = sh.getRange(2, 1, rows.length, w);
    r.setNumberFormat("@");
    r.setValues(rows.map(o => toRow(name, o)));
  }
}

function findRow(sh, key) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const keys = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < n; i++) if (String(keys[i][0]) === key) return i + 2;
  return 0;
}

function upsert(name, key, o) {
  const sh = sheet(name);
  const row = findRow(sh, key) || sh.getLastRow() + 1;
  const r = sh.getRange(row, 1, 1, TABLES[name].length);
  r.setNumberFormat("@");
  r.setValues([toRow(name, o)]);
}

function removeRow(name, key) {
  const sh = sheet(name), row = findRow(sh, key);
  if (row) sh.deleteRow(row);
}

// 학생 명단은 자주 쓰므로 6시간 동안 기억해 둠 (명단·비밀번호가 바뀌면 지움)
function getStudents() {
  const c = CacheService.getScriptCache(), hit = c.get("students");
  if (hit) return JSON.parse(hit);
  const list = readTable("students");
  try { c.put("students", JSON.stringify(list), 21600); } catch (x) {}
  return list;
}
function dropStudentsCache() { CacheService.getScriptCache().remove("students"); }
