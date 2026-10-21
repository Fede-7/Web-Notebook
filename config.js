/**
 * CONFIGURAZIONE PREDEFINITA
 * I valori di default possono essere caricati in modo sicuro dal file .env del server,
 * oppure sovrascritti localmente per test.
 */
let DEFAULT_OWNER = 'Fede-7';
let DEFAULT_REPO = 'Notes';
let DEFAULT_BRANCH = 'main';
let DEFAULT_ROOT_PATH = '00 - Obsidian Notes';
let DEFAULT_EXCLUDE_DIRS = ['assets', 'asset', 'Wait', 'Spunto', 'Essenziale'];

let DEFAULT_DRIVE_FOLDER_ID = '1k77YG_N_xwMctML4d-aV2PfuyIY-ECKS';

// Chiavi localStorage
const STORAGE_KEY_CONFIG = 'notepdf_user_config';
const STORAGE_KEY_TOKEN = 'notepdf_github_token';
const STORAGE_KEY_THEME = 'notepdf_theme';
const STORAGE_KEY_ETAG = 'notepdf_github_etag';
const STORAGE_KEY_LAST_SYNC = 'notepdf_last_sync_date';
const STORAGE_KEY_LAST_STATUS = 'notepdf_last_sync_status';
const STORAGE_KEY_DRIVE_CACHE = 'notepdf_drive_tree_cache';
const STORAGE_KEY_DRIVE_LAST_SYNC = 'notepdf_drive_last_sync';
const STORAGE_KEY_ACTIVE_TAB = 'notepdf_active_tab';
const STORAGE_KEY_DRIVE_DEFAULT_PATH = 'notepdf_drive_default_path';
const STORAGE_KEY_DRIVE_CURRENT_PATH = 'notepdf_drive_current_path';

// Stato del server
let serverConfigLoaded = false;
let hasServerToken = false;
let isServerMode = false;

/**
 * Prova a caricare la configurazione sicura dal backend Express (.env)
 */
async function loadServerConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data.owner) DEFAULT_OWNER = data.owner;
      if (data.repo) DEFAULT_REPO = data.repo;
      if (data.branch) DEFAULT_BRANCH = data.branch;
      if (data.rootPath !== undefined) DEFAULT_ROOT_PATH = data.rootPath;
      if (Array.isArray(data.excludeDirs)) DEFAULT_EXCLUDE_DIRS = data.excludeDirs;
      if (data.driveFolderId) DEFAULT_DRIVE_FOLDER_ID = data.driveFolderId;
      hasServerToken = Boolean(data.hasToken);
      isServerMode = true;
      serverConfigLoaded = true;
      return data;
    }
  } catch (e) {
    // Backend non presente (es. deploy statico puro GitHub Pages)
    serverConfigLoaded = true;
    isServerMode = false;
  }
  return null;
}

/**
 * Recupera la configurazione attiva
 */
function getAppConfig() {
  let userConfig = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (raw) {
      userConfig = JSON.parse(raw);
      // Pulisce vecchi default non più validi se presenti nel browser
      if (userConfig.owner === 'federicodellini' || userConfig.repo === 'obsidian-notes') {
        localStorage.removeItem(STORAGE_KEY_CONFIG);
        userConfig = {};
      }
    }
  } catch (e) {
    console.warn('Errore lettura configurazione locale:', e);
  }

  const clientToken = localStorage.getItem(STORAGE_KEY_TOKEN) || '';

  return {
    owner: (userConfig.owner !== undefined && userConfig.owner !== '') ? userConfig.owner.trim() : DEFAULT_OWNER,
    repo: (userConfig.repo !== undefined && userConfig.repo !== '') ? userConfig.repo.trim() : DEFAULT_REPO,
    branch: (userConfig.branch !== undefined && userConfig.branch !== '') ? userConfig.branch.trim() : DEFAULT_BRANCH,
    rootPath: (userConfig.rootPath !== undefined) ? userConfig.rootPath.trim() : DEFAULT_ROOT_PATH,
    excludeDirs: Array.isArray(userConfig.excludeDirs) ? userConfig.excludeDirs : [...DEFAULT_EXCLUDE_DIRS],
    token: clientToken.trim(),
    hasServerToken,
    isServerMode,
  };
}

/**
 * Salva le impostazioni modificate nel browser
 */
function saveAppConfig({ owner, repo, branch, rootPath, excludeDirs, token }) {
  const current = getAppConfig();
  const newConfig = {
    owner: owner !== undefined ? owner.trim() : current.owner,
    repo: repo !== undefined ? repo.trim() : current.repo,
    branch: branch !== undefined ? branch.trim() : current.branch,
    rootPath: rootPath !== undefined ? rootPath.trim() : current.rootPath,
    excludeDirs: Array.isArray(excludeDirs) ? excludeDirs : current.excludeDirs,
  };

  try {
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(newConfig));
    if (token !== undefined) {
      if (token.trim()) {
        localStorage.setItem(STORAGE_KEY_TOKEN, token.trim());
      } else {
        localStorage.removeItem(STORAGE_KEY_TOKEN);
      }
    }
    return true;
  } catch (e) {
    console.error('Impossibile salvare la configurazione:', e);
    return false;
  }
}

/**
 * Ripristina i valori predefiniti (.env o costanti)
 */
function resetAppConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY_CONFIG);
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_ETAG);
    return true;
  } catch (e) {
    console.error('Errore reset configurazione:', e);
    return false;
  }
}

// Esporta globalmente
window.APP_CONFIG = {
  get DEFAULT_OWNER() { return DEFAULT_OWNER; },
  get DEFAULT_REPO() { return DEFAULT_REPO; },
  get DEFAULT_BRANCH() { return DEFAULT_BRANCH; },
  get DEFAULT_ROOT_PATH() { return DEFAULT_ROOT_PATH; },
  get DEFAULT_EXCLUDE_DIRS() { return DEFAULT_EXCLUDE_DIRS; },
  get DEFAULT_DRIVE_FOLDER_ID() { return DEFAULT_DRIVE_FOLDER_ID; },
  get hasServerToken() { return hasServerToken; },
  get isServerMode() { return isServerMode; },
  STORAGE_KEY_CONFIG,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_THEME,
  STORAGE_KEY_ETAG,
  STORAGE_KEY_LAST_SYNC,
  STORAGE_KEY_LAST_STATUS,
  STORAGE_KEY_DRIVE_CACHE,
  STORAGE_KEY_DRIVE_LAST_SYNC,
  STORAGE_KEY_ACTIVE_TAB,
  STORAGE_KEY_DRIVE_DEFAULT_PATH,
  STORAGE_KEY_DRIVE_CURRENT_PATH,
  loadServerConfig,
  getAppConfig,
  saveAppConfig,
  resetAppConfig,
};
