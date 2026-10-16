/**
 * NOTE PDF PWA - ENGINE APPLICATIVO
 * - Supporto per server proxy sicuro (.env): il token GitHub rimane sul server
 * - Gestione IndexedDB per storage persistente offline dei PDF
 * - Sincronizzazione incrementale con GitHub Git Trees API + ETag (304)
 * - Raggruppamento naturale per cartelle Nonno (Box) e Padre (Card)
 * - Visualizzatore PDF a schermo intero basato su PDF.js
 * - Gestione Tema Chiaro / Scuro con sincronizzazione meta theme-color
 * - Supporto PWA installabile e rilevamento stato di connessione
 */

// Inizializza libreria PDF.js se disponibile
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ==========================================================================
   1. GESTIONE INDEXEDDB
   ========================================================================== */
const DB_NAME = 'GithubPdfPwaDB';
const DB_VERSION = 1;
const STORE_PDFS = 'pdfs';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        const store = db.createObjectStore(STORE_PDFS, { keyPath: 'path' });
        store.createIndex('grandparent', 'grandparent', { unique: false });
        store.createIndex('parent', 'parent', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAllPdfs() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readonly');
    const store = tx.objectStore(STORE_PDFS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutPdf(pdfRecord) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readwrite');
    const store = tx.objectStore(STORE_PDFS);
    const request = store.put(pdfRecord);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function dbDeletePdf(path) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readwrite');
    const store = tx.objectStore(STORE_PDFS);
    const request = store.delete(path);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function dbClearAllPdfs() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readwrite');
    const store = tx.objectStore(STORE_PDFS);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/* ==========================================================================
   2. GESTIONE TEMA (GIORNO / NOTTE)
   ========================================================================== */
function initTheme() {
  const savedTheme = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_THEME);
  let theme = savedTheme;

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
    themeBtn.innerHTML = theme === 'dark'
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

/* ==========================================================================
   3. GESTIONE STATO E PARSING DEI PERCORSI
   ========================================================================== */
let allPdfs = [];
let isSyncing = false;
let deferredInstallPrompt = null;

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
  if (!timestamp) return 'Non disponibile';
  const d = new Date(timestamp);
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function parsePathInfo(fullPath, rootPath, excludeDirs) {
  const cleanPath = fullPath.replace(/\\/g, '/');

  if (!cleanPath.toLowerCase().endsWith('.pdf')) {
    return null;
  }

  let relPath = cleanPath;
  if (rootPath) {
    const normRoot = rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normRoot) {
      if (!cleanPath.startsWith(normRoot + '/') && cleanPath !== normRoot) {
        return null;
      }
      relPath = cleanPath.substring(normRoot.length).replace(/^\/+/, '');
    }
  }

  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const lowerExcludes = excludeDirs.map(d => d.trim().toLowerCase()).filter(Boolean);
  const dirSegments = segments.slice(0, segments.length - 1);
  for (const seg of dirSegments) {
    if (lowerExcludes.includes(seg.toLowerCase())) {
      return null;
    }
  }

  const fileName = segments[segments.length - 1];

  let parentName = '';
  let grandparentName = '';
  let breadcrumb = '';

  if (segments.length >= 3) {
    parentName = segments[segments.length - 2];
    grandparentName = segments[segments.length - 3];
    const ancestors = segments.slice(0, segments.length - 2);
    breadcrumb = ancestors.join(' / ');
  } else if (segments.length === 2) {
    parentName = segments[segments.length - 2];
    grandparentName = 'Documenti';
    breadcrumb = 'Documenti';
  } else {
    parentName = fileName.replace(/\.pdf$/i, '');
    grandparentName = 'Principale';
    breadcrumb = 'Principale';
  }

  return {
    path: fullPath,
    fileName,
    parent: parentName,
    grandparent: grandparentName,
    groupKey: breadcrumb || grandparentName,
  };
}

/* ==========================================================================
   4. ENGINE DI SINCRONIZZAZIONE (GITHUB API / SERVER PROXY + ETAG)
   ========================================================================== */
async function syncFromGitHub(options = { isManual: true }) {
  if (isSyncing) return;
  isSyncing = true;

  const config = window.APP_CONFIG.getAppConfig();
  const progressBar = document.getElementById('sync-progress-banner');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');
  const syncBtn = document.getElementById('btn-sync');

  function setProgress(percent, label) {
    if (progressBar && progressFill && progressLabel) {
      progressBar.classList.remove('hidden');
      progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      progressLabel.textContent = label;
    }
  }

  if (syncBtn) {
    syncBtn.classList.add('spin-icon');
    syncBtn.disabled = true;
  }

  try {
    setProgress(10, `Controllo modifiche su ${config.owner}/${config.repo}...`);

    const savedETag = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_ETAG) || '';
    const headers = {};

    if (savedETag) {
      headers['If-None-Match'] = savedETag;
    }

    // Se è attiva la modalità server (Express + .env), usiamo il proxy sicuro per non esporre il token
    let treeUrl = '';
    const useServerProxy = config.isServerMode && !config.token;

    if (useServerProxy) {
      treeUrl = `/api/tree?owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}&branch=${encodeURIComponent(config.branch)}`;
    } else {
      // Modalità diretta (fallback per client-side puro su GitHub Pages)
      treeUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`;
      headers['Accept'] = 'application/vnd.github.v3+json';
      if (config.token) {
        headers['Authorization'] = `Bearer ${config.token}`;
      }
    }

    let response;
    try {
      response = await fetch(treeUrl, { headers });
    } catch (networkError) {
      throw new Error('Nessuna connessione a Internet. Stai usando i file PDF memorizzati offline.');
    }

    // 304 Not Modified: Nessuna modifica, esce subito senza riscaricare
    if (response.status === 304) {
      const now = Date.now();
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC, now.toString());
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS, 'Già aggiornato');
      updateSyncMetaUI(now, 'Già aggiornato');
      showToast('Già aggiornato: nessuna modifica nella repository', 'info');
      setProgress(100, 'Già aggiornato');
      setTimeout(() => progressBar && progressBar.classList.add('hidden'), 800);
      return;
    }

    // Gestione Limite di Rate (403)
    if (response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const resetTime = response.headers.get('x-ratelimit-reset');
      if (remaining === '0') {
        const resetDate = resetTime ? new Date(parseInt(resetTime, 10) * 1000).toLocaleTimeString() : 'tra poco';
        throw new Error(`Limite GitHub API raggiunto. Reset alle ${resetDate}. Configura GITHUB_TOKEN nel file .env per avere 5.000 req/h.`);
      }
      throw new Error('Accesso negato da GitHub. Configura il tuo GITHUB_TOKEN nel file .env per accedere a repository private.');
    }

    if (response.status === 404) {
      throw new Error(`Repository "${config.owner}/${config.repo}" o ramo "${config.branch}" non trovato. Verifica le impostazioni.`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Errore GitHub (${response.status}): ${errText.slice(0, 100)}`);
    }

    // Salva il nuovo ETag
    const newETag = response.headers.get('ETag');
    if (newETag) {
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_ETAG, newETag);
    }

    const data = await response.json();
    if (!data.tree || !Array.isArray(data.tree)) {
      throw new Error('Formato risposta Git Trees non valido.');
    }

    // Filtra e analizza i file PDF
    const validPdfTreeItems = [];
    for (const item of data.tree) {
      if (item.type !== 'blob') continue;
      const parsed = parsePathInfo(item.path, config.rootPath, config.excludeDirs);
      if (parsed) {
        validPdfTreeItems.push({
          ...parsed,
          sha: item.sha,
          size: item.size || 0
        });
      }
    }

    setProgress(25, `Trovati ${validPdfTreeItems.length} PDF. Confronto con la memoria locale...`);

    const existingPdfs = await dbGetAllPdfs();
    const existingMap = new Map();
    existingPdfs.forEach(p => existingMap.set(p.path, p));

    const validPathsSet = new Set(validPdfTreeItems.map(i => i.path));

    // Identifica file rimossi dalla repo
    let deletedCount = 0;
    for (const oldPdf of existingPdfs) {
      if (!validPathsSet.has(oldPdf.path)) {
        await dbDeletePdf(oldPdf.path);
        deletedCount++;
      }
    }

    // Identifica file nuovi o modificati (sha differente)
    const toDownload = [];
    for (const item of validPdfTreeItems) {
      const cached = existingMap.get(item.path);
      if (!cached || cached.sha !== item.sha || !cached.blob) {
        toDownload.push(item);
      }
    }

    if (toDownload.length === 0 && deletedCount === 0) {
      const now = Date.now();
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC, now.toString());
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS, 'Già aggiornato');
      updateSyncMetaUI(now, 'Già aggiornato');
      showToast('Già aggiornato: tutti i file sono sincronizzati', 'info');
      setProgress(100, 'Sincronizzazione completata');
      setTimeout(() => progressBar && progressBar.classList.add('hidden'), 800);
      await refreshUI();
      return;
    }

    // Scarica solo i file nuovi o modificati
    let downloadedCount = 0;
    for (let i = 0; i < toDownload.length; i++) {
      const item = toDownload[i];
      const percent = 30 + Math.round(((i + 1) / toDownload.length) * 65);
      setProgress(percent, `Download ${i + 1}/${toDownload.length}: ${item.parent}...`);

      const blob = await fetchPdfBlob(config, item, useServerProxy);
      const pdfRecord = {
        path: item.path,
        sha: item.sha,
        fileName: item.fileName,
        parent: item.parent,
        grandparent: item.grandparent,
        groupKey: item.groupKey,
        size: blob.size || item.size,
        blob: blob,
        updatedAt: Date.now()
      };

      await dbPutPdf(pdfRecord);
      downloadedCount++;
    }

    const now = Date.now();
    const finalMsg = `${downloadedCount} file aggiornati${deletedCount > 0 ? `, ${deletedCount} rimossi` : ''}`;
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC, now.toString());
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS, finalMsg);
    updateSyncMetaUI(now, finalMsg);
    showToast(finalMsg, 'success');

    setProgress(100, finalMsg);
    setTimeout(() => progressBar && progressBar.classList.add('hidden'), 1200);

    await refreshUI();
  } catch (error) {
    console.error('Errore sincronizzazione:', error);
    showToast(error.message || 'Errore durante la sincronizzazione', 'error');
    if (progressBar) progressBar.classList.add('hidden');
  } finally {
    isSyncing = false;
    if (syncBtn) {
      syncBtn.classList.remove('spin-icon');
      syncBtn.disabled = false;
    }
  }
}

/**
 * Scarica il blob binario del PDF (tramite server proxy o GitHub API)
 */
async function fetchPdfBlob(config, item, useServerProxy) {
  if (useServerProxy) {
    const proxyUrl = `/api/blob/${encodeURIComponent(item.sha)}?owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}`;
    const res = await fetch(proxyUrl);
    if (res.ok) {
      return await res.blob();
    }
    // Fallback a /api/raw
    const rawRes = await fetch(`/api/raw?path=${encodeURIComponent(item.path)}&owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}&branch=${encodeURIComponent(config.branch)}`);
    if (rawRes.ok) {
      return await rawRes.blob();
    }
    throw new Error(`Impossibile scaricare ${item.parent} dal server proxy`);
  }

  // Chiamata diretta dal client
  const blobUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/blobs/${item.sha}`;
  const headers = {
    'Accept': 'application/vnd.github.raw',
  };
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }

  try {
    const res = await fetch(blobUrl, { headers });
    if (res.ok) {
      return await res.blob();
    }
  } catch (e) {
    console.warn('Fallback a raw.githubusercontent.com per:', item.path);
  }

  const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/${encodeURIComponent(config.branch)}/${encodeURI(item.path)}`;
  const rawHeaders = {};
  if (config.token) {
    rawHeaders['Authorization'] = `token ${config.token}`;
  }
  const rawRes = await fetch(rawUrl, { headers: rawHeaders });
  if (!rawRes.ok) {
    throw new Error(`Impossibile scaricare il file ${item.parent} (${rawRes.status})`);
  }
  return await rawRes.blob();
}

/* ==========================================================================
   5. RENDERING DELL'INTERFACCIA UTENTE
   ========================================================================== */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function refreshUI() {
  allPdfs = await dbGetAllPdfs();
  renderPdfList();
  updateStorageStats();
}

function updateSyncMetaUI(timestamp, statusMsg) {
  const metaText = document.getElementById('sync-meta-text');
  const statusDot = document.getElementById('status-dot');

  if (statusDot) {
    if (navigator.onLine) {
      statusDot.className = 'status-dot';
      statusDot.title = 'Online';
    } else {
      statusDot.className = 'status-dot offline';
      statusDot.title = 'Offline (Memoria locale)';
    }
  }

  if (metaText) {
    if (timestamp) {
      metaText.textContent = `Ultimo aggiornamento: ${formatDate(timestamp)}${statusMsg ? ` (${statusMsg})` : ''}`;
    } else {
      metaText.textContent = 'Nessuna sincronizzazione effettuata';
    }
  }
}

function renderPdfList() {
  const container = document.getElementById('pdf-groups-container');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  if (!container || !emptyState) return;

  const filtered = allPdfs.filter(pdf => {
    if (!query) return true;
    return (
      pdf.parent.toLowerCase().includes(query) ||
      pdf.grandparent.toLowerCase().includes(query) ||
      (pdf.groupKey && pdf.groupKey.toLowerCase().includes(query)) ||
      pdf.fileName.toLowerCase().includes(query)
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    if (allPdfs.length > 0 && query) {
      document.getElementById('empty-state-title').textContent = 'Nessun risultato trovato';
      document.getElementById('empty-state-desc').textContent = `Nessun PDF corrisponde a "${query}". Prova a modificare la ricerca.`;
    } else {
      document.getElementById('empty-state-title').textContent = 'Nessun PDF scaricato';
      document.getElementById('empty-state-desc').textContent = 'Premi "Aggiorna" per scansionare la repository GitHub e scaricare i PDF, oppure carica i dati di esempio.';
    }
    return;
  }

  emptyState.classList.add('hidden');

  const groupsMap = new Map();
  for (const pdf of filtered) {
    const key = pdf.groupKey || pdf.grandparent || 'Documenti';
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        title: pdf.grandparent || key,
        fullPath: key,
        items: []
      });
    }
    groupsMap.get(key).items.push(pdf);
  }

  const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => {
    return collator.compare(a.fullPath, b.fullPath);
  });

  let html = '';

  for (const group of sortedGroups) {
    const sortedCards = group.items.sort((a, b) => {
      return collator.compare(a.parent, b.parent);
    });

    html += `
      <section class="box-group" aria-label="${escapeHtml(group.title)}">
        <div class="box-header">
          <div class="box-title-container">
            <h2 class="box-title">${escapeHtml(group.title)}</h2>
            ${group.fullPath !== group.title ? `<span class="box-meta">${escapeHtml(group.fullPath)}</span>` : ''}
          </div>
          <span class="box-meta">${sortedCards.length} ${sortedCards.length === 1 ? 'dispensa' : 'dispense'}</span>
        </div>
        <div class="cards-grid">
    `;

    for (const card of sortedCards) {
      html += `
        <article class="pdf-card" data-path="${escapeHtml(card.path)}" role="button" tabindex="0" aria-label="Apri dispensa ${escapeHtml(card.parent)}">
          <div class="pdf-card-top">
            <div class="pdf-card-icon" aria-hidden="true">
              <svg width="24" height="24" style="width: 24px; height: 24px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <div class="pdf-card-titles">
              <h3 class="pdf-card-name">${escapeHtml(card.parent)}</h3>
              <div class="pdf-card-filename">${escapeHtml(card.fileName)}</div>
            </div>
          </div>
          <div class="pdf-card-footer">
            <div class="pdf-card-meta-group">
              <span>${formatBytes(card.size)}</span>
              <span class="meta-separator">·</span>
              <span>${formatDate(card.updatedAt).split(',')[0]}</span>
            </div>
            <span class="pdf-card-action-hint">
              Leggi PDF
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </div>
        </article>
      `;
    }

    html += `
        </div>
      </section>
    `;
  }

  container.innerHTML = html;

  const cardElements = container.querySelectorAll('.pdf-card');
  cardElements.forEach(el => {
    const clickHandler = () => {
      const path = el.getAttribute('data-path');
      const item = allPdfs.find(p => p.path === path);
      if (item) {
        openPdfViewer(item);
      }
    };
    el.addEventListener('click', clickHandler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        clickHandler();
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateStorageStats() {
  const statsEl = document.getElementById('storage-stats');
  if (!statsEl) return;
  const count = allPdfs.length;
  const totalBytes = allPdfs.reduce((acc, curr) => acc + (curr.size || 0), 0);
  statsEl.textContent = `${count} ${count === 1 ? 'file' : 'file'} salvati offline · Spazio totale: ${formatBytes(totalBytes)}`;
}

/* ==========================================================================
   6. VISUALIZZATORE PDF A SCHERMO INTERO (PDF.js)
   ========================================================================== */
let currentPdfDoc = null;
let currentPdfItem = null;
let currentPageNum = 1;
let currentZoom = 1.0;
let isRenderingPage = false;
let pageRenderingQueue = null;
let isPdfInvertMode = false;

async function openPdfViewer(pdfItem) {
  const overlay = document.getElementById('pdf-viewer-overlay');
  const titleEl = document.getElementById('viewer-doc-title');
  const subtitleEl = document.getElementById('viewer-doc-subtitle');
  const loadingState = document.getElementById('viewer-loading');

  if (!overlay || !pdfItem || !pdfItem.blob) return;

  currentPdfItem = pdfItem;
  currentPageNum = 1;
  currentZoom = 1.0;

  titleEl.textContent = pdfItem.parent;
  subtitleEl.textContent = `${pdfItem.grandparent} · ${pdfItem.fileName}`;

  overlay.classList.remove('hidden');
  loadingState.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const arrayBuffer = await pdfItem.blob.arrayBuffer();

    if (!window.pdfjsLib) {
      throw new Error('Libreria PDF.js in caricamento o non disponibile.');
    }

    const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
    currentPdfDoc = await loadingTask.promise;

    document.getElementById('total-pages').textContent = currentPdfDoc.numPages;
    document.getElementById('page-input').max = currentPdfDoc.numPages;
    document.getElementById('page-input').value = '1';

    renderCurrentPage();
  } catch (err) {
    console.error('Errore visualizzazione PDF:', err);
    showToast('Impossibile visualizzare il PDF: ' + err.message, 'error');
    closePdfViewer();
  } finally {
    loadingState.classList.add('hidden');
  }
}

function closePdfViewer() {
  const overlay = document.getElementById('pdf-viewer-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  currentPdfDoc = null;
  currentPdfItem = null;
  const stage = document.getElementById('pdf-viewer-stage');
  if (stage) stage.innerHTML = '';
}

async function renderCurrentPage() {
  if (!currentPdfDoc) return;
  if (isRenderingPage) {
    pageRenderingQueue = currentPageNum;
    return;
  }

  isRenderingPage = true;
  const stage = document.getElementById('pdf-viewer-stage');
  const pageInput = document.getElementById('page-input');
  if (pageInput) pageInput.value = currentPageNum;

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

    let calculatedScale = currentZoom;
    if (currentZoom === 1.0) {
      // Adatta dinamicamente alla larghezza disponibile per garantire la massima leggibilità
      calculatedScale = Math.min(3.0, Math.max(0.4, containerWidth / unscaledViewport.width));
    }

    const viewport = page.getViewport({ scale: calculatedScale });
    const pixelRatio = window.devicePixelRatio || 1;

    stage.innerHTML = '';

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

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport,
    };

    await page.render(renderContext).promise;
  } catch (renderError) {
    console.error('Errore rendering pagina:', renderError);
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

function prevPage() {
  if (currentPageNum <= 1) return;
  currentPageNum--;
  renderCurrentPage();
}

function nextPage() {
  if (!currentPdfDoc || currentPageNum >= currentPdfDoc.numPages) return;
  currentPageNum++;
  renderCurrentPage();
}

function zoomIn() {
  currentZoom = Math.min(3.5, (currentZoom || 1) * 1.25);
  renderCurrentPage();
}

function zoomOut() {
  currentZoom = Math.max(0.5, (currentZoom || 1) / 1.25);
  renderCurrentPage();
}

function resetZoom() {
  currentZoom = 1.0;
  renderCurrentPage();
}

function togglePdfInvert() {
  isPdfInvertMode = !isPdfInvertMode;
  const container = document.querySelector('.pdf-page-container');
  if (container) {
    if (isPdfInvertMode) {
      container.classList.add('invert-mode');
    } else {
      container.classList.remove('invert-mode');
    }
  }
  const btn = document.getElementById('btn-invert-pdf');
  if (btn) {
    btn.classList.toggle('active', isPdfInvertMode);
    btn.setAttribute('title', isPdfInvertMode ? 'Disattiva modalità notturna PDF' : 'Attiva modalità notturna PDF (inverte colori)');
  }
}

/* ==========================================================================
   7. MODAL IMPOSTAZIONI E TOKEN GITHUB
   ========================================================================== */
function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const config = window.APP_CONFIG.getAppConfig();

  document.getElementById('cfg-owner').value = config.owner;
  document.getElementById('cfg-repo').value = config.repo;
  document.getElementById('cfg-branch').value = config.branch;
  document.getElementById('cfg-root-path').value = config.rootPath;
  document.getElementById('cfg-exclude-dirs').value = config.excludeDirs.join(', ');
  document.getElementById('cfg-token').value = config.token;

  // Mostra badge di sicurezza server .env
  const envBadge = document.getElementById('env-security-badge');
  if (envBadge) {
    if (config.hasServerToken) {
      envBadge.innerHTML = `
        <div style="background-color: var(--accent-subtle); border: 1px solid var(--border-focus); border-radius: 8px; padding: 0.625rem 0.875rem; font-size: 0.8125rem; color: var(--text-primary); display: flex; align-items: center; gap: 0.5rem;">
          <span style="color: var(--success); font-size: 1.1rem;">🔒</span>
          <div>
            <strong>Credenziali protette da .env sul server.</strong><br>
            Il token è configurato nelle variabili d'ambiente: i visitatori possono consultare i PDF senza accedere alle tue credenziali.
          </div>
        </div>
      `;
      envBadge.style.display = 'block';
    } else {
      envBadge.innerHTML = `
        <div style="background-color: var(--bg-surface-hover); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.625rem 0.875rem; font-size: 0.8125rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.5rem;">
          <span>ℹ️</span>
          <div>
            Puoi inserire il tuo token nel file <code>.env</code> sul server (chiave <code>GITHUB_TOKEN</code>) oppure inserirlo qui sotto nel browser.
          </div>
        </div>
      `;
      envBadge.style.display = 'block';
    }
  }

  if (modal) modal.classList.remove('hidden');
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

function saveSettingsFromUI() {
  const owner = document.getElementById('cfg-owner').value.trim();
  const repo = document.getElementById('cfg-repo').value.trim();
  const branch = document.getElementById('cfg-branch').value.trim();
  const rootPath = document.getElementById('cfg-root-path').value.trim();
  const rawExcludes = document.getElementById('cfg-exclude-dirs').value.trim();
  const token = document.getElementById('cfg-token').value.trim();

  const excludeDirs = rawExcludes
    ? rawExcludes.split(',').map(s => s.trim()).filter(Boolean)
    : [...window.APP_CONFIG.DEFAULT_EXCLUDE_DIRS];

  window.APP_CONFIG.saveAppConfig({
    owner: owner || window.APP_CONFIG.DEFAULT_OWNER,
    repo: repo || window.APP_CONFIG.DEFAULT_REPO,
    branch: branch || window.APP_CONFIG.DEFAULT_BRANCH,
    rootPath: rootPath !== undefined ? rootPath : window.APP_CONFIG.DEFAULT_ROOT_PATH,
    excludeDirs,
    token
  });

  localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_ETAG);

  showToast('Impostazioni salvate con successo!', 'success');
  closeSettingsModal();
}

function resetSettingsToDefault() {
  if (confirm('Vuoi ripristinare i valori predefiniti (da .env o costanti)?')) {
    window.APP_CONFIG.resetAppConfig();
    openSettingsModal();
    showToast('Impostazioni ripristinate ai valori predefiniti.', 'info');
  }
}

/* ==========================================================================
   8. DATI DIMOSTRATIVI (DEMO SEEDER)
   ========================================================================== */
function createMinimalPdfBlob(titleText, subjectName, semesterName) {
  const content = `BT
/F1 24 Tf
50 720 Td
(${subjectName} - Appunti e Dispense) Tj
/F1 14 Tf
0 -36 Td
(${semesterName} - Universita / Corso di Laurea) Tj
0 -24 Td
(File: ${titleText}) Tj
/F1 11 Tf
0 -40 Td
(Questo e un documento PDF di prova memorizzato in IndexedDB.) Tj
0 -20 Td
(Funziona offline e consente di testare il visualizzatore PDF.js,) Tj
0 -20 Td
(lo zoom, la modalita notte e la navigazione su tablet Android.) Tj
ET`;

  const streamLength = content.length;
  const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${content}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000300 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
380
%%EOF`;

  return new Blob([pdfString], { type: 'application/pdf' });
}

async function loadSampleDemoData() {
  const sampleItems = [
    {
      path: '00 - Obsidian Notes/3° Anno/1° Semestre/IngSW/main.pdf',
      sha: 'demo-sha-ingsw',
      fileName: 'main.pdf',
      parent: 'IngSW',
      grandparent: '1° Semestre',
      groupKey: '3° Anno / 1° Semestre',
    },
    {
      path: '00 - Obsidian Notes/3° Anno/1° Semestre/Reti/main.pdf',
      sha: 'demo-sha-reti',
      fileName: 'main.pdf',
      parent: 'Reti',
      grandparent: '1° Semestre',
      groupKey: '3° Anno / 1° Semestre',
    },
    {
      path: '00 - Obsidian Notes/3° Anno/1° Semestre/TecWeb/main.pdf',
      sha: 'demo-sha-tecweb',
      fileName: 'main.pdf',
      parent: 'TecWeb',
      grandparent: '1° Semestre',
      groupKey: '3° Anno / 1° Semestre',
    },
    {
      path: '00 - Obsidian Notes/3° Anno/2° Semestre/Basi di Dati/main.pdf',
      sha: 'demo-sha-bd',
      fileName: 'main.pdf',
      parent: 'Basi di Dati',
      grandparent: '2° Semestre',
      groupKey: '3° Anno / 2° Semestre',
    },
    {
      path: '00 - Obsidian Notes/3° Anno/2° Semestre/Sistemi Operativi/main.pdf',
      sha: 'demo-sha-so',
      fileName: 'main.pdf',
      parent: 'Sistemi Operativi',
      grandparent: '2° Semestre',
      groupKey: '3° Anno / 2° Semestre',
    },
    {
      path: '00 - Obsidian Notes/2° Anno/2° Semestre/Algoritmi/main.pdf',
      sha: 'demo-sha-algo',
      fileName: 'main.pdf',
      parent: 'Algoritmi',
      grandparent: '2° Semestre',
      groupKey: '2° Anno / 2° Semestre',
    }
  ];

  for (const item of sampleItems) {
    const blob = createMinimalPdfBlob(item.fileName, item.parent, item.grandparent);
    await dbPutPdf({
      path: item.path,
      sha: item.sha,
      fileName: item.fileName,
      parent: item.parent,
      grandparent: item.grandparent,
      groupKey: item.groupKey,
      size: blob.size,
      blob: blob,
      updatedAt: Date.now() - Math.floor(Math.random() * 86400000 * 3)
    });
  }

  const now = Date.now();
  localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC, now.toString());
  localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS, 'Dati demo caricati');
  updateSyncMetaUI(now, 'Dati demo caricati');
  showToast('Caricati 6 documenti dimostrativi in memoria!', 'success');
  closeSettingsModal();
  await refreshUI();
}

async function clearOfflineStorage() {
  if (confirm('Vuoi eliminare tutti i PDF salvati offline dalla memoria del dispositivo?')) {
    await dbClearAllPdfs();
    localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_ETAG);
    localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC);
    localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS);
    updateSyncMetaUI(null, '');
    showToast('Memoria offline ripulita', 'info');
    closeSettingsModal();
    await refreshUI();
  }
}

/* ==========================================================================
   9. NOTIFICHE TOAST
   ========================================================================== */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

/* ==========================================================================
   10. PWA INSTALLATION E SERVICE WORKER REGISTRATION
   ========================================================================== */
function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          console.log('[PWA] Service Worker attivo. Scope:', reg.scope);
        })
        .catch(err => {
          console.warn('[PWA] Service Worker non registrato:', err);
        });
    });
  }

  const installBtn = document.getElementById('btn-install-pwa');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;

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
    showToast('Applicazione installata con successo sulla schermata home!', 'success');
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
        const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
        if (isIOS) {
          alert('Per installare su iPad/iPhone:\n1. Tocca l\'icona Condividi in Safari.\n2. Seleziona "Aggiungi alla schermata Home".');
        } else {
          showToast('Usa il menu del browser (⋮) e seleziona "Installa app" o "Aggiungi a schermata Home".', 'info');
        }
      }
    });
  }

  window.addEventListener('online', () => {
    const lastSync = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC);
    const lastStatus = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS);
    updateSyncMetaUI(lastSync ? parseInt(lastSync, 10) : null, lastStatus);
    showToast('Connessione ripristinata', 'success');
  });

  window.addEventListener('offline', () => {
    const lastSync = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC);
    updateSyncMetaUI(lastSync ? parseInt(lastSync, 10) : null, 'Offline');
    showToast('Modalità offline attiva: i PDF salvati sono disponibili', 'info');
  });
}

/* ==========================================================================
   11. INIZIALIZZAZIONE EVENTI E DOM
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  // Carica prima la configurazione dal server (.env) se disponibile
  await window.APP_CONFIG.loadServerConfig();

  initTheme();
  initPWA();

  const savedSync = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC);
  const savedStatus = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS);
  updateSyncMetaUI(savedSync ? parseInt(savedSync, 10) : null, savedStatus);

  await refreshUI();

  // Rimuove qualsiasi bottone impostazioni residuo (incluso da cache HTML del browser)
  const lingeringBtn = document.getElementById('btn-settings') || document.querySelector('button[title*="Impostazioni"]');
  if (lingeringBtn) {
    lingeringBtn.remove();
  }

  // Forza l'aggiornamento del Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => reg.update());
    }).catch(() => {});
  }

  const themeBtn = document.getElementById('btn-toggle-theme');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) syncBtn.addEventListener('click', () => syncFromGitHub({ isManual: true }));

  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);

  const closeSettingsBtn = document.getElementById('btn-close-settings');
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);

  const saveSettingsBtn = document.getElementById('btn-save-settings');
  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettingsFromUI);

  const resetSettingsBtn = document.getElementById('btn-reset-settings');
  if (resetSettingsBtn) resetSettingsBtn.addEventListener('click', resetSettingsToDefault);

  const loadDemoBtn = document.getElementById('btn-load-demo');
  if (loadDemoBtn) loadDemoBtn.addEventListener('click', loadSampleDemoData);

  const emptyDemoBtn = document.getElementById('btn-empty-demo');
  if (emptyDemoBtn) emptyDemoBtn.addEventListener('click', loadSampleDemoData);

  const emptySyncBtn = document.getElementById('btn-empty-sync');
  if (emptySyncBtn) emptySyncBtn.addEventListener('click', () => syncFromGitHub({ isManual: true }));

  const clearStorageBtn = document.getElementById('btn-clear-storage');
  if (clearStorageBtn) clearStorageBtn.addEventListener('click', clearOfflineStorage);

  const toggleTokenBtn = document.getElementById('btn-toggle-token');
  const tokenInput = document.getElementById('cfg-token');
  if (toggleTokenBtn && tokenInput) {
    toggleTokenBtn.addEventListener('click', () => {
      const isPass = tokenInput.type === 'password';
      tokenInput.type = isPass ? 'text' : 'password';
      toggleTokenBtn.innerHTML = isPass
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    });
  }

  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.classList.toggle('visible', searchInput.value.length > 0);
      }
      renderPdfList();
    });
  }
  if (searchClear && searchInput) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      renderPdfList();
      searchInput.focus();
    });
  }

  const viewerBackBtn = document.getElementById('btn-viewer-back');
  if (viewerBackBtn) viewerBackBtn.addEventListener('click', closePdfViewer);

  const prevPageBtn = document.getElementById('btn-prev-page');
  if (prevPageBtn) prevPageBtn.addEventListener('click', prevPage);

  const nextPageBtn = document.getElementById('btn-next-page');
  if (nextPageBtn) nextPageBtn.addEventListener('click', nextPage);

  const zoomInBtn = document.getElementById('btn-zoom-in');
  if (zoomInBtn) zoomInBtn.addEventListener('click', zoomIn);

  const zoomOutBtn = document.getElementById('btn-zoom-out');
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', zoomOut);

  const resetZoomBtn = document.getElementById('btn-reset-zoom');
  if (resetZoomBtn) resetZoomBtn.addEventListener('click', resetZoom);

  // Controlli Zoom Fluttuanti per Smartphone
  const zoomInFloat = document.getElementById('btn-zoom-in-float');
  if (zoomInFloat) zoomInFloat.addEventListener('click', zoomIn);

  const zoomOutFloat = document.getElementById('btn-zoom-out-float');
  if (zoomOutFloat) zoomOutFloat.addEventListener('click', zoomOut);

  const resetZoomFloat = document.getElementById('btn-reset-zoom-float');
  if (resetZoomFloat) resetZoomFloat.addEventListener('click', resetZoom);

  // Ricalcola il fit-to-width del PDF se l'utente ruota il dispositivo (portrait / landscape)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentPdfDoc) {
        renderCurrentPage();
      }
    }, 150);
  });

  const invertPdfBtn = document.getElementById('btn-invert-pdf');
  if (invertPdfBtn) invertPdfBtn.addEventListener('click', togglePdfInvert);

  const pageInput = document.getElementById('page-input');
  if (pageInput) {
    pageInput.addEventListener('change', () => {
      const val = parseInt(pageInput.value, 10);
      if (currentPdfDoc && val >= 1 && val <= currentPdfDoc.numPages) {
        currentPageNum = val;
        renderCurrentPage();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    const viewer = document.getElementById('pdf-viewer-overlay');
    if (viewer && !viewer.classList.contains('hidden')) {
      if (e.key === 'Escape') {
        closePdfViewer();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        prevPage();
      }
    }
  });
});
