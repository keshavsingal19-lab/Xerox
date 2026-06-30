/**
 * Campus Xerox Token & Print system — Google Apps Script "warehouse" Web App.
 *
 * Deployment:
 *   Deploy -> New deployment -> type "Web app".
 *   Execute as: Me.
 *   Who has access: Anyone.
 *
 * REQUIRED ADVANCED SERVICE:
 *   storageCleanup() calls Drive.Files.emptyTrash(), which is part of the
 *   ADVANCED Google Drive Service. You MUST enable it once:
 *     Editor -> Services (+) -> "Drive API" -> Add.
 *   Without it, Drive.Files.emptyTrash() will throw "Drive is not defined".
 *
 * RETENTION MODEL:
 *   - Daily Pending files (every fresh student upload) expire after 2 HOURS.
 *   - Master Catalog files (promoted "popular" files, hit 3 times within the
 *     2-hour window) live for 3 DAYS.
 *   storageCleanup() trashes Daily Pending files older than 2h and Master
 *   Catalog files older than 3 days, then empties the trash to reclaim storage.
 *
 * Operator setup steps:
 *   1. Paste the two folder IDs into the CONFIG block below.
 *   2. Enable the Advanced Drive Service (see above).
 *   3. Run createCleanupTrigger() ONCE to install the hourly cleanup trigger.
 *   4. Deploy as a Web App and copy the /exec URL into the student frontend CONFIG.
 *
 * CORS note: the browser posts Content-Type "text/plain;charset=utf-8" to dodge the
 * preflight that Apps Script cannot answer, so doPost reads e.postData.contents and
 * JSON.parse()es it manually.
 */

/* ===================== CONFIG (operator pastes the folder IDs) ===================== */
// Folder that holds the per-day uploaded student print files (auto-trashed after 2h).
var DAILY_PENDING_FOLDER_ID = 'PASTE_DAILY_PENDING_FOLDER_ID';
// Folder that holds the promoted Master Catalog files (popular reuse copies, kept 3 days).
var MASTER_CATALOG_FOLDER_ID = 'PASTE_MASTER_CATALOG_FOLDER_ID';
/* =================================================================================== */

// Retention windows (milliseconds).
var PENDING_TTL_MS = 2 * 60 * 60 * 1000;       // 2 hours
var CATALOG_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 3 days


/**
 * GET endpoint.
 *
 *  - action=download&id=FILE_ID -> returns the file contents as base64 JSON so the
 *    Cloudflare /api/file Function can stream the raw bytes for direct printing:
 *      { success:true, base64, mimeType, name }
 *    On any failure: { success:false, error }.
 *
 *  - no action (or any other action) -> health / ping payload so the deployed URL is
 *    testable from a plain browser GET.
 */
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};

  if (params.action === 'download') {
    try {
      var id = params.id;
      if (!id) {
        throw new Error('Missing file id');
      }
      var file = DriveApp.getFileById(id);
      var blob = file.getBlob();
      return jsonOutput({
        success: true,
        base64: Utilities.base64Encode(blob.getBytes()),
        mimeType: blob.getContentType(),
        name: file.getName()
      });
    } catch (err) {
      return jsonOutput({ success: false, error: String(err) });
    }
  }

  // Default: health / ping endpoint.
  return jsonOutput({
    success: true,
    service: 'Campus Xerox warehouse',
    status: 'ok',
    time: new Date().toISOString()
  });
}


/**
 * Receives a file upload, a catalog lookup, or a promotion request from the frontend.
 *
 * The browser sends Content-Type text/plain (to avoid a CORS preflight), so we read
 * the raw body from e.postData.contents and JSON.parse it ourselves.
 *
 * Branches (checked in order):
 *
 *  - { action:"promote", fileId } -> copy the given Daily Pending file into the Master
 *    Catalog folder, share ANYONE_WITH_LINK/VIEW, and return the new copy's link.
 *    Used by the dedup auto-promotion flow once a file is hit 3 times within 2h.
 *
 *  - { isCatalogItem:true, fileName } -> find the existing file BY NAME inside
 *    MASTER_CATALOG_FOLDER_ID and return its getUrl() as webViewLink (no file created).
 *
 *  - otherwise (upload) -> base64-decode fileBase64 into a Blob, create it in the target
 *    folder (DAILY_PENDING_FOLDER_ID by default, MASTER_CATALOG_FOLDER_ID when
 *    target==="catalog"), rename it ("XEROX_TOKEN_<tokenNumber>_<fileName>" for pending
 *    or "CATALOG_<shortHash>_<fileName>" for catalog), share ANYONE_WITH_LINK/VIEW, and
 *    return its link.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body');
    }

    var payload = JSON.parse(e.postData.contents);

    // --- PROMOTE branch: handled FIRST (no fileName required). -----------------------
    // The dedup flow on the 3rd hit of a still-pending file asks us to copy it from the
    // Daily Pending folder into the permanent-ish Master Catalog (kept 3 days), so all
    // subsequent students reuse the catalog copy.
    if (payload.action === 'promote') {
      if (!payload.fileId) {
        throw new Error('Missing fileId for promote');
      }
      if (MASTER_CATALOG_FOLDER_ID === 'PASTE_MASTER_CATALOG_FOLDER_ID') {
        throw new Error(
          'Apps Script is not configured: MASTER_CATALOG_FOLDER_ID is still the ' +
          'PASTE_ placeholder, so a file cannot be promoted into the Master Catalog. ' +
          'Paste the real Master Catalog Drive folder ID into the CONFIG block at the ' +
          'top of Code.gs and redeploy.'
        );
      }

      var catalogFolderForPromote = DriveApp.getFolderById(MASTER_CATALOG_FOLDER_ID);
      var sourceFile = DriveApp.getFileById(payload.fileId);

      // Build a clean catalog name: strip the per-upload "XEROX_TOKEN_<n>_" prefix so the
      // catalog copy is named for the document, not the originating token.
      var sourceName = sourceFile.getName();
      var cleanedName = sourceName.replace(/^XEROX_TOKEN_[^_]*_/, '');
      var catalogName = (cleanedName.indexOf('CATALOG_') === 0)
        ? cleanedName
        : ('CATALOG_' + cleanedName);

      var promotedFile = sourceFile.makeCopy(catalogName, catalogFolderForPromote);
      promotedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      return jsonOutput({
        success: true,
        webViewLink: promotedFile.getUrl(),
        fileId: promotedFile.getId()
      });
    }

    var fileName = payload.fileName;
    var tokenNumber = payload.tokenNumber;
    var isCatalogItem = payload.isCatalogItem === true;

    if (!fileName) {
      throw new Error('Missing fileName');
    }

    // target: 'catalog' stores a permanent, reusable copy in the Master Catalog
    // (used by the auto-promotion / dedup flow). Anything else -> Daily Pending.
    var target = (payload.target === 'catalog') ? 'catalog' : 'pending';

    // --- Configuration guard ---------------------------------------------------------
    // Surface the "file not appearing in Master folder" misconfiguration early: if the
    // operator never replaced the PASTE_ placeholders, DriveApp.getFolderById() would
    // throw a cryptic "No item with the given ID could be found" error. Return a clear,
    // actionable message instead so the operator knows to paste the real folder IDs.
    if (DAILY_PENDING_FOLDER_ID === 'PASTE_DAILY_PENDING_FOLDER_ID') {
      throw new Error(
        'Apps Script is not configured: DAILY_PENDING_FOLDER_ID is still the ' +
        'PASTE_ placeholder. Paste the real Daily Pending Drive folder ID into the ' +
        'CONFIG block at the top of Code.gs and redeploy.'
      );
    }
    if (target === 'catalog' && MASTER_CATALOG_FOLDER_ID === 'PASTE_MASTER_CATALOG_FOLDER_ID') {
      throw new Error(
        'Apps Script is not configured: MASTER_CATALOG_FOLDER_ID is still the ' +
        'PASTE_ placeholder, so catalog files cannot be saved to the Master folder. ' +
        'Paste the real Master Catalog Drive folder ID into the CONFIG block at the ' +
        'top of Code.gs and redeploy.'
      );
    }
    if (isCatalogItem && MASTER_CATALOG_FOLDER_ID === 'PASTE_MASTER_CATALOG_FOLDER_ID') {
      throw new Error(
        'Apps Script is not configured: MASTER_CATALOG_FOLDER_ID is still the ' +
        'PASTE_ placeholder, so the Master catalog cannot be searched. Paste the real ' +
        'Master Catalog Drive folder ID into the CONFIG block at the top of Code.gs ' +
        'and redeploy.'
      );
    }
    // ---------------------------------------------------------------------------------

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
 * Time-driven storage cleanup (intended to run every hour).
 *
 * Trashes:
 *   - Daily Pending files older than 2 HOURS (matches the token/order 2h expiry), and
 *   - Master Catalog files older than 3 DAYS (promoted reuse copies),
 * then empties the trash to force-reset Drive allocation so storage never fills up.
 *
 * Drive.Files.emptyTrash() requires the ADVANCED Drive Service (see header comment).
 */
function storageCleanup() {
  var now = new Date().getTime();
  var trashedPending = trashOlderThan(DAILY_PENDING_FOLDER_ID, now - PENDING_TTL_MS);

  var trashedCatalog = 0;
  if (MASTER_CATALOG_FOLDER_ID !== 'PASTE_MASTER_CATALOG_FOLDER_ID') {
    trashedCatalog = trashOlderThan(MASTER_CATALOG_FOLDER_ID, now - CATALOG_TTL_MS);
  }

  // Force-reset Drive allocation by permanently emptying the trash.
  // Requires the Advanced Drive Service (Services -> Drive API).
  Drive.Files.emptyTrash();

  Logger.log('storageCleanup: trashed ' + trashedPending +
    ' Daily Pending file(s) older than 2h and ' + trashedCatalog +
    ' Master Catalog file(s) older than 3 days, then emptied trash.');
}


/**
 * Trashes every file in the given folder whose creation time is before cutoffMs.
 * Returns the number of files trashed. A bad/placeholder folder ID is logged and
 * skipped (returns 0) so one misconfigured folder never aborts the whole cleanup.
 */
function trashOlderThan(folderId, cutoffMs) {
  if (!folderId || folderId.indexOf('PASTE_') === 0) {
    return 0;
  }
  var count = 0;
  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getDateCreated().getTime() < cutoffMs) {
        file.setTrashed(true);
        count++;
      }
    }
  } catch (err) {
    Logger.log('trashOlderThan: skipped folder ' + folderId + ' — ' + String(err));
  }
  return count;
}


/**
 * Thin backwards-compatible wrapper: any previously-installed nightly trigger that
 * still points at nightlyStorageCleanup keeps working by delegating to storageCleanup().
 */
function nightlyStorageCleanup() {
  storageCleanup();
}


/**
 * Operator runs this ONCE to install the hourly storage-cleanup trigger.
 * Idempotent: removes any existing triggers for storageCleanup first.
 */
function createCleanupTrigger() {
  var handlerName = 'storageCleanup';

  // Delete duplicate existing triggers of the same handler to stay idempotent.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger(handlerName)
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('createCleanupTrigger: installed hourly trigger for ' + handlerName + '.');
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
