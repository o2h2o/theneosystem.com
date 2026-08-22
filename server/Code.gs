/**
 * The Neo System - sync backend (Google Apps Script).
 *
 * Stores each app's data as a single JSON file in the Drive of whichever
 * account deploys this. A request may only select from the fixed DOCS list
 * below - it can never name a file - so this script cannot be talked into
 * touching anything else in that Drive.
 *
 * SETUP
 *   1. script.google.com -> New project -> paste this file over Code.gs
 *   2. Project Settings -> Script properties -> add:
 *        SECRET = <the same long random key used in the #k= bookmark URL>
 *      (Never commit the SECRET. It lives only here and in the bookmark.)
 *   3. Deploy -> New deployment -> Web app
 *        Execute as:      Me
 *        Who has access:  Anyone      <- NOT "Anyone with a Google account"
 *   4. Copy the /exec URL into SYNC_URL in index.html (two places: the planner
 *      block and the ledger block)
 *
 * NOTE: editing this script does not update the live URL. Re-deploy via
 * Manage deployments -> edit -> Version: New version.
 */

// Bump when this file changes, so a response says which build is actually live
// and there is no guessing about whether a deployment picked up an edit.
var BUILD = 'v2-multidoc';

// The only files this script will ever open, keyed by the `doc` parameter.
var DOCS = {
  planner: 'neo-planner-data.json',
  ledger:  'neo-ledger-data.json',
};
var DEFAULT_DOC = 'planner';

var PROP_SECRET = 'SECRET';
var MAX_BYTES   = 4000000;

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Length-independent compare so timing does not leak the secret. */
function checkKey_(key) {
  var want = PropertiesService.getScriptProperties().getProperty(PROP_SECRET);
  if (!want || !key || key.length !== want.length) return false;
  var diff = 0;
  for (var i = 0; i < want.length; i++) {
    diff |= key.charCodeAt(i) ^ want.charCodeAt(i);
  }
  return diff === 0;
}

/** Whitelist lookup. Anything not in DOCS is rejected outright. */
function docName_(doc) {
  var name = doc || DEFAULT_DOC;
  return Object.prototype.hasOwnProperty.call(DOCS, name) ? name : null;
}

/** The one file backing a given doc. Created on first use. */
function getFile_(doc) {
  var fileName = DOCS[doc];
  var propKey  = 'FILE_ID_' + doc;
  var props    = PropertiesService.getScriptProperties();
  var id       = props.getProperty(propKey);

  if (id) {
    try { return DriveApp.getFileById(id); } catch (e) { /* deleted - recreate */ }
  }
  var it = DriveApp.getFilesByName(fileName);
  var file = it.hasNext()
    ? it.next()
    : DriveApp.createFile(
        fileName,
        JSON.stringify({ version: 0, updatedAt: null, data: null }),
        MimeType.PLAIN_TEXT
      );
  props.setProperty(propKey, file.getId());
  return file;
}

function readDoc_(doc) {
  try {
    var parsed = JSON.parse(getFile_(doc).getBlob().getDataAsString());
    if (!parsed || typeof parsed.version !== 'number') throw new Error('bad doc');
    return parsed;
  } catch (e) {
    return { version: 0, updatedAt: null, data: null };
  }
}

/** GET ?key=...&doc=planner|ledger -> current document */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!checkKey_(p.key)) return json_({ ok: false, error: 'unauthorized' });

  var doc = docName_(p.doc);
  if (!doc) return json_({ ok: false, error: 'bad_doc' });

  var stored = readDoc_(doc);
  return json_({ ok: true, build: BUILD, doc: doc, version: stored.version, updatedAt: stored.updatedAt, data: stored.data });
}

/**
 * POST {key, doc, version, data} -> writes if version beats the stored one.
 * Sent as text/plain so the browser treats it as a simple request (Apps Script
 * cannot answer a CORS preflight).
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }

  if (!checkKey_(body.key)) return json_({ ok: false, error: 'unauthorized' });

  var doc = docName_(body.doc);
  if (!doc) return json_({ ok: false, error: 'bad_doc' });

  if (typeof body.data !== 'string' || !body.data || body.data.length > MAX_BYTES) {
    return json_({ ok: false, error: 'bad_payload' });
  }
  // Refuse anything that is not a JSON object, so a broken client cannot
  // overwrite good data with garbage.
  try {
    var probe = JSON.parse(body.data);
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) throw new Error('not an object');
  } catch (err) {
    return json_({ ok: false, error: 'bad_payload' });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }

  try {
    var cur = readDoc_(doc);
    var incoming = Number(body.version) || 0;

    // Stale writer: hand back what is actually stored so the client can adopt it.
    if (incoming <= cur.version) {
      return json_({
        ok: false, error: 'conflict', build: BUILD, doc: doc,
        version: cur.version, updatedAt: cur.updatedAt, data: cur.data
      });
    }

    var next = { version: incoming, updatedAt: new Date().toISOString(), data: body.data };
    getFile_(doc).setContent(JSON.stringify(next));
    return json_({ ok: true, build: BUILD, doc: doc, version: next.version, updatedAt: next.updatedAt });
  } finally {
    lock.releaseLock();
  }
}
