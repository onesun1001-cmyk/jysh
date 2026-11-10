/**
 * 방명록 백엔드 — Google Apps Script (구글 시트에 저장)
 *
 * 설치 방법은 tools/GUESTBOOK.md 참고.
 * 시트 열: A 시간 | B 이름 | C 메시지 | D 숨김(아무 글자나 적으면 목록에서 제외)
 */
const SHEET_NAME = 'guestbook';
const MAX_NAME = 20, MAX_MSG = 300, MAX_LIST = 300;
const MAX_POSTS_PER_MIN = 20;          // 전체 기준 분당 등록 한도(도배 방지)

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['time', 'name', 'message', 'hide']); }
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
  const name = clean_(d.name, MAX_NAME), msg = clean_(d.msg, MAX_MSG);
  if (!name || !msg) return json_({ ok: false, error: 'empty' });

  const cache = CacheService.getScriptCache(), key = 'n' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_POSTS_PER_MIN) return json_({ ok: false, error: 'busy' });
  cache.put(key, String(n + 1), 120);

  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
  try { sheet_().appendRow([new Date(), safe_(name), safe_(msg), '']); } finally { lock.releaseLock(); }
  return json_({ ok: true, item: { ts: Date.now(), name: name, msg: msg } });
}
