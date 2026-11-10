/**
 * 방명록 + 참석 회신 백엔드 — Google Apps Script (구글 시트에 저장)
 *
 * 설치·재배포 방법은 tools/GUESTBOOK.md 참고.
 * guestbook 탭: A 시간 | B 이름 | C 메시지 | D 숨김(아무 글자나 적으면 목록에서 제외)
 * rsvp 탭     : A 시간 | B 구분 | C 이름 | D 참석 | E 인원 | F 식사 | G 전할 말
 *   - rsvp 탭은 쓰기 전용입니다. doGet 은 방명록만 돌려주므로 참석 명단은 밖에서 읽을 수 없습니다.
 */
const SHEET_NAME = 'guestbook', RSVP_SHEET = 'rsvp';
const MAX_NAME = 20, MAX_MSG = 300, MAX_LIST = 300, MAX_NOTE = 100, MAX_PARTY = 10;
const MAX_POSTS_PER_MIN = 20;          // 전체 기준 분당 등록 한도(도배 방지)

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['time', 'name', 'message', 'hide']); }
  return sh;
}
function rsvpSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(RSVP_SHEET);
  if (!sh) { sh = ss.insertSheet(RSVP_SHEET); sh.appendRow(['time', 'side', 'name', 'attend', 'count', 'meal', 'note']); }
  return sh;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
// 시트에서 수식으로 실행되지 않도록 방어 (CSV/수식 인젝션)
function safe_(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function doGet() {
  const sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return json_({ ok: true, items: [] });
  const from = Math.max(2, last - MAX_LIST + 1);
  const rows = sh.getRange(from, 1, last - from + 1, 4).getValues();
  const items = rows.filter(r => !r[3] && r[1] && r[2])
    .map(r => ({ ts: new Date(r[0]).getTime(), name: String(r[1]).replace(/^'/, ''), msg: String(r[2]).replace(/^'/, '') }))
    .reverse();
  return json_({ ok: true, items: items });
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  if (d.website) return json_({ ok: true });                       // 허니팟: 봇이 채우는 숨은 칸
  const isRsvp = d.type === 'rsvp';
  const name = clean_(d.name, MAX_NAME), msg = clean_(d.msg, MAX_MSG);
  let row;
  if (isRsvp) {
    // 정해진 값만 받음(그 외는 거절)
    const side = ['신랑측', '신부측'].indexOf(d.side) >= 0 ? d.side : '';
    const attend = ['참석', '불참'].indexOf(d.attend) >= 0 ? d.attend : '';
    if (!name || !side || !attend) return json_({ ok: false, error: 'empty' });
    const going = attend === '참석';
    const count = going ? Math.max(1, Math.min(MAX_PARTY, parseInt(d.count, 10) || 1)) : 0;
    const meal = going ? (d.meal === '식사안함' ? '식사안함' : '식사함') : '';
    row = [new Date(), side, safe_(name), attend, count, meal, safe_(clean_(d.note, MAX_NOTE))];
  } else if (!name || !msg) return json_({ ok: false, error: 'empty' });

  const cache = CacheService.getScriptCache(), key = 'n' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_POSTS_PER_MIN) return json_({ ok: false, error: 'busy' });
  cache.put(key, String(n + 1), 120);

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
  try {
    if (isRsvp) rsvpSheet_().appendRow(row);
    else sheet_().appendRow([new Date(), safe_(name), safe_(msg), '']);
  } finally { lock.releaseLock(); }
  if (isRsvp) return json_({ ok: true, kind: 'rsvp' });
  return json_({ ok: true, item: { ts: Date.now(), name: name, msg: msg } });
}
