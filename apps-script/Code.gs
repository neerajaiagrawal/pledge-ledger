/**
 * SAC Pledge Ledger — Google Apps Script backend
 * ------------------------------------------------
 * Deploy this as a Web App and paste its URL into the Setup tab of the page.
 *
 * What it does:
 *   - action=ping  : health check, returns sheet + config status
 *   - action=scan  : reads a pledge-card photo with Google Gemini, returns fields (does NOT save)
 *   - action=save  : appends a reviewed pledge row to the "Pledges" sheet (optionally saves the image to Drive)
 *   - action=list  : returns recent pledge rows for the Records tab
 *
 * ONE-TIME SETUP
 *   1. Create a Gemini API key: https://aistudio.google.com/apikey
 *   2. In this editor: Project Settings (gear) -> Script Properties -> Add:
 *          GEMINI_API_KEY   = <your key>
 *      (optional)
 *          GEMINI_MODEL     = gemini-3.6-flash        // default if omitted
 *          DRIVE_FOLDER_ID  = <a Drive folder id>     // if set, card images are archived there
 *   3. Deploy -> New deployment -> type "Web app"
 *          Execute as:  Me
 *          Who has access:  Anyone
 *      Copy the /exec URL into the page's Setup tab.
 *
 * NOTE: credit-card number / CVV / expiry are deliberately never read or stored.
 */

var SHEET_NAME = 'Pledges';

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
    geminiKey: props.getProperty('GEMINI_API_KEY') ? 'set' : 'MISSING',
    model: props.getProperty('GEMINI_MODEL') || 'gemini-3.6-flash',
    driveArchive: props.getProperty('DRIVE_FOLDER_ID') ? 'on' : 'off',
    time: new Date().toISOString()
  };
}

function scanCard(body) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'GEMINI_API_KEY is not set in Script Properties.' };
  var model = props.getProperty('GEMINI_MODEL') || 'gemini-3.6-flash';

  var image = String(body.image || '');
  image = image.replace(/^data:image\/[a-z]+;base64,/i, '');
  if (!image) return { ok: false, error: 'No image provided.' };
  var mime = body.mime || 'image/jpeg';

  var prompt =
    'You are reading a handwritten "Support A Child (SAC)" pledge card. ' +
    'Extract the donor-entered information into JSON. Read handwriting carefully. ' +
    'If a field is blank or unreadable, use an empty string. ' +
    'For "contribution", return the printed tier that is checked/marked, one of exactly: ' +
    '"One Child $250", "Two Children $500", "Three Children $750", "Five Children $1,250", ' +
    '"One Child for 12 years $2,500", or "Any Amount". If only "Any Amount" is filled, put that. ' +
    'For "amount", return the dollar figure implied by the checked tier or written in "Any Amount", digits only. ' +
    'IMPORTANT: Do NOT read, guess, or output any credit-card number, CVV, or expiry date. ' +
    'Add a "flags" array listing any field that is uncertain or that you could not read. ' +
    'Return ONLY JSON with these keys: donor_no, name, address, city, state, zip, phone, email, ' +
    'contribution, amount, pref_boys, pref_girls, pref_state, company_match (true/false), ' +
    'company_name, how_heard, notes, flags.';

  var payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: image } }
      ]
    }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json' }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) {
    return { ok: false, error: 'Gemini error ' + code + ': ' + text.slice(0, 500) };
  }

  var out;
  try {
    var data = JSON.parse(text);
    var raw = data.candidates[0].content.parts[0].text;
    out = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: 'Could not parse Gemini response: ' + String(err) };
  }

  return { ok: true, fields: normalizeFields(out) };
}

function savePledge(body) {
  var sheet = getSheet();
  var f = normalizeFields(body.fields || {});
  var scannedBy = String(body.scannedBy || '').trim();

  var imageLink = '';
  if (body.image) {
    imageLink = archiveImage(body.image, body.mime, f.name);
  }

  var record = {
    timestamp: new Date(),
    scannedBy: scannedBy,
    fields: f,
    imageLink: imageLink
  };
  sheet.appendRow(rowFromRecord(record));
  return { ok: true, saved: true, rows: Math.max(0, sheet.getLastRow() - 1), imageLink: imageLink };
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
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return 'archive-error: ' + String(err);
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
