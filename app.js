/**
 * FEDE'S NOTES - ENGINE APPLICATIVO (100% GOOGLE DRIVE)
 * - Trasforma ogni sottocartella diretta della root condivisa su Google Drive in un bottone in alto.
 * - Mostra tutti i file in un'unica lista unificata (senza separazione in blocchi di cartelle interne)
 *   ordinata in ordine cronologico decrescente, così in "Tutte" compaiono subito in cima gli ultimi file caricati.
 * - Sostituisce automaticamente la parola "main" nei file PDF con il nome della cartella genitore
 *   (es. "main-A4.pdf" in "Tecnologie Web" -> "Tecnologie Web-A4.pdf") sia a schermo che nel download.
 */

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ==========================================================================
   1. CACHE OFFLINE INDEXEDDB PER DOCUMENTI PDF APERTI DA GOOGLE DRIVE
   ========================================================================== */
const DB_NAME = 'FedesNotesDriveDB';
const DB_VERSION = 1;
const STORE_PDFS = 'drive_pdfs';
const MAX_CACHED_PDFS = 15;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        db.createObjectStore(STORE_PDFS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetCachedPdf(fileId) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDFS, 'readonly');
      const req = tx.objectStore(STORE_PDFS).get(fileId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return null;
  }
}

async function dbSaveCachedPdf(fileId, fileName, arrayBuffer) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PDFS, 'readwrite');
      const store = tx.objectStore(STORE_PDFS);
      store.put({
        id: fileId,
        fileName,
        data: arrayBuffer,
        updatedAt: Date.now(),
      });

      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const all = allReq.result || [];
        if (all.length > MAX_CACHED_PDFS) {
          all
            .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
            .slice(0, all.length - MAX_CACHED_PDFS)
            .forEach((old) => store.delete(old.id));
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Cache IndexedDB PDF non disponibile:', err);
  }
}

/* ==========================================================================
   2. STATO APPLICATIVO
   ========================================================================== */
let driveTreeData = null;           // Albero completo della cartella radice condivisa su Drive
let activeRootFolderId = null;      // ID della sottocartella attiva selezionata in alto
let activeSubfolderFilter = 'all';  // 'all' ("Tutte") oppure ID di una specifica sottocartella/materia
let isSyncingDrive = false;

const selectedFiles = new Map();    // Selezione multipla per download batch (fileId -> fileObj)
let currentlyVisibleFiles = [];     // Lista piatta dei file attualmente visibili nella vista corrente
let activeAudioFile = null;
let deferredInstallPrompt = null;

// Stato Visualizzatore PDF.js
let currentPdfDoc = null;
let currentPdfItem = null;
let currentPageNum = 1;
let currentZoom = 1.0;
let isPdfInvertMode = false;
let isRenderingPage = false;
let pageRenderingQueue = null;
let currentRenderTask = null;
let currentLoadingTask = null;
let detectedIndexPageNum = 2;

const STORAGE_KEY_PDF_PAGES = 'fedesnotes_pdf_last_pages';

function getSavedPdfPage(fileId) {
  if (!fileId) return 1;
  try {
    const map = JSON.parse(localStorage.getItem(STORAGE_KEY_PDF_PAGES) || '{}');
    return Number(map[fileId]) || 1;
  } catch (e) {
    return 1;
  }
}

function savePdfPage(fileId, pageNum) {
  if (!fileId || !pageNum) return;
  try {
    const map = JSON.parse(localStorage.getItem(STORAGE_KEY_PDF_PAGES) || '{}');
    map[fileId] = pageNum;
    localStorage.setItem(STORAGE_KEY_PDF_PAGES, JSON.stringify(map));
  } catch (e) {}
}

/* ==========================================================================
   3. UTILITÀ DI PULIZIA NOMI, RINOMINA PDF "MAIN" E ORDINAMENTO DECRESCENTE
   ========================================================================== */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function cleanDriveItemName(raw, isFolder = false) {
  if (!raw) return '';
  let name = decodeHtmlEntities(raw).trim();
  if (isFolder) {
    return name
      .replace(/\s+(Shared folder|cartella condivisa|folder|cartella|shared|condiviso)$/i, '')
      .trim();
  }
  name = name.replace(/\.(pdf|mp3|m4a|wav|aac|flac|ogg|wma|mp4|mkv|mov|webm|zip|rar|7z)\b.*$/i, '.$1');
  name = name
    .replace(
      /\s+(Audio Shared|Audio Condiviso|Audio|Video Shared|Video Condiviso|Video|PDF Shared|PDF Condiviso|Document Shared|Document Condiviso|Shared|Condiviso)$/i,
      ''
    )
    .trim();
  return name;
}

/**
 * Sostituisce la parola "main" nei file PDF con il nome della cartella genitore
 * Esempio: "main-A4.pdf" in "Tecnologie Web" -> "Tecnologie Web-A4.pdf"
 */
function applyParentFolderNameToPdf(fileName, parentFolderName) {
  if (!fileName || !parentFolderName) return fileName;
  const cleanParent = cleanDriveItemName(parentFolderName, true);
  if (!cleanParent || !/\.pdf$/i.test(fileName)) return fileName;
  return fileName.replace(/(^|[-_. ()[\]])main(?=$|[-_. ()[\]])/i, (_match, prefix) => `${prefix}${cleanParent}`);
}

function getFileExtension(fileName) {
  const clean = cleanDriveItemName(fileName, false);
  if (!clean.includes('.')) return '';
  const parts = clean.split('.');
  const ext = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext.length <= 6 ? ext : '';
}

function formatModifiedDate(fileObj) {
  const ms = typeof fileObj?.modifiedMs === 'number' ? fileObj.modifiedMs : null;
  const d = ms ? new Date(ms) : fileObj?.modified ? new Date(fileObj.modified) : null;
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Confronta due file in ordine di data decrescente (il più recente sempre in cima,
 * indipendentemente dalla cartella di provenienza).
 */
function compareDescending(a, b) {
  const nameA = cleanDriveItemName(a?.name || '', false);
  const nameB = cleanDriveItemName(b?.name || '', false);

  const dateRegex = /(\d{4})[-_.](\d{2})[-_.](\d{2})(?:[ T_-](\d{2})[-_.: ](\d{2})(?:[-_.: ](\d{2}))?)?/;
  const matchA = nameA.match(dateRegex);
  const matchB = nameB.match(dateRegex);

  if (matchA && matchB) {
    const keyA = `${matchA[1]}-${matchA[2]}-${matchA[3]} ${matchA[4] || '00'}:${matchA[5] || '00'}:${matchA[6] || '00'}`;
    const keyB = `${matchB[1]}-${matchB[2]}-${matchB[3]} ${matchB[4] || '00'}:${matchB[5] || '00'}:${matchB[6] || '00'}`;
    if (keyA !== keyB) {
      return keyB.localeCompare(keyA);
    }
  }

  // Confronto sui timestamp effettivi di caricamento/modifica su Google Drive
  if (typeof a?.modifiedMs === 'number' && typeof b?.modifiedMs === 'number' && a.modifiedMs !== b.modifiedMs) {
    return b.modifiedMs - a.modifiedMs;
  }

  if (matchA && !matchB) return -1;
  if (!matchA && matchB) return 1;

  if (a?.modified && b?.modified && a.modified !== b.modified) {
    const timeA = new Date(a.modified).getTime();
    const timeB = new Date(b.modified).getTime();
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeB - timeA;
    }
  }

  return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
}

function countFilesRecursive(node) {
  if (!node) return 0;
  let total = Array.isArray(node.files) ? node.files.length : 0;
  if (Array.isArray(node.folders)) {
    for (const sub of node.folders) {
      total += countFilesRecursive(sub);
    }
  }
  return total;
}

/**
 * Raccoglie ricorsivamente tutti i file di un nodo in una lista piatta
 * mantenendo il nome della cartella genitore diretta e il percorso contestuale.
 */
function collectAllFilesFlat(node, contextLabel = '') {
  if (!node) return [];
  let result = [];
  const nodeName = cleanDriveItemName(node.name, true);
  const currentContext = contextLabel || nodeName;

  if (Array.isArray(node.files)) {
    for (const f of node.files) {
      const renamedName = applyParentFolderNameToPdf(cleanDriveItemName(f.name, false), nodeName);
      f.name = renamedName;
      result.push({
        file: f,
        parentFolderName: nodeName,
        contextName: currentContext,
      });
    }
  }

  if (Array.isArray(node.folders)) {
    for (const sub of node.folders) {
      const subName = cleanDriveItemName(sub.name, true);
      const nextContext = contextLabel ? `${contextLabel} / ${subName}` : subName;
      result = result.concat(collectAllFilesFlat(sub, nextContext));
    }
  }

  return result;
}

function detectDominantFolderType(node) {
  const allEntries = collectAllFilesFlat(node);
  if (allEntries.length === 0) return 'folder';

  let pdfs = 0;
  let videos = 0;
  let audios = 0;

  for (const { file } of allEntries) {
    const ext = getFileExtension(file.name);
    if (ext === 'pdf') pdfs++;
    else if (['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) videos++;
    else if (['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) audios++;
  }

  if (pdfs > 0 && pdfs >= videos && pdfs >= audios) return 'pdf';
  if (videos > 0 && videos >= pdfs && videos >= audios) return 'video';
  if (audios > 0) return 'audio';
  return 'folder';
}

function getFolderButtonIconSvg(kind) {
  if (kind === 'pdf') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
  }
  if (kind === 'video') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="15" height="16" rx="2" ry="2"></rect><polygon points="17 9 22 6 22 18 17 15"></polygon></svg>`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
}

/* ==========================================================================
   4. SINCRONIZZAZIONE E NAVIGAZIONE GOOGLE DRIVE
   ========================================================================== */
async function initDriveApp() {
  let loadedFromCache = false;
  try {
    const rawCache = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE);
    const lastSync = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_LAST_SYNC);
    if (rawCache) {
      const parsed = JSON.parse(rawCache);
      if (parsed && (Array.isArray(parsed.folders) || Array.isArray(parsed.files))) {
        driveTreeData = normalizeDriveTree(parsed);
        ensureValidActiveRootFolder();
        renderDynamicRootButtons();
        renderSelectedFolderContent();
        updateMetaTimestampUI(lastSync ? parseInt(lastSync, 10) : null);
        loadedFromCache = true;
      }
    }
  } catch (err) {
    console.warn('Cache locale Drive non valida:', err);
  }

  await syncFromDrive({ isForce: false, showNotice: false, silentSpinner: loadedFromCache });
}

/**
 * Normalizza ricorsivamente nomi di cartelle e file nell'albero ricevuto,
 * sostituendo "main" nei PDF con il nome della cartella genitore.
 */
function normalizeDriveTree(node) {
  if (!node) return null;
  const folderName = cleanDriveItemName(node.name, true);

  return {
    ...node,
    name: folderName,
    files: Array.isArray(node.files)
      ? node.files
          .map((f) => {
            const cleanFile = cleanDriveItemName(f.name, false);
            return {
              ...f,
              name: applyParentFolderNameToPdf(cleanFile, folderName),
            };
          })
          .sort((a, b) => compareDescending(a, b))
      : [],
    folders: Array.isArray(node.folders)
      ? node.folders
          .map((sub) => normalizeDriveTree(sub))
          .filter(Boolean)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      : [],
  };
}

async function syncFromDrive({ isForce = false, showNotice = false, silentSpinner = false } = {}) {
  if (isSyncingDrive) return;
  isSyncingDrive = true;

  const loadingEl = document.getElementById('drive-loading-state');
  const syncBtn = document.getElementById('btn-drive-sync');
  const syncIcon = document.getElementById('sync-btn-icon');

  if (!silentSpinner && loadingEl && !driveTreeData) {
    loadingEl.classList.remove('hidden');
  }
  if (syncBtn) syncBtn.disabled = true;
  if (syncIcon) syncIcon.classList.add('spin-icon');

  try {
    const folderId = window.APP_CONFIG.DEFAULT_DRIVE_FOLDER_ID;
    const url = `/api/drive/tree?folderId=${encodeURIComponent(folderId)}${isForce ? '&force=true' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    if (!payload || !payload.tree) throw new Error('Struttura cartella Drive non valida');

    driveTreeData = normalizeDriveTree(payload.tree);
    const ts = payload.timestamp || Date.now();

    try {
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE, JSON.stringify(driveTreeData));
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_LAST_SYNC, String(ts));
    } catch (storageErr) {
      console.warn('Impossibile salvare cache albero Drive:', storageErr);
    }

    ensureValidActiveRootFolder();
    renderDynamicRootButtons();
    renderSelectedFolderContent();
    updateMetaTimestampUI(ts);

    if (showNotice) {
      const subfoldersCount = (driveTreeData.folders || []).length;
      showToast(`Google Drive aggiornato (${subfoldersCount} cartelle principali)`, 'success');
    }
  } catch (err) {
    console.error('Errore sincronizzazione Google Drive:', err);
    if (showNotice || !driveTreeData) {
      showToast('Impossibile contattare Google Drive. Controlla la connessione.', 'error');
    }
    if (!driveTreeData) {
      renderSelectedFolderContent();
    }
  } finally {
    isSyncingDrive = false;
    if (loadingEl) loadingEl.classList.add('hidden');
    if (syncBtn) syncBtn.disabled = false;
    if (syncIcon) syncIcon.classList.remove('spin-icon');
  }
}

function ensureValidActiveRootFolder() {
  if (!driveTreeData) return;

  const rootFolders = driveTreeData.folders || [];
  const hasRootDirectFiles = Array.isArray(driveTreeData.files) && driveTreeData.files.length > 0;

  const rootSubtitle = document.getElementById('drive-root-subtitle');
  if (rootSubtitle && driveTreeData.name) {
    rootSubtitle.textContent = driveTreeData.name;
  }

  const isValidId = (id) => {
    if (!id) return false;
    if (id === '__root_files__' && hasRootDirectFiles) return true;
    return rootFolders.some((f) => f.id === id);
  };

  if (isValidId(activeRootFolderId)) return;

  const savedDefault = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DEFAULT_FOLDER);
  if (isValidId(savedDefault)) {
    activeRootFolderId = savedDefault;
    return;
  }

  const savedActive = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_ACTIVE_FOLDER);
  if (isValidId(savedActive)) {
    activeRootFolderId = savedActive;
    return;
  }

  const pdfFolder = rootFolders.find((f) => detectDominantFolderType(f) === 'pdf');
  if (pdfFolder) {
    activeRootFolderId = pdfFolder.id;
  } else if (rootFolders.length > 0) {
    activeRootFolderId = rootFolders[0].id;
  } else if (hasRootDirectFiles) {
    activeRootFolderId = '__root_files__';
  } else {
    activeRootFolderId = null;
  }
}

function renderDynamicRootButtons() {
  const bar = document.getElementById('drive-folders-bar');
  if (!bar) return;

  bar.innerHTML = '';
  if (!driveTreeData) return;

  const rootFolders = driveTreeData.folders || [];
  const rootDirectFiles = driveTreeData.files || [];

  rootFolders.forEach((folder) => {
    const isActive = folder.id === activeRootFolderId;
    const totalFiles = countFilesRecursive(folder);
    const kind = detectDominantFolderType(folder);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab-btn root-folder-btn ${isActive ? 'active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.dataset.folderId = folder.id;

    btn.innerHTML = `
      ${getFolderButtonIconSvg(kind)}
      <span>${escapeHtml(folder.name)}</span>
      <span class="tab-count">(${totalFiles})</span>
    `;

    btn.addEventListener('click', () => {
      selectRootSubfolder(folder.id, btn);
    });

    bar.appendChild(btn);
  });

  if (rootDirectFiles.length > 0) {
    const isActive = activeRootFolderId === '__root_files__';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab-btn root-folder-btn ${isActive ? 'active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.dataset.folderId = '__root_files__';

    btn.innerHTML = `
      ${getFolderButtonIconSvg('pdf')}
      <span>File Principali</span>
      <span class="tab-count">(${rootDirectFiles.length})</span>
    `;

    btn.addEventListener('click', () => {
      selectRootSubfolder('__root_files__', btn);
    });

    bar.appendChild(btn);
  }
}

function selectRootSubfolder(folderId, buttonEl) {
  activeRootFolderId = folderId;
  activeSubfolderFilter = 'all';

  try {
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_ACTIVE_FOLDER, folderId);
  } catch (err) {}

  document.querySelectorAll('#drive-folders-bar .root-folder-btn').forEach((b) => {
    const selected = b.dataset.folderId === folderId;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
  });

  if (buttonEl && typeof buttonEl.scrollIntoView === 'function') {
    buttonEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  renderSelectedFolderContent();
}

function getSelectedRootFolderNode() {
  if (!driveTreeData) return null;
  if (activeRootFolderId === '__root_files__') {
    return {
      id: '__root_files__',
      name: driveTreeData.name || 'File Principali',
      isFolder: true,
      folders: [],
      files: driveTreeData.files || [],
    };
  }
  return (driveTreeData.folders || []).find((f) => f.id === activeRootFolderId) || null;
}

function setRootFolderAsDefault(folderNode) {
  if (!folderNode) return;
  try {
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DEFAULT_FOLDER, folderNode.id);
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_ACTIVE_FOLDER, folderNode.id);
    showToast(`"${folderNode.name}" impostata come sezione predefinita all'avvio`, 'success');
    renderSelectedFolderContent();
  } catch (err) {}
}

/* ==========================================================================
   5. RENDERING LISTA UNIFICATA IN ORDINE DI DATA DECRESCENTE (SENZA SEPARAZIONE CARTELLE)
   ========================================================================== */
function renderSelectedFolderContent() {
  const container = document.getElementById('drive-content-view');
  const emptyState = document.getElementById('drive-empty-state');
  const emptyTitle = document.getElementById('drive-empty-title');
  const emptyDesc = document.getElementById('drive-empty-desc');
  const searchInput = document.getElementById('drive-search-input');
  const searchQuery = (searchInput ? searchInput.value : '').trim().toLowerCase();

  if (!container) return;
  container.innerHTML = '';
  currentlyVisibleFiles = [];

  const activeFolder = getSelectedRootFolderNode();
  if (!activeFolder) {
    if (emptyState && !isSyncingDrive) {
      emptyState.classList.remove('hidden');
      if (emptyTitle) emptyTitle.textContent = 'Nessuna cartella disponibile';
      if (emptyDesc) {
        emptyDesc.textContent =
          'Premi Aggiorna per sincronizzare le sottocartelle della cartella condivisa su Google Drive.';
      }
    }
    return;
  }

  const defaultFolderId = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DEFAULT_FOLDER);
  const isDefault = defaultFolderId === activeFolder.id;
  const totalFilesInFolder = countFilesRecursive(activeFolder);

  // Header della sezione attiva
  const header = document.createElement('div');
  header.className = 'drive-level-header';
  header.innerHTML = `
    <div class="drive-level-title">
      ${getFolderButtonIconSvg(detectDominantFolderType(activeFolder))}
      <span>${escapeHtml(activeFolder.name)}</span>
      <button class="btn-set-default ${isDefault ? 'is-default' : ''}" type="button" title="${
    isDefault ? "Cartella predefinita all'avvio" : "Imposta come predefinita all'avvio"
  }">
        ${isDefault ? '★ Predefinita' : '☆ Imposta predefinita'}
      </button>
    </div>
    <div class="drive-level-count">${totalFilesInFolder} file totali</div>
  `;

  const btnDefault = header.querySelector('.btn-set-default');
  if (btnDefault) {
    btnDefault.addEventListener('click', () => setRootFolderAsDefault(activeFolder));
  }
  container.appendChild(header);

  const childFolders = activeFolder.folders || [];

  // Barra filtro rapida ("Tutte" mostra tutti i file mescolati in ordine cronologico decrescente)
  if (childFolders.length > 1) {
    const filterBar = document.createElement('div');
    filterBar.className = 'subfolder-filter-bar';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `subfolder-filter-btn ${activeSubfolderFilter === 'all' ? 'active' : ''}`;
    allBtn.textContent = `Tutte (${totalFilesInFolder})`;
    allBtn.addEventListener('click', () => {
      activeSubfolderFilter = 'all';
      renderSelectedFolderContent();
    });
    filterBar.appendChild(allBtn);

    childFolders.forEach((sub) => {
      const subCount = countFilesRecursive(sub);
      const subBtn = document.createElement('button');
      subBtn.type = 'button';
      subBtn.className = `subfolder-filter-btn ${activeSubfolderFilter === sub.id ? 'active' : ''}`;
      subBtn.textContent = `${sub.name} (${subCount})`;
      subBtn.addEventListener('click', () => {
        activeSubfolderFilter = sub.id;
        renderSelectedFolderContent();
      });
      filterBar.appendChild(subBtn);
    });

    container.appendChild(filterBar);
  }

  // Raccoglie TUTTI i file in un'unica lista piatta (senza separazione in cartelle)
  let unifiedEntries = [];

  if (activeSubfolderFilter === 'all') {
    // Eventuali file diretti nella sottocartella attiva
    for (const f of activeFolder.files || []) {
      f.name = applyParentFolderNameToPdf(cleanDriveItemName(f.name, false), activeFolder.name);
      unifiedEntries.push({
        file: f,
        parentFolderName: activeFolder.name,
        contextName: activeFolder.name,
      });
    }
    // Tutti i file di tutte le sottocartelle interne mescolati insieme
    for (const sub of childFolders) {
      unifiedEntries = unifiedEntries.concat(collectAllFilesFlat(sub, sub.name));
    }
  } else {
    const chosenSub = childFolders.find((s) => s.id === activeSubfolderFilter);
    if (chosenSub) {
      unifiedEntries = collectAllFilesFlat(chosenSub, chosenSub.name);
    }
  }

  // Applica eventuale filtro di ricerca testuale e ordina globalmente per data decrescente
  const filteredAndSorted = unifiedEntries
    .filter(({ file, contextName }) => {
      if (!searchQuery) return true;
      return (
        file.name.toLowerCase().includes(searchQuery) ||
        contextName.toLowerCase().includes(searchQuery)
      );
    })
    .sort((a, b) => compareDescending(a.file, b.file));

  if (filteredAndSorted.length === 0) {
    if (emptyState) {
      emptyState.classList.remove('hidden');
      if (emptyTitle) {
        emptyTitle.textContent = searchQuery
          ? `Nessun risultato per "${searchInput.value.trim()}"`
          : `Nessun file in "${activeFolder.name}"`;
      }
      if (emptyDesc) {
        emptyDesc.textContent = searchQuery
          ? 'Prova a modificare i termini di ricerca o seleziona Tutte.'
          : 'Questa sottocartella su Google Drive non contiene attualmente file.';
      }
    }
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  currentlyVisibleFiles = filteredAndSorted.map((entry) => entry.file);

  // Costruisce un unico contenitore pulito con tutti i file ordinati dal più recente
  const listCard = document.createElement('div');
  listCard.className = 'lesson-card expanded';

  const cardBody = document.createElement('div');
  cardBody.className = 'lesson-body';

  if (currentlyVisibleFiles.length > 1) {
    const allSelected = currentlyVisibleFiles.every((f) => selectedFiles.has(f.id));
    const activeFilterLabel =
      activeSubfolderFilter === 'all'
        ? `Più recenti in cima (${currentlyVisibleFiles.length} file)`
        : `${
            (childFolders.find((s) => s.id === activeSubfolderFilter) || {}).name || ''
          } • Più recenti in cima (${currentlyVisibleFiles.length})`;

    const toolbar = document.createElement('div');
    toolbar.className = 'lesson-toolbar';
    toolbar.innerHTML = `
      <span>${escapeHtml(activeFilterLabel)}</span>
      <button class="lesson-select-all-btn" type="button">
        ${allSelected ? 'Deseleziona tutti' : `Seleziona tutti (${currentlyVisibleFiles.length})`}
      </button>
    `;

    const selectAllBtn = toolbar.querySelector('.lesson-select-all-btn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        if (allSelected) {
          currentlyVisibleFiles.forEach((f) => selectedFiles.delete(f.id));
        } else {
          currentlyVisibleFiles.forEach((f) => selectedFiles.set(f.id, f));
        }
        updateBatchBarUI();
        renderSelectedFolderContent();
      });
    }
    cardBody.appendChild(toolbar);
  }

  const fragment = document.createDocumentFragment();
  filteredAndSorted.forEach(({ file, contextName }) => {
    fragment.appendChild(createDriveFileElement(file, contextName));
  });
  cardBody.appendChild(fragment);

  listCard.appendChild(cardBody);
  container.appendChild(listCard);
}

/**
 * Crea la riga / card singola per un file (.pdf, .mp4, .mp3, ecc.)
 */
function createDriveFileElement(fileObj, contextName) {
  const isSelected = selectedFiles.has(fileObj.id);
  const displayName = applyParentFolderNameToPdf(cleanDriveItemName(fileObj.name, false), contextName);
  fileObj.name = displayName;

  const ext = getFileExtension(displayName) || 'file';
  const isPdf = ext === 'pdf';
  const isVideo = ['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext);

  let iconClass = 'recording-audio-icon type-audio';
  let tagClass = 'recording-tag tag-audio';
  let primaryBtnLabel = 'Ascolta';
  let primaryBtnTitle = 'Ascolta registrazione audio';
  let primaryBtnIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  let iconSvg = '';

  if (isPdf) {
    iconClass = 'recording-audio-icon type-pdf';
    tagClass = 'recording-tag tag-pdf';
    primaryBtnLabel = 'Leggi PDF';
    primaryBtnTitle = 'Apri documento PDF nel lettore a schermo intero';
    primaryBtnIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`;
    iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;
  } else if (isVideo) {
    iconClass = 'recording-audio-icon type-video';
    tagClass = 'recording-tag tag-video';
    primaryBtnLabel = 'Guarda';
    primaryBtnTitle = 'Riproduci lezione video';
    iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="15" height="16" rx="2" ry="2"></rect><polygon points="17 9 22 6 22 18 17 15"></polygon></svg>`;
  } else {
    iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
  }

  const formattedDate = formatModifiedDate(fileObj);
  const isPlaying = activeAudioFile && activeAudioFile.id === fileObj.id;

  const item = document.createElement('div');
  item.className = `recording-item ${isSelected ? 'selected' : ''} ${isPlaying ? 'is-playing' : ''}`;
  item.id = `recording-row-${fileObj.id}`;

  item.innerHTML = `
    <div class="recording-left">
      <input type="checkbox" class="recording-checkbox" aria-label="Seleziona ${escapeHtml(displayName)}" ${
    isSelected ? 'checked' : ''
  }>
      <div class="${iconClass}">
        ${iconSvg}
      </div>
      <div class="recording-details">
        <div class="recording-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
        <div class="recording-meta">
          <span class="${tagClass}">${escapeHtml(ext.toUpperCase())}</span>
          <span>${escapeHtml(contextName)}</span>
          ${fileObj.size ? `<span>• ${escapeHtml(fileObj.size)}</span>` : ''}
          ${formattedDate ? `<span>• ${escapeHtml(formattedDate)}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="recording-actions">
      <button type="button" class="recording-btn-play" title="${escapeHtml(primaryBtnTitle)}">
        ${primaryBtnIcon}
        <span>${primaryBtnLabel}</span>
      </button>
      <button type="button" class="recording-btn-download" title="Scarica ${escapeHtml(displayName)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Scarica</span>
      </button>
    </div>
  `;

  const checkbox = item.querySelector('.recording-checkbox');
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    if (checkbox.checked) {
      selectedFiles.set(fileObj.id, fileObj);
      item.classList.add('selected');
    } else {
      selectedFiles.delete(fileObj.id);
      item.classList.remove('selected');
    }
    updateBatchBarUI();
  });

  if (isPdf) {
    const detailsEl = item.querySelector('.recording-details');
    if (detailsEl) {
      detailsEl.style.cursor = 'pointer';
      detailsEl.addEventListener('click', () => openDrivePdfFile(fileObj, contextName));
    }
  }

  const playBtn = item.querySelector('.recording-btn-play');
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPdf) {
      openDrivePdfFile(fileObj, contextName);
    } else if (isVideo) {
      openVideoModal(fileObj, contextName);
    } else {
      playAudioRecording(fileObj, contextName);
    }
  });

  const dlBtn = item.querySelector('.recording-btn-download');
  dlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadSingleFile(fileObj, contextName);
  });

  return item;
}

/* ==========================================================================
   6. APERTURA PDF, LETTORE VIDEO MP4, MINI-PLAYER AUDIO & DOWNLOAD BLOB
   ========================================================================== */
async function openDrivePdfFile(fileObj, contextName) {
  const displayName = applyParentFolderNameToPdf(cleanDriveItemName(fileObj.name, false), contextName);
  fileObj.name = displayName;

  const overlay = document.getElementById('pdf-viewer-overlay');
  const loadingState = document.getElementById('viewer-loading');
  const titleEl = document.getElementById('viewer-doc-title');
  const subtitleEl = document.getElementById('viewer-doc-subtitle');

  if (overlay) overlay.classList.remove('hidden');
  if (loadingState) loadingState.classList.remove('hidden');
  if (titleEl) titleEl.textContent = displayName.replace(/\.pdf$/i, '');
  if (subtitleEl) subtitleEl.textContent = `${contextName || ''} • ${displayName}`;
  document.body.style.overflow = 'hidden';

  try {
    let arrayBuffer = null;

    if (!navigator.onLine) {
      const cached = await dbGetCachedPdf(fileObj.id);
      if (cached && cached.data) {
        arrayBuffer = cached.data;
      }
    }

    if (!arrayBuffer) {
      try {
        const downloadUrl = `/api/drive/download/${encodeURIComponent(fileObj.id)}?name=${encodeURIComponent(
          displayName
        )}&inline=1`;
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        arrayBuffer = await res.arrayBuffer();
        dbSaveCachedPdf(fileObj.id, displayName, arrayBuffer);
      } catch (networkErr) {
        const cached = await dbGetCachedPdf(fileObj.id);
        if (cached && cached.data) {
          arrayBuffer = cached.data;
          showToast('Apertura copia memorizzata offline', 'info');
        } else {
          throw networkErr;
        }
      }
    }

    await openPdfViewer({
      id: fileObj.id,
      title: displayName.replace(/\.pdf$/i, ''),
      subtitle: `${contextName || ''} • ${displayName}`,
      fileName: displayName,
      data: arrayBuffer,
    });
  } catch (err) {
    console.error('Errore apertura PDF da Google Drive:', err);
    await closePdfViewer();
    showToast('Impossibile caricare il PDF nel lettore. Avvio download diretto...', 'info');
    downloadSingleFile(fileObj, contextName);
  }
}

function openVideoModal(fileObj, contextName) {
  closeAudioPlayer();

  const modal = document.getElementById('video-player-overlay');
  const videoEl = document.getElementById('global-video-element');
  const titleEl = document.getElementById('video-player-title');
  const subtitleEl = document.getElementById('video-player-subtitle');

  if (!modal || !videoEl) return;

  if (titleEl) titleEl.textContent = fileObj.name;
  if (subtitleEl) subtitleEl.textContent = contextName || 'Video Lezione';

  videoEl.src = `/api/drive/download/${encodeURIComponent(fileObj.id)}?name=${encodeURIComponent(
    fileObj.name
  )}&inline=1`;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  videoEl.play().catch((err) => {
    console.warn('Autoplay video gestito dal browser:', err);
  });
}

function closeVideoModal() {
  const modal = document.getElementById('video-player-overlay');
  const videoEl = document.getElementById('global-video-element');
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function playAudioRecording(fileObj, contextName) {
  const playerBar = document.getElementById('audio-player-bar');
  const titleEl = document.getElementById('audio-player-title');
  const subtitleEl = document.getElementById('audio-player-subtitle');
  const audioEl = document.getElementById('global-audio-element');

  if (!playerBar || !audioEl) return;

  activeAudioFile = fileObj;
  if (titleEl) titleEl.textContent = fileObj.name;
  if (subtitleEl) subtitleEl.textContent = contextName || 'Audio';

  document.querySelectorAll('.recording-item.is-playing').forEach((el) => el.classList.remove('is-playing'));
  const rowEl = document.getElementById(`recording-row-${fileObj.id}`);
  if (rowEl) rowEl.classList.add('is-playing');

  audioEl.src = `/api/drive/download/${encodeURIComponent(fileObj.id)}?name=${encodeURIComponent(
    fileObj.name
  )}&inline=1`;
  audioEl.play().catch((err) => {
    console.warn('Autoplay audio bloccato:', err);
  });

  audioEl.onended = () => {
    document.querySelectorAll('.recording-item.is-playing').forEach((el) => el.classList.remove('is-playing'));
  };
  audioEl.onpause = () => {
    document.querySelectorAll('.recording-item.is-playing').forEach((el) => el.classList.remove('is-playing'));
  };
  audioEl.onplay = () => {
    if (activeAudioFile) {
      const curRow = document.getElementById(`recording-row-${activeAudioFile.id}`);
      if (curRow) curRow.classList.add('is-playing');
    }
  };

  playerBar.classList.remove('hidden');
}

function closeAudioPlayer() {
  const playerBar = document.getElementById('audio-player-bar');
  const audioEl = document.getElementById('global-audio-element');
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
  }
  document.querySelectorAll('.recording-item.is-playing').forEach((el) => el.classList.remove('is-playing'));
  if (playerBar) playerBar.classList.add('hidden');
  activeAudioFile = null;
}

/**
 * Scarica un singolo file salvandolo sul dispositivo con il nome rinominato
 * (es. "Tecnologie Web-A4.pdf" invece di "main-A4.pdf").
 */
async function downloadSingleFile(fileObj, contextName = '') {
  const renamedClean = applyParentFolderNameToPdf(cleanDriveItemName(fileObj.name, false), contextName);
  const finalFilename = /\.[a-zA-Z0-9]+$/.test(renamedClean) ? renamedClean : `${renamedClean}.pdf`;
  fileObj.name = finalFilename;

  showToast(`Preparazione download: ${finalFilename}...`, 'info');
  const proxyDownloadUrl = `/api/drive/download/${encodeURIComponent(fileObj.id)}?name=${encodeURIComponent(
    finalFilename
  )}`;

  try {
    const res = await fetch(proxyDownloadUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentLength = res.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    const mimeType = res.headers.get('content-type') || 'application/octet-stream';

    let blob;
    if (res.body && res.body.getReader && totalBytes > 2 * 1024 * 1024) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      let lastToast = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;

        const now = Date.now();
        if (totalBytes > 0 && now - lastToast > 2200) {
          lastToast = now;
          const pct = Math.round((loaded / totalBytes) * 100);
          const mbL = (loaded / (1024 * 1024)).toFixed(1);
          const mbT = (totalBytes / (1024 * 1024)).toFixed(1);
          showToast(`Scaricamento: ${pct}% (${mbL} / ${mbT} MB)`, 'info');
        }
      }
      blob = new Blob(chunks, { type: mimeType });
    } else {
      blob = await res.blob();
    }

    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(blobUrl), 45000);
    showToast(`Download completato: ${finalFilename}`, 'success');
  } catch (err) {
    console.error('Errore download file:', err);
    // Usa il proxy same-origin che imposta Content-Disposition con il nome rinominato
    const fallbackLink = document.createElement('a');
    fallbackLink.href = proxyDownloadUrl;
    fallbackLink.download = finalFilename;
    document.body.appendChild(fallbackLink);
    fallbackLink.click();
    fallbackLink.remove();
  }
}

function updateBatchBarUI() {
  const batchBar = document.getElementById('recordings-batch-bar');
  const countBadge = document.getElementById('batch-selected-count');
  const dlButtonText = document.getElementById('btn-batch-download-text');

  const count = selectedFiles.size;
  if (count > 0) {
    if (batchBar) batchBar.classList.remove('hidden');
    if (countBadge) countBadge.textContent = String(count);
    if (dlButtonText) dlButtonText.textContent = `Scarica (${count})`;
  } else if (batchBar) {
    batchBar.classList.add('hidden');
  }
}

async function downloadSelectedBatchFiles() {
  const filesToDownload = Array.from(selectedFiles.values());
  if (filesToDownload.length === 0) return;

  showToast(`Avvio download di ${filesToDownload.length} file...`, 'info');
  for (let i = 0; i < filesToDownload.length; i++) {
    await downloadSingleFile(filesToDownload[i]);
    if (i < filesToDownload.length - 1) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  selectedFiles.clear();
  updateBatchBarUI();
  renderSelectedFolderContent();
}

/* ==========================================================================
   7. VISUALIZZATORE PDF A SCHERMO INTERO (PDF.js)
   ========================================================================== */
async function openPdfViewer(pdfItem) {
  if (!pdfItem || !pdfItem.data) return;

  if (currentPdfDoc || isRenderingPage || currentLoadingTask) {
    if (currentRenderTask) {
      try {
        currentRenderTask.cancel();
      } catch (e) {}
      currentRenderTask = null;
    }
    if (currentLoadingTask) {
      try {
        currentLoadingTask.destroy();
      } catch (e) {}
      currentLoadingTask = null;
    }
    if (currentPdfDoc) {
      try {
        await currentPdfDoc.destroy();
      } catch (e) {}
      currentPdfDoc = null;
    }
  }

  const overlay = document.getElementById('pdf-viewer-overlay');
  const titleEl = document.getElementById('viewer-doc-title');
  const subtitleEl = document.getElementById('viewer-doc-subtitle');
  const loadingState = document.getElementById('viewer-loading');

  currentPdfItem = pdfItem;
  currentZoom = 1.0;
  isRenderingPage = false;
  pageRenderingQueue = null;

  if (titleEl) titleEl.textContent = pdfItem.title || pdfItem.fileName || 'Documento PDF';
  if (subtitleEl) subtitleEl.textContent = pdfItem.subtitle || pdfItem.fileName || '';
  if (overlay) overlay.classList.remove('hidden');
  if (loadingState) loadingState.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const buf = pdfItem.data instanceof ArrayBuffer ? pdfItem.data : pdfItem.data.buffer;
    const dataCopy = new Uint8Array(buf.slice(0));

    if (!window.pdfjsLib) {
      throw new Error('Libreria PDF.js non disponibile');
    }

    currentLoadingTask = window.pdfjsLib.getDocument({ data: dataCopy });
    currentPdfDoc = await currentLoadingTask.promise;
    currentLoadingTask = null;

    // Ripristina l'ultima pagina letta se memorizzata
    const savedPage = getSavedPdfPage(pdfItem.id);
    currentPageNum = savedPage >= 1 && savedPage <= currentPdfDoc.numPages ? savedPage : 1;

    detectedIndexPageNum = currentPdfDoc.numPages >= 2 ? 2 : 1;
    try {
      const outline = await currentPdfDoc.getOutline();
      if (outline && outline.length > 0) {
        for (const item of outline) {
          const t = (item.title || '').toLowerCase();
          if (
            t.includes('indice') ||
            t.includes('sommario') ||
            t.includes('contents') ||
            t.includes('table of contents')
          ) {
            let dest = item.dest;
            if (typeof dest === 'string') {
              dest = await currentPdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest.length > 0) {
              const ref = dest[0];
              const pageIdx =
                ref && typeof ref === 'object'
                  ? await currentPdfDoc.getPageIndex(ref)
                  : typeof ref === 'number'
                  ? ref
                  : null;
              if (pageIdx !== null && pageIdx >= 0) {
                detectedIndexPageNum = pageIdx + 1;
                break;
              }
            }
          }
        }
      }
    } catch (e) {}

    const totalPagesEl = document.getElementById('total-pages');
    if (totalPagesEl) totalPagesEl.textContent = String(currentPdfDoc.numPages);

    const pageInput = document.getElementById('page-input');
    if (pageInput) {
      pageInput.max = String(currentPdfDoc.numPages);
      pageInput.value = String(currentPageNum);
    }

    await renderCurrentPage();
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('Errore rendering PDF:', err);
    showToast('Impossibile visualizzare il PDF: ' + err.message, 'error');
    await closePdfViewer();
  } finally {
    if (loadingState) loadingState.classList.add('hidden');
  }
}

async function closePdfViewer() {
  if (currentRenderTask) {
    try {
      currentRenderTask.cancel();
    } catch (e) {}
    currentRenderTask = null;
  }
  if (currentLoadingTask) {
    try {
      currentLoadingTask.destroy();
    } catch (e) {}
    currentLoadingTask = null;
  }
  if (currentPdfDoc) {
    try {
      await currentPdfDoc.destroy();
    } catch (e) {}
    currentPdfDoc = null;
  }

  isRenderingPage = false;
  pageRenderingQueue = null;
  currentPdfItem = null;
  currentPageNum = 1;

  const overlay = document.getElementById('pdf-viewer-overlay');
  if (overlay) overlay.classList.add('hidden');

  const loadingState = document.getElementById('viewer-loading');
  if (loadingState) loadingState.classList.add('hidden');

  document.body.style.overflow = '';

  const stage = document.getElementById('pdf-viewer-stage');
  if (stage) {
    stage.querySelectorAll('.pdf-page-container').forEach((el) => el.remove());
  }
}

async function renderCurrentPage() {
  if (!currentPdfDoc) {
    isRenderingPage = false;
    return;
  }

  if (isRenderingPage) {
    pageRenderingQueue = currentPageNum;
    if (currentRenderTask) {
      try {
        currentRenderTask.cancel();
      } catch (e) {}
    }
    return;
  }

  isRenderingPage = true;
  const stage = document.getElementById('pdf-viewer-stage');
  const pageInput = document.getElementById('page-input');
  if (pageInput) pageInput.value = String(currentPageNum);

  if (currentPdfItem?.id) {
    savePdfPage(currentPdfItem.id, currentPageNum);
  }

  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');
  if (prevBtn) prevBtn.disabled = currentPageNum <= 1;
  if (nextBtn) nextBtn.disabled = currentPageNum >= currentPdfDoc.numPages;

  try {
    const page = await currentPdfDoc.getPage(currentPageNum);
    const isSmallScreen = window.innerWidth < 640;
    const stagePadding = isSmallScreen ? 12 : 32;
    const containerWidth = Math.max(260, stage.clientWidth - stagePadding);
    const unscaledViewport = page.getViewport({ scale: 1.0 });

    const fitScale = Math.min(3.0, Math.max(0.4, containerWidth / unscaledViewport.width));
    const calculatedScale = fitScale * currentZoom;

    const viewport = page.getViewport({ scale: calculatedScale });
    const pixelRatio = window.devicePixelRatio || 1;

    stage.querySelectorAll('.pdf-page-container').forEach((el) => el.remove());

    const pageContainer = document.createElement('div');
    pageContainer.className = `pdf-page-container ${isPdfInvertMode ? 'invert-mode' : ''}`;
    pageContainer.style.width = `${viewport.width}px`;
    pageContainer.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(pixelRatio, pixelRatio);

    pageContainer.appendChild(canvas);
    stage.appendChild(pageContainer);

    currentRenderTask = page.render({ canvasContext: ctx, viewport });
    await currentRenderTask.promise;
    currentRenderTask = null;

    await addLinkAnnotations(page, viewport, pageContainer);

    // Pre-carica silenziosamente in memoria la pagina successiva per sfoglio istantaneo
    if (currentPdfDoc && currentPageNum < currentPdfDoc.numPages) {
      currentPdfDoc.getPage(currentPageNum + 1).catch(() => {});
    }
  } catch (renderError) {
    if (
      renderError &&
      (renderError.name === 'RenderingCancelledException' || renderError.message?.includes('cancelled'))
    ) {
      return;
    }
    console.error('Errore rendering pagina PDF:', renderError);
  } finally {
    isRenderingPage = false;
    if (pageRenderingQueue !== null) {
      const nextNum = pageRenderingQueue;
      pageRenderingQueue = null;
      currentPageNum = nextNum;
      renderCurrentPage();
    }
  }
}

function goToPage(num) {
  if (!currentPdfDoc) return;
  if (Number.isInteger(num) && num >= 1 && num <= currentPdfDoc.numPages) {
    currentPageNum = num;
    const stage = document.getElementById('pdf-viewer-stage');
    if (stage) stage.scrollTop = 0;
    renderCurrentPage();
  }
}

async function addLinkAnnotations(page, viewport, pageContainer) {
  if (!window.pdfjsLib || !pageContainer || !page) return;

  let annotations = [];
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch (e) {
    return;
  }

  for (const annot of annotations) {
    if (annot.subtype !== 'Link' || !annot.rect) continue;

    let rect;
    try {
      rect = viewport.convertToViewportRectangle(annot.rect);
    } catch (e) {
      continue;
    }

    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const width = Math.abs(rect[2] - rect[0]);
    const height = Math.abs(rect[3] - rect[1]);
    if (width < 1 || height < 1) continue;

    const linkEl = document.createElement('a');
    linkEl.className = 'pdf-link-annotation';
    linkEl.style.left = `${left}px`;
    linkEl.style.top = `${top}px`;
    linkEl.style.width = `${width}px`;
    linkEl.style.height = `${height}px`;

    if (annot.url) {
      linkEl.href = annot.url;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      linkEl.title = annot.url;
    } else {
      linkEl.href = '#';
      linkEl.title = 'Vai alla sezione collegata';
      linkEl.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!currentPdfDoc) return;
        try {
          let dest = annot.dest;
          if (typeof dest === 'string') {
            dest = await currentPdfDoc.getDestination(dest);
          }
          if (Array.isArray(dest) && dest.length > 0) {
            const ref = dest[0];
            const pageIndex =
              ref && typeof ref === 'object'
                ? await currentPdfDoc.getPageIndex(ref)
                : typeof ref === 'number'
                ? ref
                : null;
            if (pageIndex !== null) {
              goToPage(pageIndex + 1);
            }
          }
        } catch (err) {
          console.warn('Impossibile seguire link PDF:', err);
        }
      });
    }

    pageContainer.appendChild(linkEl);
  }
}

function prevPage() {
  if (currentPageNum <= 1) return;
  currentPageNum--;
  const stage = document.getElementById('pdf-viewer-stage');
  if (stage) stage.scrollTop = 0;
  renderCurrentPage();
}

function nextPage() {
  if (!currentPdfDoc || currentPageNum >= currentPdfDoc.numPages) return;
  currentPageNum++;
  const stage = document.getElementById('pdf-viewer-stage');
  if (stage) stage.scrollTop = 0;
  renderCurrentPage();
}

function zoomIn() {
  currentZoom = Math.min(2.75, currentZoom * 1.2);
  renderCurrentPage();
}

function zoomOut() {
  currentZoom = Math.max(0.6, currentZoom / 1.2);
  renderCurrentPage();
}

function togglePdfInvert() {
  isPdfInvertMode = !isPdfInvertMode;
  const container = document.querySelector('.pdf-page-container');
  if (container) {
    container.classList.toggle('invert-mode', isPdfInvertMode);
  }
  const btn = document.getElementById('btn-invert-pdf');
  if (btn) {
    btn.classList.toggle('active', isPdfInvertMode);
  }
}

/* ==========================================================================
   8. TEMA, TOAST E PWA
   ========================================================================== */
function initTheme() {
  let theme = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_THEME);
  if (!theme) {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  applyTheme(theme);

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_THEME)) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', theme === 'dark' ? '#090d16' : '#ffffff');
  }

  const themeBtn = document.getElementById('btn-toggle-theme');
  if (themeBtn) {
    themeBtn.setAttribute('title', theme === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro');
    themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro');
    themeBtn.innerHTML =
      theme === 'dark'
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_THEME, next);
  applyTheme(next);
}

function updateMetaTimestampUI(timestamp) {
  const metaText = document.getElementById('drive-meta-text');
  if (!metaText) return;

  const rootTitle = driveTreeData?.name || 'Google Drive';
  if (!timestamp) {
    metaText.textContent = `Cartella condivisa: ${rootTitle}`;
    return;
  }

  const d = new Date(timestamp);
  const formatted = d.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  metaText.textContent = `${rootTitle} • Aggiornato il ${formatted}`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3800);
}

function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
    });
  }

  const installBtn = document.getElementById('btn-install-pwa');
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if (isStandalone && installBtn) {
    installBtn.style.display = 'none';
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn && !isStandalone) {
      installBtn.style.display = 'inline-flex';
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.style.display = 'none';
    showToast('Applicazione installata con successo!', 'success');
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          installBtn.style.display = 'none';
        }
        deferredInstallPrompt = null;
      } else {
        showToast('Usa il menu del browser e seleziona "Aggiungi a schermata Home".', 'info');
      }
    });
  }
}

/* ==========================================================================
   9. INIZIALIZZAZIONE EVENTI DOM
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  await window.APP_CONFIG.loadServerConfig();

  initTheme();
  initPWA();

  const themeBtn = document.getElementById('btn-toggle-theme');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  const syncBtn = document.getElementById('btn-drive-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => syncFromDrive({ isForce: true, showNotice: true }));
  }

  const emptyRefreshBtn = document.getElementById('btn-drive-empty-refresh');
  if (emptyRefreshBtn) {
    emptyRefreshBtn.addEventListener('click', () => syncFromDrive({ isForce: true, showNotice: true }));
  }

  // Ricerca live con debounce di 120ms per fluidità ottimale su mobile
  const searchInput = document.getElementById('drive-search-input');
  const searchClear = document.getElementById('drive-search-clear');
  let searchDebounceTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.classList.toggle('visible', searchInput.value.length > 0);
      }
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderSelectedFolderContent();
      }, 120);
    });
  }
  if (searchClear && searchInput) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      clearTimeout(searchDebounceTimer);
      renderSelectedFolderContent();
      searchInput.focus();
    });
  }

  // Selezione multipla (opera sui file attualmente visibili nella vista corrente)
  const batchSelectAllBtn = document.getElementById('btn-batch-select-all');
  if (batchSelectAllBtn) {
    batchSelectAllBtn.addEventListener('click', () => {
      if (currentlyVisibleFiles.length === 0) return;
      currentlyVisibleFiles.forEach((file) => selectedFiles.set(file.id, file));
      updateBatchBarUI();
      renderSelectedFolderContent();
      showToast(`${currentlyVisibleFiles.length} file selezionati`, 'info');
    });
  }

  const batchClearBtn = document.getElementById('btn-batch-clear');
  if (batchClearBtn) {
    batchClearBtn.addEventListener('click', () => {
      selectedFiles.clear();
      updateBatchBarUI();
      renderSelectedFolderContent();
    });
  }

  const batchDownloadBtn = document.getElementById('btn-batch-download');
  if (batchDownloadBtn) {
    batchDownloadBtn.addEventListener('click', downloadSelectedBatchFiles);
  }

  // Mini-player audio & Modale video
  const audioCloseBtn = document.getElementById('btn-audio-player-close');
  if (audioCloseBtn) audioCloseBtn.addEventListener('click', closeAudioPlayer);

  const videoCloseBtn = document.getElementById('btn-video-close');
  if (videoCloseBtn) videoCloseBtn.addEventListener('click', closeVideoModal);

  const videoOverlay = document.getElementById('video-player-overlay');
  if (videoOverlay) {
    videoOverlay.addEventListener('click', (e) => {
      if (e.target === videoOverlay) closeVideoModal();
    });
  }

  // Controlli Visualizzatore PDF.js
  const viewerBackBtn = document.getElementById('btn-viewer-back');
  if (viewerBackBtn) viewerBackBtn.addEventListener('click', closePdfViewer);

  const prevPageBtn = document.getElementById('btn-prev-page');
  if (prevPageBtn) prevPageBtn.addEventListener('click', prevPage);

  const nextPageBtn = document.getElementById('btn-next-page');
  if (nextPageBtn) nextPageBtn.addEventListener('click', nextPage);

  const zoomInBtn = document.getElementById('btn-viewer-zoom-in');
  if (zoomInBtn) zoomInBtn.addEventListener('click', zoomIn);

  const zoomOutBtn = document.getElementById('btn-viewer-zoom-out');
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', zoomOut);

  const goIndexBtn = document.getElementById('btn-go-to-index');
  if (goIndexBtn) {
    goIndexBtn.addEventListener('click', () => {
      if (!currentPdfDoc) return;
      goToPage(detectedIndexPageNum);
      showToast(`Indice: Pagina ${detectedIndexPageNum}`, 'info');
    });
  }

  const invertPdfBtn = document.getElementById('btn-invert-pdf');
  if (invertPdfBtn) invertPdfBtn.addEventListener('click', togglePdfInvert);

  const pageInput = document.getElementById('page-input');
  if (pageInput) {
    pageInput.addEventListener('change', () => {
      const val = parseInt(pageInput.value, 10);
      if (currentPdfDoc && val >= 1 && val <= currentPdfDoc.numPages) {
        goToPage(val);
      }
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentPdfDoc) renderCurrentPage();
    }, 150);
  });

  window.addEventListener('keydown', (e) => {
    const pdfOverlay = document.getElementById('pdf-viewer-overlay');
    if (pdfOverlay && !pdfOverlay.classList.contains('hidden')) {
      if (e.key === 'Escape') closePdfViewer();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') nextPage();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prevPage();
      return;
    }

    const vidOverlay = document.getElementById('video-player-overlay');
    if (vidOverlay && !vidOverlay.classList.contains('hidden') && e.key === 'Escape') {
      closeVideoModal();
    }
  });

  await initDriveApp();
});
