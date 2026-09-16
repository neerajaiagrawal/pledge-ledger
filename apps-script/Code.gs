/**
 * SAC Pledge Ledger — Google Apps Script backend
 * ------------------------------------------------
 * Deploy this as a Web App and paste its URL into the Setup tab of the page.
 *
 * AI card reader: OpenAI (primary) with Groq fallback. Both use the
 * OpenAI-compatible chat/vision API, so the same code path calls either one.
 * If the primary fails (rate limit, outage, model rename), it automatically
 * retries with the other. Flip the order live with the AI_PRIMARY property
 * ('openai' or 'groq') — no code change needed.
 *
 * What it does:
 *   - action=ping  : health check, returns sheet + provider status
 *   - action=scan  : reads a pledge-card photo with AI, returns fields (does NOT save)
 *   - action=save  : appends a reviewed pledge row to the "Pledges" sheet (optionally saves the image to Drive)
 *   - action=list  : returns recent pledge rows for the Records tab
 *
 * ONE-TIME SETUP
 *   1. OpenAI key (primary): https://platform.openai.com/api-keys  (needs billing; ~$0.30 for 500 scans on gpt-4o-mini)
 *      FREE Groq key (fallback): https://console.groq.com/keys      (no billing needed)
 *   2. In this editor: Project Settings (gear) -> Script Properties -> Add:
 *          OPENAI_API_KEY   = <your openai key>                     // primary
 *          GROQ_API_KEY     = <your groq key>                       // fallback
 *      (optional overrides)
 *          AI_PRIMARY       = openai | groq                         // default openai
 *          OPENAI_MODEL     = gpt-4o-mini                                 // default
 *          GROQ_MODEL       = meta-llama/llama-4-scout-17b-16e-instruct   // default
 *          DONOR_START      = 1001         // first auto donor number (used when a card's Donor No is blank)
 *          DONOR_PREFIX     = SAC-         // optional prefix on auto donor numbers (default none)
 *          DRIVE_FOLDER_ID  = <a Drive folder id>   // if set, card images are archived there
 *   3. Deploy -> Manage deployments -> edit -> Version: New version -> Deploy
 *      (creates a new version WITHOUT changing the /exec URL). First time:
 *      Deploy -> New deployment -> Web app, Execute as Me, access Anyone.
 *
 * NOTE: credit-card number / CVV / expiry are deliberately never read or stored.
 */

var SHEET_NAME = 'Pledges';

var DEFAULT_GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
var DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

// Column order for the sheet. Keep in sync with HEADERS and rowFromRecord().
var HEADERS = [
  'Timestamp', 'Scanned By', 'Donor No', 'Name', 'Address', 'City', 'State', 'Zip',
  'Phone', 'Email', 'Contribution', 'Amount', 'Pref Boys', 'Pref Girls',
  'Pref State', 'Company Match', 'Company Name', 'How Heard', 'Notes', 'Image Link', 'Flags'
];

/* ------------------------------ HTTP entry points ------------------------------ */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'list') return json(listPledges(e));
    return json(ping());
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json({ ok: false, error: 'Bad JSON body' });
  }
  var action = body.action || '';
  try {
    if (action === 'scan') return json(scanCard(body));
    if (action === 'save') return json(savePledge(body));
    if (action === 'ping') return json(ping());
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* --------------------------------- actions ---------------------------------- */

function ping() {
  var sheet = getSheet();
  var props = PropertiesService.getScriptProperties();
  var count = Math.max(0, sheet.getLastRow() - 1);
  return {
    ok: true,
    status: 'connected',
    spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
    sheet: SHEET_NAME,
    rows: count,
    primary: (props.getProperty('AI_PRIMARY') || 'openai').toLowerCase(),
    openaiKey: props.getProperty('OPENAI_API_KEY') ? 'set' : 'not set',
    groqKey: props.getProperty('GROQ_API_KEY') ? 'set' : 'not set',
    openaiModel: props.getProperty('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL,
    groqModel: props.getProperty('GROQ_MODEL') || DEFAULT_GROQ_MODEL,
    driveArchive: props.getProperty('DRIVE_FOLDER_ID') ? 'on' : 'off',
    time: new Date().toISOString()
  };
}

function scanCard(body) {
  var props = PropertiesService.getScriptProperties();

  var dataUrl = toDataUrl(String(body.image || ''), body.mime || 'image/jpeg');
  if (!dataUrl) return { ok: false, error: 'No image provided.' };

  // Provider chain. Order is set by AI_PRIMARY ('openai' or 'groq'); default 'openai'.
  var providers = {
    openai: {
      name: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      key: props.getProperty('OPENAI_API_KEY'),
      model: props.getProperty('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL
    },
    groq: {
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: props.getProperty('GROQ_API_KEY'),
      model: props.getProperty('GROQ_MODEL') || DEFAULT_GROQ_MODEL
    }
  };
  var primary = (props.getProperty('AI_PRIMARY') || 'openai').toLowerCase();
  var order = primary === 'groq' ? ['groq', 'openai'] : ['openai', 'groq'];

  var chain = order
    .map(function (n) { return providers[n]; })
    .filter(function (p) { return p && p.key; });

  if (!chain.length) {
    return { ok: false, error: 'No AI key set. Add OPENAI_API_KEY and/or GROQ_API_KEY in Script Properties.' };
  }

  var errors = [];
  for (var i = 0; i < chain.length; i++) {
    var p = chain[i];
    var r = callVisionModel(p, dataUrl);
    if (r.ok) {
      var fields = normalizeFields(r.fields);
      return { ok: true, fields: fields, provider: p.name, model: p.model };
    }
    errors.push(p.name + ': ' + r.error);
  }
  return { ok: false, error: 'All providers failed — ' + errors.join(' | ') };
}

function callVisionModel(p, dataUrl) {
  var system =
    'You transcribe a handwritten "Support A Child (SAC)" donation pledge card into JSON. Return JSON only.\n\n' +
    'THE CARD HAS THESE PRINTED LABELS, IN THIS ORDER:\n' +
    '  "Donor No." (top right, often blank)\n' +
    '  "Name:"\n' +
    '  "Address:"  (its own line — frequently left blank)\n' +
    '  a line with THREE labels together: "City:"  "State:"  "Zip code:"\n' +
    '  a line with a phone icon then the number, and an envelope icon then the email\n' +
    '  "Contribution:" with checkboxes: One Child $250, Two Children $500, Three Children $750,\n' +
    '     Five Children $1,250, One Child for 12 years $2,500, and a blank "Any Amount:" line\n' +
    '  "Number of Boys", "Number of Girls", "Preference of State"\n' +
    '  a checkbox "My company will match my donation" and "Company Name:"\n' +
    '  a credit-card section ("Name on Card", "Card No.", "Card Type", "Exp. Date", "CVV#", "Signature")\n' +
    '  "How did you hear about SAC"\n\n' +
    'RULES:\n' +
    '1. Map each value to the key for the label PRINTED NEXT TO IT. Never shift a value to a different field.\n' +
    '2. If a labeled line is blank, its value is "" — do NOT fill it with text from another line. ' +
    'In particular, when "Address:" is blank, leave address "" and still read City/State/Zip from THEIR line.\n' +
    '3. "state" is the 2-letter US state next to "State:"; "zip" is the number next to "Zip code:". Do not swap them.\n' +
    '4. For "contribution" return the checked tier, exactly one of: "One Child $250", "Two Children $500", ' +
    '"Three Children $750", "Five Children $1,250", "One Child for 12 years $2,500", or "Any Amount". ' +
    'For "amount" return that tier\'s dollar figure (or the number written on the "Any Amount" line), digits only.\n' +
    '5. NEVER read, guess, or output any credit-card number, card type, CVV, expiry, or signature — ignore that whole section.\n' +
    '6. Read digits carefully (0/6/8, 1/7/4 are easy to confuse). Preserve the donor\'s spelling of names.\n' +
    '7. Put the name of ANY field you are unsure about into the "flags" array so a human double-checks it.\n\n' +
    'Return ONLY a JSON object with these keys: donor_no, name, address, city, state, zip, phone, email, ' +
    'contribution, amount, pref_boys, pref_girls, pref_state, company_match (true/false), ' +
    'company_name, how_heard, notes, flags.';

  var payload = {
    model: p.model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: 'Transcribe this pledge card into the JSON described. Map strictly by printed label; leave blank lines empty.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
      ] }
    ]
  };

  var resp = UrlFetchApp.fetch(p.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + p.key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) {
    return { ok: false, error: 'HTTP ' + code + ': ' + text.slice(0, 300) };
  }

  var content;
  try {
    content = JSON.parse(text).choices[0].message.content;
  } catch (err) {
    return { ok: false, error: 'Unexpected response shape: ' + text.slice(0, 200) };
  }

  var fields = extractJson(content);
  if (!fields) return { ok: false, error: 'Model did not return JSON.' };
  return { ok: true, fields: fields };
}

function savePledge(body) {
  var sheet = getSheet();
  var f = normalizeFields(body.fields || {});
  var scannedBy = String(body.scannedBy || '').trim();

  // Auto-assign a donor number only when the card didn't have one written in.
  var autoNumber = false;
  if (!f.donor_no) { f.donor_no = nextDonorNo(); autoNumber = true; }

  var imageLink = '';
  if (body.image) {
    imageLink = archiveImage(toDataUrl(body.image, body.mime), body.mime, f.name);
  }

  sheet.appendRow(rowFromRecord({
    timestamp: new Date(),
    scannedBy: scannedBy,
    fields: f,
    imageLink: imageLink
  }));
  return {
    ok: true, saved: true, rows: Math.max(0, sheet.getLastRow() - 1),
    donorNo: f.donor_no, autoNumber: autoNumber, imageLink: imageLink
  };
}

// Next sequential donor number. Configurable via Script Properties:
//   DONOR_START  (first number, default 1001)   DONOR_PREFIX (e.g. "SAC-", default "")
// A script lock keeps concurrent volunteers from grabbing the same number.
function nextDonorNo() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var start = parseInt(props.getProperty('DONOR_START') || '1001', 10);
    var cur = props.getProperty('DONOR_SEQ');
    var n = cur ? parseInt(cur, 10) + 1 : start;
    props.setProperty('DONOR_SEQ', String(n));
    return (props.getProperty('DONOR_PREFIX') || '') + n;
  } finally {
    lock.releaseLock();
  }
}

function listPledges(e) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  var limit = 100;
  if (e && e.parameter && e.parameter.limit) limit = Math.min(500, parseInt(e.parameter.limit, 10) || 100);
  var start = Math.max(2, last - limit + 1);
  var num = last - start + 1;
  var values = sheet.getRange(start, 1, num, HEADERS.length).getValues();
  var rows = values.map(function (r) {
    var o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  }).reverse(); // newest first
  return { ok: true, rows: rows, headers: HEADERS };
}

/* --------------------------------- helpers ---------------------------------- */

// Ensure a full data URL (OpenAI-compatible image_url wants data:...;base64,....)
function toDataUrl(image, mime) {
  image = String(image || '').trim();
  if (!image) return '';
  if (/^data:image\//i.test(image)) return image;
  return 'data:' + (mime || 'image/jpeg') + ';base64,' + image;
}

// Pull the first {...} JSON object out of a model reply (handles code fences / stray text).
function extractJson(s) {
  s = String(s || '');
  try { return JSON.parse(s); } catch (e) {}
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function normalizeFields(o) {
  o = o || {};
  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  return {
    donor_no: s(o.donor_no),
    name: s(o.name),
    address: s(o.address),
    city: s(o.city),
    state: s(o.state),
    zip: s(o.zip),
    phone: s(o.phone),
    email: s(o.email),
    contribution: s(o.contribution),
    amount: s(o.amount).replace(/[^0-9.]/g, ''),
    pref_boys: s(o.pref_boys),
    pref_girls: s(o.pref_girls),
    pref_state: s(o.pref_state),
    company_match: (o.company_match === true || String(o.company_match).toLowerCase() === 'true' || String(o.company_match).toLowerCase() === 'yes') ? 'Yes' : 'No',
    company_name: s(o.company_name),
    how_heard: s(o.how_heard),
    notes: s(o.notes),
    flags: Array.isArray(o.flags) ? o.flags.join(', ') : s(o.flags)
  };
}

function rowFromRecord(rec) {
  var f = rec.fields;
  return [
    rec.timestamp, rec.scannedBy, f.donor_no, f.name, f.address, f.city, f.state, f.zip,
    f.phone, f.email, f.contribution, f.amount, f.pref_boys, f.pref_girls,
    f.pref_state, f.company_match, f.company_name, f.how_heard, f.notes, rec.imageLink, f.flags
  ];
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function archiveImage(dataUrl, mime, name) {
  var folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  if (!folderId) return '';
  try {
    var b64 = String(dataUrl).replace(/^data:image\/[a-z]+;base64,/i, '');
    var bytes = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(bytes, mime || 'image/jpeg',
      'pledge_' + (name || 'card').replace(/[^\w]+/g, '_') + '_' + Date.now() + '.jpg');
    var file = DriveApp.getFolderById(folderId).createFile(blob);
    // Private by default: the file is visible only to people who already have
    // access to the folder (i.e. you / whoever the sheet+folder is shared with).
    // Card images can contain donor PII and handwritten card details, so we do
    // NOT make them "anyone with the link". Set ARCHIVE_PUBLIC=true only if you
    // deliberately want open links.
    if (String(PropertiesService.getScriptProperties().getProperty('ARCHIVE_PUBLIC')).toLowerCase() === 'true') {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    return file.getUrl();
  } catch (err) {
    return 'archive-error: ' + String(err);
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
