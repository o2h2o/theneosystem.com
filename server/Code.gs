/**
 * The Neo System - sync backend (Google Apps Script).
 *
 * One deployment, one shared password, any number of users - each with their
 * own private space. A user proves who they are by sending
 *     key = sha256("<name>:<password>")
 * which this script recomputes from the name and the stored SECRET. Getting
 * someone else's space therefore needs the password, and knowing a name alone
 * is not enough.
 *
 * Names are constrained to NAME_RE before they ever touch a filename, so the
 * only files this script can build are neo-<name>-<doc>.json for a name that
 * passed both the pattern and the key check.
 *
 * SETUP
 *   1. script.google.com -> New project -> paste this file over Code.gs
 *   2. Project Settings -> Script properties -> add:
 *        SECRET = the shared password
 *      (Never commit it. It lives here and in whoever you tell.)
 *   3. Deploy -> New deployment -> Web app
 *        Execute as:      Me
 *        Who has access:  Anyone      <- NOT "Anyone with a Google account"
 *   4. Copy the /exec URL into SYNC_URL in index.html (three places: the login
 *      screen, the planner block, the ledger block)
 *
 * Adding a person needs no configuration at all - they log in with a new name
 * and their space is created on first save.
 *
 * NOTE: editing this file DOES require a redeploy, and "Manage deployments ->
 * New version" proved unreliable - use Deploy -> New deployment and update the
 * URL in index.html.
 */

// Bump when this file changes, so a response says which build is actually live
// and there is no guessing about whether a deployment picked up an edit.
var BUILD = 'v3-multiuser';

// The kinds of document a request may ask for.
var DOCS = ['planner', 'ledger'];
var DEFAULT_DOC = 'planner';

// A name must match this before it is allowed anywhere near a filename.
var NAME_RE  = /^[a-z0-9]{1,20}$/;

// Linda's data predates per-user filenames; keep her on the original files so
// what is already synced is not stranded.
var LEGACY_USER  = 'linda';
var LEGACY_FILES = {
  planner: 'neo-planner-data.json',
  ledger:  'neo-ledger-data.json',
};

var PROP_SECRET = 'SECRET';
var MAX_BYTES   = 4000000;

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xFF;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/** Constant-time-ish compare, so timing does not leak the expected key. */
function sameKey_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns the validated name if the key proves it, otherwise null.
 * The name is checked against NAME_RE first, so a rejected name never reaches
 * the digest or a filename.
 */
function authUser_(name, key) {
  if (typeof name !== 'string') return null;
  var user = name.toLowerCase();
  if (!NAME_RE.test(user)) return null;

  var secret = PropertiesService.getScriptProperties().getProperty(PROP_SECRET);
  if (!secret) return null;

  return sameKey_(key, sha256Hex_(user + ':' + secret)) ? user : null;
}

/** Whitelist lookup for the document kind. */
function docName_(doc) {
  var name = doc || DEFAULT_DOC;
  for (var i = 0; i < DOCS.length; i++) if (DOCS[i] === name) return name;
  return null;
}

/** Both parts are already validated, so this can only build a name we control. */
function fileNameFor_(user, doc) {
  if (user === LEGACY_USER) return LEGACY_FILES[doc];
  return 'neo-' + user + '-' + doc + '.json';
}

function getFile_(user, doc) {
  var fileName = fileNameFor_(user, doc);
  var propKey  = 'FILE_ID_' + user + '_' + doc;
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

function readDoc_(user, doc) {
  try {
    var parsed = JSON.parse(getFile_(user, doc).getBlob().getDataAsString());
    if (!parsed || typeof parsed.version !== 'number') throw new Error('bad doc');
    return parsed;
  } catch (e) {
    return { version: 0, updatedAt: null, data: null };
  }
}

/**
 * GET ?user=..&key=..&doc=planner|ledger -> that user's document
 * GET ?user=..&key=..&action=whoami      -> confirm the login, stores nothing
 */
function doGet(e) {
  var p = (e && e.parameter) || {};

  var user = authUser_(p.user, p.key);
  if (!user) return json_({ ok: false, error: 'unauthorized' });

  if (p.action === 'whoami') {
    return json_({ ok: true, build: BUILD, user: user });
  }

  var doc = docName_(p.doc);
  if (!doc) return json_({ ok: false, error: 'bad_doc' });

  var stored = readDoc_(user, doc);
  return json_({
    ok: true, build: BUILD, user: user, doc: doc,
    version: stored.version, updatedAt: stored.updatedAt, data: stored.data
  });
}

/**
 * POST {user, key, doc, version, data} -> writes if version beats the stored one.
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

  var user = authUser_(body.user, body.key);
  if (!user) return json_({ ok: false, error: 'unauthorized' });

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
    var cur = readDoc_(user, doc);
    var incoming = Number(body.version) || 0;

    // Stale writer: hand back what is actually stored so the client can adopt it.
    if (incoming <= cur.version) {
      return json_({
        ok: false, error: 'conflict', build: BUILD, user: user, doc: doc,
        version: cur.version, updatedAt: cur.updatedAt, data: cur.data
      });
    }

    var next = { version: incoming, updatedAt: new Date().toISOString(), data: body.data };
    getFile_(user, doc).setContent(JSON.stringify(next));
    return json_({
      ok: true, build: BUILD, user: user, doc: doc,
      version: next.version, updatedAt: next.updatedAt
    });
  } finally {
    lock.releaseLock();
  }
}
