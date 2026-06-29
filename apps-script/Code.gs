/**
 * Campus Xerox Token & Print system — Google Apps Script "warehouse" Web App.
 *
 * Deployment:
 *   Deploy -> New deployment -> type "Web app".
 *   Execute as: Me.
 *   Who has access: Anyone.
 *
 * REQUIRED ADVANCED SERVICE:
 *   nightlyStorageCleanup() calls Drive.Files.emptyTrash(), which is part of the
 *   ADVANCED Google Drive Service. You MUST enable it once:
 *     Editor -> Services (+) -> "Drive API" -> Add.
 *   Without it, Drive.Files.emptyTrash() will throw "Drive is not defined".
 *
 * Operator setup steps:
 *   1. Paste the two folder IDs into the CONFIG block below.
 *   2. Enable the Advanced Drive Service (see above).
 *   3. Run createNightlyTrigger() ONCE to install the 23:59 cleanup trigger.
 *   4. Deploy as a Web App and copy the /exec URL into the student frontend CONFIG.
 *
 * CORS note: the browser posts Content-Type "text/plain;charset=utf-8" to dodge the
 * preflight that Apps Script cannot answer, so doPost reads e.postData.contents and
 * JSON.parse()es it manually.
 */

/* ===================== CONFIG (operator pastes the folder IDs) ===================== */
// Folder that holds the per-day uploaded student print files (auto-trashed nightly).
var DAILY_PENDING_FOLDER_ID = 'PASTE_DAILY_PENDING_FOLDER_ID';
// Folder that holds the permanent catalog files (forms, notes, etc.) — never deleted.
var MASTER_CATALOG_FOLDER_ID = 'PASTE_MASTER_CATALOG_FOLDER_ID';
/* =================================================================================== */


/**
 * Health / ping endpoint so the deployed URL is testable from a browser GET.
 */
function doGet(e) {
  return jsonOutput({
    success: true,
    service: 'Campus Xerox warehouse',
    status: 'ok',
    time: new Date().toISOString()
  });
}


/**
 * Receives a file upload (or a catalog lookup) from the student frontend.
 *
 * The browser sends Content-Type text/plain (to avoid a CORS preflight), so we read
 * the raw body from e.postData.contents and JSON.parse it ourselves.
 *
 * Payload: { fileName, tokenNumber, fileBase64, isCatalogItem (bool), mimeType? }
 *
 * - isCatalogItem === true: find the existing file BY NAME inside MASTER_CATALOG_FOLDER_ID
 *   and return its getUrl() as webViewLink (no new file is created).
 * - otherwise: base64-decode fileBase64 into a Blob, create it in DAILY_PENDING_FOLDER_ID,
 *   rename it to "XEROX_TOKEN_<tokenNumber>_<fileName>", share ANYONE_WITH_LINK/VIEW,
 *   and return its link.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body');
    }

    var payload = JSON.parse(e.postData.contents);
    var fileName = payload.fileName;
    var tokenNumber = payload.tokenNumber;
    var isCatalogItem = payload.isCatalogItem === true;

    if (!fileName) {
      throw new Error('Missing fileName');
    }

    if (isCatalogItem) {
      // --- Catalog lookup: do NOT create a file, find the existing one by name. ---
      var catalogFolder = DriveApp.getFolderById(MASTER_CATALOG_FOLDER_ID);
      var matches = catalogFolder.getFilesByName(fileName);
      if (!matches.hasNext()) {
        throw new Error('Catalog file not found: ' + fileName);
      }
      var catalogFile = matches.next();
      return jsonOutput({
        success: true,
        webViewLink: catalogFile.getUrl(),
        fileId: catalogFile.getId(),
        fileName: catalogFile.getName()
      });
    }

    // --- Fresh upload: decode the base64 payload and store the file. ---
    if (!payload.fileBase64) {
      throw new Error('Missing fileBase64 for upload');
    }
    if (tokenNumber === undefined || tokenNumber === null || tokenNumber === '') {
      throw new Error('Missing tokenNumber for upload');
    }

    var mimeType = payload.mimeType || inferMimeType(fileName);
    var decodedBytes = Utilities.base64Decode(payload.fileBase64);
    var blob = Utilities.newBlob(decodedBytes, mimeType, fileName);

    // target: 'catalog' stores a permanent, reusable copy in the Master Catalog
    // (used by the auto-promotion / dedup flow). Anything else -> Daily Pending.
    var target = (payload.target === 'catalog') ? 'catalog' : 'pending';
    var folderId = (target === 'catalog') ? MASTER_CATALOG_FOLDER_ID : DAILY_PENDING_FOLDER_ID;
    var folder = DriveApp.getFolderById(folderId);
    var file = folder.createFile(blob);

    var newName;
    if (target === 'catalog') {
      var shortHash = payload.fileHash ? String(payload.fileHash).substring(0, 10) : 'shared';
      newName = 'CATALOG_' + shortHash + '_' + fileName;
    } else {
      newName = 'XEROX_TOKEN_' + tokenNumber + '_' + fileName;
    }
    file.setName(newName);

    // Make it openable by the shopkeeper via the link.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return jsonOutput({
      success: true,
      webViewLink: file.getUrl(),
      fileId: file.getId(),
      fileName: newName,
      target: target
    });
  } catch (err) {
    return jsonOutput({ success: false, error: String(err) });
  }
}


/**
 * Time-driven nightly cleanup (intended for 23:59). Trashes every file in the daily
 * pending folder older than 12 hours, then empties the trash to force-reset Drive
 * allocation so storage never fills up.
 *
 * Drive.Files.emptyTrash() requires the ADVANCED Drive Service (see header comment).
 */
function nightlyStorageCleanup() {
  var folder = DriveApp.getFolderById(DAILY_PENDING_FOLDER_ID);
  var files = folder.getFiles();
  var cutoffMs = new Date().getTime() - (12 * 60 * 60 * 1000); // 12 hours ago
  var trashedCount = 0;

  while (files.hasNext()) {
    var file = files.next();
    if (file.getDateCreated().getTime() < cutoffMs) {
      file.setTrashed(true);
      trashedCount++;
    }
  }

  // Force-reset Drive allocation by permanently emptying the trash.
  // Requires the Advanced Drive Service (Services -> Drive API).
  Drive.Files.emptyTrash();

  Logger.log('nightlyStorageCleanup: trashed ' + trashedCount +
    ' file(s) older than 12h from folder ' + DAILY_PENDING_FOLDER_ID +
    ' and emptied trash.');
}


/**
 * Operator runs this ONCE to install the nightly cleanup trigger at 23:59.
 * Idempotent: removes any existing triggers for nightlyStorageCleanup first.
 */
function createNightlyTrigger() {
  var handlerName = 'nightlyStorageCleanup';

  // Delete duplicate existing triggers of the same handler to stay idempotent.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger(handlerName)
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .nearMinute(59)
    .create();

  Logger.log('createNightlyTrigger: installed daily trigger for ' + handlerName + ' at ~23:59.');
}


/* ===================== Helpers ===================== */

/**
 * Wraps a JS object in a ContentService JSON response.
 */
function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Best-effort MIME type inference from a file extension, used when the client
 * does not supply mimeType.
 */
function inferMimeType(fileName) {
  var name = String(fileName).toLowerCase();
  var dot = name.lastIndexOf('.');
  var ext = dot >= 0 ? name.substring(dot + 1) : '';
  switch (ext) {
    case 'pdf':  return 'application/pdf';
    case 'doc':  return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':  return 'application/vnd.ms-excel';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':  return 'application/vnd.ms-powerpoint';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'txt':  return 'text/plain';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp':  return 'image/bmp';
    case 'svg':  return 'image/svg+xml';
    default:     return 'application/octet-stream';
  }
}
