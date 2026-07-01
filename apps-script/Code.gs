/**
 * Campus Xerox — Google Apps Script JANITOR.
 *
 * The whole upload / download / promote hot path now runs on Cloudflare
 * (functions/api/upload.ts + functions/api/file.ts talk to Google Drive directly
 * via an operator OAuth refresh token, using the NON-restricted drive.file scope
 * so no Google verification is required). Apps Script's ONLY remaining job is to
 * delete expired files on a schedule.
 *
 * IMPORTANT — this script must run under the SAME Google account whose refresh
 * token the Cloudflare Function uses, so it owns and can trash those files.
 *
 * Because the Cloudflare app uses the drive.file scope, it creates and reuses its
 * OWN folders (it cannot use folders made by hand in the Drive UI). This janitor
 * therefore locates them BY NAME — these names MUST match the constants in
 * functions/api/upload.ts (PENDING_FOLDER_NAME / CATALOG_FOLDER_NAME).
 *
 * REQUIRED ADVANCED SERVICE:
 *   storageCleanup() calls Drive.Files.emptyTrash() (ADVANCED Google Drive
 *   Service). Enable it once: Editor -> Services (+) -> "Drive API" -> Add.
 *
 * SETUP (once):
 *   1. Enable the Advanced Drive Service (above).
 *   2. Run createCleanupTrigger() ONCE to install the hourly cleanup trigger.
 *   (No web-app deployment is needed anymore — this script is not called over HTTP.)
 *
 * RETENTION:
 *   - Daily Pending files (every fresh upload)  -> trashed after 2 HOURS.
 *   - Master Catalog files (promoted reuse copies) -> trashed after 3 DAYS.
 */

/* ===================== CONFIG — folder names (must match upload.ts) ===================== */
var PENDING_FOLDER_NAME = 'CampusXerox_DailyPending';
var CATALOG_FOLDER_NAME = 'CampusXerox_MasterCatalog';
/* ======================================================================================= */

// Retention windows (milliseconds).
var PENDING_TTL_MS = 2 * 60 * 60 * 1000;       // 2 hours
var CATALOG_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 3 days


/**
 * Time-driven cleanup (runs hourly). Trashes Daily Pending files older than 2h
 * and Master Catalog files older than 3 days, then empties the trash so the
 * Drive storage allocation is actually reclaimed.
 */
function storageCleanup() {
  var now = new Date().getTime();
  var trashedPending = trashOldInFoldersNamed(PENDING_FOLDER_NAME, now - PENDING_TTL_MS);
  var trashedCatalog = trashOldInFoldersNamed(CATALOG_FOLDER_NAME, now - CATALOG_TTL_MS);

  // Requires the Advanced Drive Service (Services -> Drive API).
  Drive.Files.emptyTrash();

  Logger.log('storageCleanup: trashed ' + trashedPending +
    ' Daily Pending file(s) older than 2h and ' + trashedCatalog +
    ' Master Catalog file(s) older than 3 days, then emptied trash.');
}


/**
 * Trash every file older than cutoffMs inside EVERY folder with the given name
 * (there is normally one; handling several is harmless if a duplicate is ever
 * created by a cold-start race). Returns the number of files trashed.
 */
function trashOldInFoldersNamed(folderName, cutoffMs) {
  var count = 0;
  var folders = DriveApp.getFoldersByName(folderName);
  while (folders.hasNext()) {
    var folder = folders.next();
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getDateCreated().getTime() < cutoffMs) {
        file.setTrashed(true);
        count++;
      }
    }
  }
  return count;
}


/**
 * Operator runs this ONCE to install the hourly storage-cleanup trigger.
 * Idempotent: removes any existing triggers for storageCleanup / the old
 * nightlyStorageCleanup handler first.
 */
function createCleanupTrigger() {
  var handlers = ['storageCleanup', 'nightlyStorageCleanup'];
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (handlers.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('storageCleanup')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('createCleanupTrigger: installed hourly trigger for storageCleanup.');
}


/**
 * Backwards-compatible wrapper so any previously-installed trigger still works.
 */
function nightlyStorageCleanup() {
  storageCleanup();
}
