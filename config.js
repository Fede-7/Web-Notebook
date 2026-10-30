/**
 * CONFIGURAZIONE APPLICAZIONE - FEDE'S NOTES (GOOGLE DRIVE)
 * Gestisce l'ID della cartella radice condivisa su Google Drive e le chiavi di stato locale.
 */

let DEFAULT_DRIVE_FOLDER_ID = '1k77YG_N_xwMctML4d-aV2PfuyIY-ECKS';

// Chiavi localStorage
const STORAGE_KEY_THEME = 'fedesnotes_theme';
const STORAGE_KEY_DRIVE_CACHE = 'fedesnotes_drive_tree_cache_v3';
const STORAGE_KEY_DRIVE_LAST_SYNC = 'fedesnotes_drive_last_sync';
const STORAGE_KEY_ACTIVE_FOLDER = 'fedesnotes_active_root_folder';
const STORAGE_KEY_DEFAULT_FOLDER = 'fedesnotes_default_root_folder';
const STORAGE_KEY_SUBFOLDER_FILTER = 'fedesnotes_subfolder_filter';

let isServerMode = false;

/**
 * Carica la configurazione pubblica dal backend Express (/api/config)
 */
async function loadServerConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data.driveFolderId) {
        DEFAULT_DRIVE_FOLDER_ID = data.driveFolderId;
      }
      isServerMode = Boolean(data.serverMode);
      return data;
    }
  } catch (err) {
    isServerMode = false;
  }
  return null;
}

// Esporta globalmente
window.APP_CONFIG = {
  get DEFAULT_DRIVE_FOLDER_ID() {
    return DEFAULT_DRIVE_FOLDER_ID;
  },
  get isServerMode() {
    return isServerMode;
  },
  STORAGE_KEY_THEME,
  STORAGE_KEY_DRIVE_CACHE,
  STORAGE_KEY_DRIVE_LAST_SYNC,
  STORAGE_KEY_ACTIVE_FOLDER,
  STORAGE_KEY_DEFAULT_FOLDER,
  STORAGE_KEY_SUBFOLDER_FILTER,
  loadServerConfig,
};
