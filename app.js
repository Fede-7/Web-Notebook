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

function hydratePdfRecord(record) {
  if (!record) return null;
  // Se il record ha 'data' (ArrayBuffer), popola 'blob' on-demand se assente per massima retrocompatibilità
  if (record.data && (!record.blob || !(record.blob instanceof Blob))) {
    try {
      record.blob = new Blob([record.data], { type: 'application/pdf' });
    } catch (e) {
      console.warn('Errore ricreazione Blob da ArrayBuffer:', e);
    }
  }
  return record;
}

async function dbGetAllPdfs() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readonly');
    const store = tx.objectStore(STORE_PDFS);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      for (const rec of records) {
        hydratePdfRecord(rec);
      }
      resolve(records);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbPutPdf(pdfRecord) {
  const db = await openDatabase();

  // FIX CRITICO WEBKIT / IOS SAFARI:
  // Su iOS Safari e WebKit, tentare di salvare direttamente un'istanza Blob o File in IndexedDB
  // scatena il noto errore interno di WebKit:
  // "UnknownError: Error preparing a blob/file data to be stored in object store".
  // La soluzione consolidata per iOS consiste nel convertire i dati binari in un ArrayBuffer puro.
  let buffer = pdfRecord.data || pdfRecord.arrayBuffer;
  if (!buffer && pdfRecord.blob) {
    try {
      if (typeof pdfRecord.blob.arrayBuffer === 'function') {
        buffer = await pdfRecord.blob.arrayBuffer();
      } else {
        buffer = await new Response(pdfRecord.blob).arrayBuffer();
      }
    } catch (conversionErr) {
      console.error('Errore conversione Blob in ArrayBuffer:', conversionErr);
    }
  }

  // Costruiamo un record pulito PRIVATO della proprietà `blob` (Blob nativo)
  const recordToStore = {
    path: pdfRecord.path,
    sha: pdfRecord.sha,
    fileName: pdfRecord.fileName,
    parent: pdfRecord.parent,
    grandparent: pdfRecord.grandparent,
    groupKey: pdfRecord.groupKey,
    size: (buffer ? buffer.byteLength : null) || pdfRecord.size || 0,
    data: buffer, // ArrayBuffer puro, 100% supportato e affidabile su iOS, Android e Desktop
    updatedAt: pdfRecord.updatedAt || Date.now()
  };

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_PDFS, 'readwrite');
      const store = tx.objectStore(STORE_PDFS);
      const request = store.put(recordToStore);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Errore salvataggio IndexedDB'));
      tx.onerror = () => reject(tx.error || new Error('Errore transazione IndexedDB'));
    } catch (err) {
      reject(err);
    }
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

async function dbGetPdf(path) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, 'readonly');
    const request = tx.objectStore(STORE_PDFS).get(path);
    request.onsuccess = () => {
      resolve(hydratePdfRecord(request.result || null));
    };
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

    const localPdfs = await dbGetAllPdfs();
    const hasDemoPdfs = localPdfs.some(p => p.sha && p.sha.startsWith('demo-'));

    // Se ci sono file demo in memoria locale, rimuovili per fare spazio ai documenti reali della repository
    if (hasDemoPdfs) {
      for (const p of localPdfs) {
        if (p.sha && p.sha.startsWith('demo-')) {
          await dbDeletePdf(p.path);
        }
      }
      localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_ETAG);
    }

    const savedETag = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_ETAG) || '';
    const headers = {};

    // L'ETag (304 Not Modified) si usa SOLO nei controlli in background quando ci sono già PDF reali in memoria.
    // Al click manuale dell'utente su "Aggiorna" o se la memoria locale è vuota/demo, scarichiamo sempre l'albero aggiornato.
    const shouldCheckETag = !options.isManual && !hasDemoPdfs && localPdfs.length > 0 && Boolean(savedETag);
    if (shouldCheckETag) {
      headers['If-None-Match'] = savedETag;
    }

    // Se è attiva la modalità server (Express + .env), usiamo il proxy sicuro per non esporre il token
    let treeUrl = '';
    const useServerProxy = config.isServerMode && !config.token;
    const forceParam = (!shouldCheckETag ? '&force=true' : '') + `&_t=${Date.now()}`;

    if (useServerProxy) {
      treeUrl = `/api/tree?owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}&branch=${encodeURIComponent(config.branch)}${forceParam}`;
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

    // 304 Not Modified: nessuna modifica dall'ultima sincronizzazione
    if (response.status === 304) {
      // Se la memoria locale è vuota, 304 indica solo cache HTTP del browser: risincronizziamo forzatamente
      if (localPdfs.length === 0) {
        localStorage.removeItem(window.APP_CONFIG.STORAGE_KEY_ETAG);
        return await syncFromGitHub({ isManual: false });
      }

      const now = Date.now();
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_SYNC, now.toString());
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_LAST_STATUS, 'Già aggiornato');
      updateSyncMetaUI(now, 'Già aggiornato');
      showToast('Già aggiornato: nessuna modifica nella repository', 'info');
      setProgress(100, 'Già aggiornato');
      setTimeout(() => progressBar && progressBar.classList.add('hidden'), 800);
      await refreshUI();
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

    // Repo molto grandi: GitHub può troncare l'elenco dei file.
    if (data.truncated) {
      showToast('Attenzione: repository molto grande, l\'elenco file potrebbe essere incompleto.', 'info');
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

    // Identifica ed elimina file rimossi dalla repo o vecchi file demo
    let deletedCount = 0;
    for (const oldPdf of existingPdfs) {
      if (!validPathsSet.has(oldPdf.path) || (oldPdf.sha && oldPdf.sha.startsWith('demo-'))) {
        await dbDeletePdf(oldPdf.path);
        deletedCount++;
      }
    }

    // Identifica file nuovi o modificati (sha differente o mancante)
    const toDownload = [];
    for (const item of validPdfTreeItems) {
      const cached = existingMap.get(item.path);
      if (!cached || cached.sha !== item.sha || (!cached.data && !cached.blob) || (cached.sha && cached.sha.startsWith('demo-'))) {
        toDownload.push(item);
      }
    }

    // Nessun PDF trovato nella repo con queste impostazioni: notifica l'utente chiaramente
    if (validPdfTreeItems.length === 0 && existingPdfs.length === 0) {
      const msg = `Nessun PDF trovato in ${config.owner}/${config.repo} (ramo ${config.branch}${config.rootPath ? ', cartella ' + config.rootPath : ''}).`;
      showToast(msg, 'error');
      throw new Error(msg);
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

    // Scarica solo i file nuovi o modificati memorizzandoli come ArrayBuffer
    let downloadedCount = 0;
    for (let i = 0; i < toDownload.length; i++) {
      const item = toDownload[i];
      const percent = 30 + Math.round(((i + 1) / toDownload.length) * 65);
      setProgress(percent, `Download ${i + 1}/${toDownload.length}: ${item.parent}...`);

      const buffer = await fetchPdfBuffer(config, item, useServerProxy);
      const pdfRecord = {
        path: item.path,
        sha: item.sha,
        fileName: item.fileName,
        parent: item.parent,
        grandparent: item.grandparent,
        groupKey: item.groupKey,
        size: buffer.byteLength || item.size,
        data: buffer,
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
 * Scarica i dati binari (ArrayBuffer) del PDF (tramite server proxy o GitHub API).
 * Scaricare direttamente in ArrayBuffer evita la creazione di oggetti Blob temporanei
 * che su WebKit/iOS causano errori di scrittura in IndexedDB.
 */
async function fetchPdfBuffer(config, item, useServerProxy) {
  if (useServerProxy) {
    const proxyUrl = `/api/blob/${encodeURIComponent(item.sha)}?owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}`;
    const res = await fetch(proxyUrl);
    if (res.ok) {
      return await res.arrayBuffer();
    }
    // Fallback a /api/raw
    const rawRes = await fetch(`/api/raw?path=${encodeURIComponent(item.path)}&owner=${encodeURIComponent(config.owner)}&repo=${encodeURIComponent(config.repo)}&branch=${encodeURIComponent(config.branch)}`);
    if (rawRes.ok) {
      return await rawRes.arrayBuffer();
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
      return await res.arrayBuffer();
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
  return await rawRes.arrayBuffer();
}

async function fetchPdfBlob(config, item, useServerProxy) {
  const buf = await fetchPdfBuffer(config, item, useServerProxy);
  return new Blob([buf], { type: 'application/pdf' });
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

  const pdfCountBadge = document.getElementById('badge-pdf-count');
  if (pdfCountBadge) {
    pdfCountBadge.textContent = String(allPdfs.length);
  }

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
            <button type="button" class="pdf-download" title="Scarica ${escapeHtml(card.fileName)}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Scarica</span>
            </button>
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

  // Bottone "Scarica": stopPropagation evita che il click apra anche il visualizzatore.
  // I listener vanno ricollegati a ogni render perché container.innerHTML ricrea il DOM.
  const downloadButtons = container.querySelectorAll('.pdf-download');
  downloadButtons.forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const path = btn.closest('.pdf-card').getAttribute('data-path');
      const item = allPdfs.find(p => p.path === path);
      if (item) {
        downloadPdf(item);
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
let currentRenderTask = null;
let currentLoadingTask = null;
let detectedIndexPageNum = 2;

async function openPdfViewer(pdfItem) {
  if (!pdfItem) return;

  // Se c'è già una visualizzazione o rendering aperto, ripuliamo prima tutto lo stato
  if (currentPdfDoc || isRenderingPage || currentLoadingTask) {
    await closePdfViewer();
  }

  const overlay = document.getElementById('pdf-viewer-overlay');
  const titleEl = document.getElementById('viewer-doc-title');
  const subtitleEl = document.getElementById('viewer-doc-subtitle');
  const loadingState = document.getElementById('viewer-loading');

  if (!overlay) return;

  // Recupera i dati aggiornati da IndexedDB se non presenti nell'oggetto
  let item = pdfItem;
  if ((!item.data && (!item.blob || item.blob.size === 0)) && item.path) {
    try {
      const fromDb = await dbGetPdf(item.path);
      if (fromDb && (fromDb.data || fromDb.blob)) {
        item = fromDb;
      }
    } catch (e) {
      console.warn('Impossibile recuperare PDF da db:', e);
    }
  }

  if (!item.data && !item.blob) {
    showToast('File PDF non trovato in memoria locale. Prova a sincronizzare.', 'error');
    return;
  }

  currentPdfItem = item;
  currentPageNum = 1;
  currentZoom = 1.0;
  isRenderingPage = false;
  pageRenderingQueue = null;

  if (titleEl) titleEl.textContent = item.parent || item.fileName || 'Documento PDF';
  if (subtitleEl) subtitleEl.textContent = `${item.grandparent || ''} · ${item.fileName || ''}`;

  overlay.classList.remove('hidden');
  if (loadingState) loadingState.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    // Prepariamo i dati binari puliti per PDF.js evitando distacchi di buffer (detached buffer)
    let dataCopy;
    if (item.data && (item.data instanceof ArrayBuffer || ArrayBuffer.isView(item.data))) {
      const buf = item.data instanceof ArrayBuffer ? item.data : item.data.buffer;
      dataCopy = new Uint8Array(buf.slice(0));
    } else if (item.blob) {
      const arrayBuffer = await item.blob.arrayBuffer();
      dataCopy = new Uint8Array(arrayBuffer.slice(0));
    } else {
      throw new Error('Dati binari del PDF non trovati');
    }

    if (!window.pdfjsLib) {
      throw new Error('Libreria PDF.js in caricamento o non disponibile.');
    }

    currentLoadingTask = window.pdfjsLib.getDocument({ data: dataCopy });
    currentPdfDoc = await currentLoadingTask.promise;
    currentLoadingTask = null;

    // Rileva la pagina dell'indice (di default pagina 2 se presente, o risolve da Outline/Bookmarks)
    detectedIndexPageNum = currentPdfDoc.numPages >= 2 ? 2 : 1;
    try {
      const outline = await currentPdfDoc.getOutline();
      if (outline && outline.length > 0) {
        for (const outlineItem of outline) {
          const t = (outlineItem.title || '').toLowerCase();
          if (t.includes('indice') || t.includes('sommario') || t.includes('contents') || t.includes('table of contents')) {
            let dest = outlineItem.dest;
            if (typeof dest === 'string') {
              dest = await currentPdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest.length > 0) {
              const ref = dest[0];
              let pageIdx = null;
              if (ref && typeof ref === 'object') {
                pageIdx = await currentPdfDoc.getPageIndex(ref);
              } else if (typeof ref === 'number') {
                pageIdx = ref;
              }
              if (pageIdx !== null && pageIdx >= 0) {
                detectedIndexPageNum = pageIdx + 1;
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Viewer] Impossibile recuperare outline:', e);
    }

    const totalPagesEl = document.getElementById('total-pages');
    if (totalPagesEl) totalPagesEl.textContent = currentPdfDoc.numPages;

    const pageInput = document.getElementById('page-input');
    if (pageInput) {
      pageInput.max = currentPdfDoc.numPages;
      pageInput.value = '1';
    }

    await renderCurrentPage();
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') {
      return;
    }
    console.error('Errore visualizzazione PDF:', err);
    showToast('Impossibile visualizzare il PDF: ' + err.message, 'error');
    await closePdfViewer();
  } finally {
    if (loadingState) loadingState.classList.add('hidden');
  }
}

async function closePdfViewer() {
  // 1. Annulla qualsiasi rendering della pagina in corso
  if (currentRenderTask) {
    try {
      currentRenderTask.cancel();
    } catch (e) {}
    currentRenderTask = null;
  }

  // 2. Annulla qualsiasi caricamento PDF in corso
  if (currentLoadingTask) {
    try {
      currentLoadingTask.destroy();
    } catch (e) {}
    currentLoadingTask = null;
  }

  // 3. Distruggi il documento PDF corrente per liberare la memoria del Web Worker
  if (currentPdfDoc) {
    try {
      await currentPdfDoc.destroy();
    } catch (e) {}
    currentPdfDoc = null;
  }

  // 4. Resetta tutti i flag di controllo
  isRenderingPage = false;
  pageRenderingQueue = null;
  currentPdfItem = null;
  currentPageNum = 1;

  // 5. Chiudi l'overlay e ripristina la schermata principale
  const overlay = document.getElementById('pdf-viewer-overlay');
  if (overlay) overlay.classList.add('hidden');

  const loadingState = document.getElementById('viewer-loading');
  if (loadingState) loadingState.classList.add('hidden');

  document.body.style.overflow = '';

  const stage = document.getElementById('pdf-viewer-stage');
  if (stage) stage.innerHTML = '';
}

async function renderCurrentPage() {
  if (!currentPdfDoc) {
    isRenderingPage = false;
    return;
  }

  // Se c'è già un rendering in corso, accoda la pagina richiesta
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

    currentRenderTask = page.render(renderContext);
    await currentRenderTask.promise;
    currentRenderTask = null;

    // Layer dei link: rende cliccabili i link interni (indice/sommario) ed esterni
    await addLinkAnnotations(page, viewport, pageContainer);
  } catch (renderError) {
    if (renderError && (renderError.name === 'RenderingCancelledException' || renderError.message?.includes('cancelled'))) {
      // Normale annullamento per cambio pagina rapido o chiusura
      return;
    }
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

/* ---------- Link cliccabili (indice/sommario del PDF) ---------- */

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
    console.warn('[Viewer] Annotazioni non disponibili:', e);
    return;
  }

  for (const annot of annotations) {
    if (annot.subtype !== 'Link' || !annot.rect) continue;

    // Converte il rettangolo da coordinate PDF a coordinate schermo (viewport)
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
      // Link esterno (http, mailto, ...): apre in una nuova scheda
      linkEl.href = annot.url;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      linkEl.title = annot.url;
    } else {
      // Link interno (GoTo): risolve la destinazione in numero di pagina
      linkEl.href = '#';
      linkEl.title = 'Vai alla pagina collegata';
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
            let pageIndex = null;
            if (ref && typeof ref === 'object') {
              pageIndex = await currentPdfDoc.getPageIndex(ref);
            } else if (typeof ref === 'number') {
              pageIndex = ref;
            }
            if (pageIndex !== null) {
              goToPage(pageIndex + 1);
              return;
            }
          }
          showToast('Destinazione del link non trovata nel documento', 'info');
        } catch (e) {
          console.warn('[Viewer] Errore navigazione link PDF:', e);
          showToast('Impossibile seguire il link interno', 'error');
        }
      });
    }

    pageContainer.appendChild(linkEl);
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
function createMinimalPdfBuffer(titleText, subjectName, semesterName) {
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
(lo zoom, la modalita notte e la navigazione su tablet e smartphone.) Tj
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

  return new TextEncoder().encode(pdfString).buffer;
}

function createMinimalPdfBlob(titleText, subjectName, semesterName) {
  const buffer = createMinimalPdfBuffer(titleText, subjectName, semesterName);
  return new Blob([buffer], { type: 'application/pdf' });
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
    const buffer = createMinimalPdfBuffer(item.fileName, item.parent, item.grandparent);
    await dbPutPdf({
      path: item.path,
      sha: item.sha,
      fileName: item.fileName,
      parent: item.parent,
      grandparent: item.grandparent,
      groupKey: item.groupKey,
      size: buffer.byteLength,
      data: buffer,
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
   10-BIS. GESTIONE SEZIONE REGISTRAZIONI (GOOGLE DRIVE RICORSIVO)
   ========================================================================== */

let currentActiveTab = 'pdfs'; // 'pdfs' | 'recordings'
let driveTreeData = null;      // Albero gerarchico di Google Drive
let drivePathStack = [];       // Stack di navigazione per le cartelle correnti
const selectedRecordings = new Map(); // File audio selezionati per download multiplo (id -> fileObj)
const expandedLessons = new Set();    // Set degli ID delle lezioni espanse a fisarmonica
let activeAudioFile = null;    // File audio attualmente in ascolto

/**
 * Commuta la schermata principale tra "Dispense PDF" e "Registrazioni"
 */
function switchAppTab(tabId) {
  currentActiveTab = tabId;
  try {
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_ACTIVE_TAB, tabId);
  } catch (e) {}

  const tabPdfsBtn = document.getElementById('tab-btn-pdfs');
  const tabRecordingsBtn = document.getElementById('tab-btn-recordings');
  const sectionPdfs = document.getElementById('section-pdfs');
  const sectionRecordings = document.getElementById('section-recordings');
  const btnSyncGithub = document.getElementById('btn-sync');
  const btnSyncDriveTop = document.getElementById('btn-drive-sync-top');

  if (tabId === 'recordings') {
    if (tabPdfsBtn) {
      tabPdfsBtn.classList.remove('active');
      tabPdfsBtn.setAttribute('aria-selected', 'false');
    }
    if (tabRecordingsBtn) {
      tabRecordingsBtn.classList.add('active');
      tabRecordingsBtn.setAttribute('aria-selected', 'true');
    }
    if (sectionPdfs) sectionPdfs.classList.add('hidden');
    if (sectionRecordings) sectionRecordings.classList.remove('hidden');

    if (btnSyncGithub) btnSyncGithub.classList.add('hidden');
    if (btnSyncDriveTop) btnSyncDriveTop.classList.remove('hidden');

    // Se i dati di Drive non sono ancora stati caricati in memoria, caricali
    if (!driveTreeData) {
      initDriveSection();
    } else {
      renderDriveView();
    }
  } else {
    if (tabRecordingsBtn) {
      tabRecordingsBtn.classList.remove('active');
      tabRecordingsBtn.setAttribute('aria-selected', 'false');
    }
    if (tabPdfsBtn) {
      tabPdfsBtn.classList.add('active');
      tabPdfsBtn.setAttribute('aria-selected', 'true');
    }
    if (sectionRecordings) sectionRecordings.classList.add('hidden');
    if (sectionPdfs) sectionPdfs.classList.remove('hidden');

    if (btnSyncDriveTop) btnSyncDriveTop.classList.add('hidden');
    if (btnSyncGithub) btnSyncGithub.classList.remove('hidden');
  }
}

/**
 * Pulisce i nomi dei file e delle cartelle rimuovendo i suffissi di Google Drive (es. ' Audio Shared')
 */
function cleanDriveItemName(raw, isFolder = false) {
  if (!raw) return '';
  let name = String(raw).trim();
  if (isFolder) {
    return name.replace(/\s+(Shared folder|cartella condivisa|folder|cartella|shared|condiviso)$/i, '').trim();
  }
  // Se ha un'estensione nota seguita dai suffissi di accessibilità di Google Drive (es. '.mp3 Audio Shared')
  name = name.replace(/\.(mp3|m4a|wav|aac|flac|ogg|wma|mp4|mkv|pdf|zip|rar|7z)\b.*$/i, '.$1');
  // Rimuove eventuali suffissi rimasti
  name = name.replace(/\s+(Audio Shared|Audio Condiviso|Audio|Video Shared|Video Condiviso|Video|PDF Shared|PDF Condiviso|Document Shared|Document Condiviso|Shared|Condiviso)$/i, '').trim();
  return name;
}

/**
 * Pulisce ricorsivamente tutti i nomi dei nodi e dei file nell'albero di Google Drive
 */
function sanitizeDriveTreeNames(node) {
  if (!node) return;
  if (node.name) {
    node.name = cleanDriveItemName(node.name, node.isFolder);
  }
  if (Array.isArray(node.files)) {
    node.files.forEach(f => {
      f.name = cleanDriveItemName(f.name, false);
    });
  }
  if (Array.isArray(node.folders)) {
    node.folders.forEach(sub => sanitizeDriveTreeNames(sub));
  }
}

/**
 * Inizializza la sezione Google Drive (da cache locale o backend)
 */
async function initDriveSection() {
  const cachedJson = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE);
  if (cachedJson) {
    try {
      driveTreeData = JSON.parse(cachedJson);
      sanitizeDriveTreeNames(driveTreeData);
      // Salva la versione con i nomi puliti in cache
      localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE, JSON.stringify(driveTreeData));
      restoreDrivePathFromStorage();
      renderDriveView();
    } catch (e) {
      console.warn('Errore lettura cache Google Drive:', e);
    }
  }

  // Se non c'è cache o la cache è vuota, sincronizza da Drive
  if (!driveTreeData) {
    await syncFromDrive({ isForce: false, showNotice: false });
  }
}

/**
 * Esegue la scansione ricorsiva di Google Drive tramite il proxy Express del server
 */
async function syncFromDrive({ isForce = false, showNotice = true } = {}) {
  const loadingState = document.getElementById('drive-loading-state');
  const loadingText = document.getElementById('drive-loading-text');
  const emptyState = document.getElementById('drive-empty-state');
  const treeContainer = document.getElementById('drive-tree-view');

  if (loadingState) {
    loadingState.classList.remove('hidden');
    if (loadingText) {
      loadingText.textContent = isForce
        ? 'Aggiornamento forzato in corso da Google Drive...'
        : 'Scansione ricorsiva di Google Drive in corso...';
    }
  }
  if (emptyState) emptyState.classList.add('hidden');
  if (treeContainer) treeContainer.innerHTML = '';

  try {
    const folderId = window.APP_CONFIG.DEFAULT_DRIVE_FOLDER_ID;
    const url = `/api/drive/tree?folderId=${encodeURIComponent(folderId)}${isForce ? '&force=true' : ''}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Il server ha risposto con codice ${res.status}`);
    }

    const data = await res.json();
    if (data && data.tree) {
      driveTreeData = data.tree;
      sanitizeDriveTreeNames(driveTreeData);

      // Salva in cache per consultazione offline
      try {
        localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE, JSON.stringify(driveTreeData));
        localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_LAST_SYNC, String(Date.now()));
      } catch (e) {}

      updateDriveMetaUI(Date.now());
      restoreDrivePathFromStorage();
      renderDriveView();

      if (showNotice) {
        showToast('Google Drive sincronizzato con successo!', 'success');
      }
    } else {
      throw new Error('Risposta albero Drive non valida');
    }
  } catch (err) {
    console.error('Errore sincronizzazione Google Drive:', err);
    if (showNotice) {
      showToast('Errore durante la scansione di Google Drive: ' + err.message, 'error');
    }

    // Se abbiamo dati in cache li manteniamo, altrimenti mostra empty state
    if (!driveTreeData) {
      renderDriveView();
    }
  } finally {
    if (loadingState) loadingState.classList.add('hidden');
  }
}

/**
 * Aggiorna il testo dell'ultimo aggiornamento per Google Drive
 */
function updateDriveMetaUI(timestamp) {
  const metaText = document.getElementById('drive-meta-text');
  if (metaText) {
    const formatted = timestamp ? formatDate(timestamp) : '';
    metaText.textContent = `Google Drive: 3° ANNO${formatted ? ` (${formatted})` : ''}`;
  }
}

/**
 * Carica lezioni e registrazioni dimostrative per IngSw qualora la cartella Drive sia vuota
 */
function loadDemoRecordingsData() {
  const demoLessons = [
    {
      id: 'demo-lesson-1',
      name: 'Lezione 01 - 02 Ottobre: Introduzione, Processi Software e Agile',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [
        {
          id: 'demo-rec-1-1',
          name: 'Registrazione_Lezione_01_Parte1.m4a',
          isFolder: false,
          mimeType: 'audio/mp4',
          size: '28.4 MB',
          duration: '48:15',
          isDemo: true,
        },
        {
          id: 'demo-rec-1-2',
          name: 'Registrazione_Lezione_01_Parte2.m4a',
          isFolder: false,
          mimeType: 'audio/mp4',
          size: '31.2 MB',
          duration: '52:40',
          isDemo: true,
        },
      ],
    },
    {
      id: 'demo-lesson-2',
      name: 'Lezione 02 - 04 Ottobre: Modelli di Ciclo di Vita (Scrum, Sprint, Kanban)',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [
        {
          id: 'demo-rec-2-1',
          name: 'Registrazione_Lezione_02_Intera.mp3',
          isFolder: false,
          mimeType: 'audio/mpeg',
          size: '54.0 MB',
          duration: '1:34:10',
          isDemo: true,
        },
      ],
    },
    {
      id: 'demo-lesson-3',
      name: 'Lezione 03 - 09 Ottobre: Ingegneria dei Requisiti e Diagrammi Casi d\'Uso',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [
        {
          id: 'demo-rec-3-1',
          name: 'Registrazione_Lezione_03_Requisiti.m4a',
          isFolder: false,
          mimeType: 'audio/mp4',
          size: '42.8 MB',
          duration: '1:12:05',
          isDemo: true,
        },
      ],
    },
    {
      id: 'demo-lesson-4',
      name: 'Lezione 04 - 11 Ottobre: Architetture Software, Microservizi e Pattern MVC',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [
        {
          id: 'demo-rec-4-1',
          name: 'Registrazione_Lezione_04_Parte1.m4a',
          isFolder: false,
          mimeType: 'audio/mp4',
          size: '26.5 MB',
          duration: '45:20',
          isDemo: true,
        },
        {
          id: 'demo-rec-4-2',
          name: 'Registrazione_Lezione_04_Parte2.m4a',
          isFolder: false,
          mimeType: 'audio/mp4',
          size: '29.1 MB',
          duration: '50:35',
          isDemo: true,
        },
      ],
    },
  ];

  // Se l'albero esiste già, inserisce le lezioni dentro la cartella IngSw
  if (driveTreeData) {
    let ingSwNode = null;

    // Ricerca ricorsiva della cartella IngSw
    function findIngSw(node) {
      if (!node) return null;
      if (node.name && node.name.toLowerCase().includes('ingsw')) return node;
      if (node.folders) {
        for (const sub of node.folders) {
          const found = findIngSw(sub);
          if (found) return found;
        }
      }
      return null;
    }

    ingSwNode = findIngSw(driveTreeData);

    if (ingSwNode) {
      ingSwNode.folders = demoLessons;
    } else {
      // Inserisce nel primo semestre
      const sem = driveTreeData.folders && driveTreeData.folders[0];
      if (sem) {
        sem.folders = [
          {
            id: 'demo-ingsw',
            name: 'IngSw',
            isFolder: true,
            mimeType: 'application/vnd.google-apps.folder',
            folders: demoLessons,
            files: [],
          },
        ];
      }
    }
  } else {
    // Crea l'intera gerarchia demo richiesta: 3° ANNO -> 1° Semestre -> IngSw -> Lezioni
    driveTreeData = {
      id: '1k77YG_N_xwMctML4d-aV2PfuyIY-ECKS',
      name: '3° ANNO',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      files: [],
      folders: [
        {
          id: '1oJdlFXTfSfk8FNGYKCp1ccP9pbr6JLDV',
          name: '1° Semestre',
          isFolder: true,
          mimeType: 'application/vnd.google-apps.folder',
          files: [],
          folders: [
            {
              id: '10VrE-Ckz9jibG865K32mZiY0wOgyPgaf',
              name: 'IngSw',
              isFolder: true,
              mimeType: 'application/vnd.google-apps.folder',
              files: [],
              folders: demoLessons,
            },
          ],
        },
      ],
    };
  }

  try {
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CACHE, JSON.stringify(driveTreeData));
  } catch (e) {}

  renderDriveView();
  showToast('Lezioni dimostrative di Ingegneria del Software caricate!', 'success');
}

/**
 * Calcola il nodo corrente in base allo stack di navigazione
 */
function getCurrentDriveNode() {
  if (!driveTreeData) return null;
  if (drivePathStack.length === 0) return driveTreeData;
  return drivePathStack[drivePathStack.length - 1];
}

/**
 * Salva il percorso corrente di navigazione in localStorage
 */
function saveCurrentDrivePath() {
  try {
    const ids = drivePathStack.map(node => node.id);
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CURRENT_PATH, JSON.stringify(ids));
  } catch (e) {}
}

/**
 * Ottiene l'ID della cartella impostata come predefinita
 */
function getDefaultDriveFolderId() {
  try {
    return localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_DEFAULT_PATH) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Verifica se un nodo corrisponde alla cartella predefinita
 */
function isCurrentNodeDefault(nodeId) {
  const savedDefault = getDefaultDriveFolderId();
  if (!savedDefault) {
    // Di default se non specificato altrimenti, la cartella principale di Drive è predefinita
    return driveTreeData && (driveTreeData.id === nodeId || nodeId === 'root');
  }
  return savedDefault === nodeId;
}

/**
 * Imposta una cartella come predefinita per l'avvio dell'applicazione
 */
function setFolderAsDefault(node, pathStack) {
  try {
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_DEFAULT_PATH, node.id);
    const ids = (pathStack || []).map(n => n.id);
    localStorage.setItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CURRENT_PATH, JSON.stringify(ids));
    showToast(`"${node.name}" impostata come cartella predefinita!`, 'success');
    renderDriveView();
  } catch (e) {
    console.error('Errore nel salvare la cartella predefinita:', e);
  }
}

/**
 * Cerca il path verso un nodo dato il suo ID
 */
function findPathToNodeId(root, targetId, currentPath = []) {
  if (!root) return null;
  if (root.id === targetId) {
    return currentPath;
  }
  for (const sub of (root.folders || [])) {
    const found = findPathToNodeId(sub, targetId, [...currentPath, sub]);
    if (found) return found;
  }
  return null;
}

/**
 * Risolve una lista di ID in uno stack di nodi
 */
function resolveDrivePathByIds(root, idList) {
  if (!root || !Array.isArray(idList) || idList.length === 0) return [];
  const stack = [];
  let current = root;

  for (const id of idList) {
    if (id === root.id) continue;
    const next = (current.folders || []).find(f => f.id === id);
    if (next) {
      stack.push(next);
      current = next;
    } else {
      break;
    }
  }
  return stack;
}

/**
 * Ripristina il percorso della cartella da localStorage (default o ultimo visitato)
 */
function restoreDrivePathFromStorage() {
  if (!driveTreeData) return;

  const defaultId = getDefaultDriveFolderId();
  let targetIds = null;

  try {
    const savedPathStr = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_DRIVE_CURRENT_PATH);
    if (savedPathStr) {
      targetIds = JSON.parse(savedPathStr);
    }
  } catch (e) {}

  if (Array.isArray(targetIds) && targetIds.length > 0) {
    const resolved = resolveDrivePathByIds(driveTreeData, targetIds);
    if (resolved && resolved.length > 0) {
      drivePathStack = resolved;
      return;
    }
  }

  if (defaultId) {
    const pathToDefault = findPathToNodeId(driveTreeData, defaultId);
    if (pathToDefault && pathToDefault.length > 0) {
      drivePathStack = pathToDefault;
      return;
    }
  }

  drivePathStack = [];
}

/**
 * Rendering del Breadcrumb e del contenuto ricorsivo di Google Drive
 */
function renderDriveView() {
  const container = document.getElementById('drive-tree-view');
  const emptyState = document.getElementById('drive-empty-state');
  const breadcrumbsNav = document.getElementById('drive-breadcrumbs');
  const searchInput = document.getElementById('drive-search-input');
  const searchQuery = (searchInput ? searchInput.value : '').trim().toLowerCase();

  if (!container || !breadcrumbsNav) return;

  // 1. Aggiorna Breadcrumbs
  renderDriveBreadcrumbs(breadcrumbsNav);

  if (!driveTreeData) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  const currentNode = getCurrentDriveNode();
  if (!currentNode) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  const currentLevelDepth = drivePathStack.length; // 0 = Root (3° ANNO), 1 = Semestre, 2 = Materia (IngSw), 3 = Lezione

  // Raccoglie sottocartelle e file del livello corrente filtrati dalla ricerca
  const folders = (currentNode.folders || []).filter(f => !searchQuery || f.name.toLowerCase().includes(searchQuery));
  const files = (currentNode.files || []).filter(f => !searchQuery || f.name.toLowerCase().includes(searchQuery));

  // Verifica se la cartella è vuota
  const isEmpty = folders.length === 0 && files.length === 0;

  if (isEmpty) {
    container.innerHTML = '';
    if (emptyState) {
      emptyState.classList.remove('hidden');
      const emptyTitle = document.getElementById('drive-empty-title');
      const emptyDesc = document.getElementById('drive-empty-desc');
      if (emptyTitle && emptyDesc) {
        emptyTitle.textContent = `Nessun elemento in "${currentNode.name}"`;
        emptyDesc.innerHTML = `Questa cartella su Google Drive è attualmente vuota o non contiene file audio.<br>
          Puoi provare con le registrazioni dimostrative di esempio oppure ricaricare la scansione da Drive.`;
      }
    }
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');
  container.innerHTML = '';

  // 2. Render in base al livello gerarchico
  // Livello 0: Cartella Principale "3° ANNO" (mostra direttamente i semestri al suo interno)
  if (currentLevelDepth === 0) {
    renderYearLevel(container, currentNode, folders);
    return;
  }

  // Livello 1: Scelta del Semestre (es. "1° Semestre")
  if (currentLevelDepth === 1) {
    renderSemesterLevel(container, currentNode, folders, files);
    return;
  }

  // Livello 2: Scelta del Percorso / Materia (es. "IngSw")
  if (currentLevelDepth === 2) {
    renderSubjectLevel(container, currentNode, folders, files);
    return;
  }

  // Livello 3 o superiore: Elenco delle Lezioni con registrazioni audio
  renderLessonsLevel(container, currentNode, folders, files);
}

/**
 * Rendering del Breadcrumb bar
 */
function renderDriveBreadcrumbs(navElement) {
  navElement.innerHTML = '';

  // Tasto Root (Cartella Principale 3° ANNO)
  const rootBtn = document.createElement('button');
  rootBtn.className = `breadcrumb-btn ${drivePathStack.length === 0 ? 'active' : ''}`;
  rootBtn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg>
    <span>${driveTreeData ? driveTreeData.name : '3° ANNO'}</span>
  `;
  rootBtn.addEventListener('click', () => {
    drivePathStack = [];
    saveCurrentDrivePath();
    renderDriveView();
  });
  navElement.appendChild(rootBtn);

  // Livelli nello stack
  drivePathStack.forEach((node, index) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '›';
    navElement.appendChild(sep);

    const isLast = index === drivePathStack.length - 1;
    const btn = document.createElement('button');
    btn.className = `breadcrumb-btn ${isLast ? 'active' : ''}`;
    btn.textContent = node.name;

    if (!isLast) {
      btn.addEventListener('click', () => {
        drivePathStack = drivePathStack.slice(0, index + 1);
        saveCurrentDrivePath();
        renderDriveView();
      });
    }

    navElement.appendChild(btn);
  });
}

/**
 * Livello 0: Mostra direttamente la cartella principale "3° ANNO" con i suoi semestri
 */
function renderYearLevel(container, rootNode, folders) {
  const isDefault = isCurrentNodeDefault(rootNode.id);
  const semestersCount = (folders || []).length;

  const header = document.createElement('div');
  header.className = 'drive-level-header';
  header.innerHTML = `
    <div class="drive-level-title">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
      <span>${rootNode.name || '3° ANNO'}</span>
      ${isDefault ? '<span class="default-folder-tag" title="Cartella predefinita">⭐ Predefinita</span>' : ''}
      <button class="btn-set-default ${isDefault ? 'is-default' : ''}" type="button" title="${isDefault ? 'Cartella predefinita all\'avvio' : 'Imposta come cartella predefinita all\'avvio'}">
        ${isDefault ? '⭐ Cartella di default' : '☆ Imposta come default'}
      </button>
    </div>
    <div class="drive-level-count">${semestersCount} semestre/i disponibile/i</div>
  `;

  const btnDefault = header.querySelector('.btn-set-default');
  if (btnDefault) {
    btnDefault.addEventListener('click', (e) => {
      e.stopPropagation();
      setFolderAsDefault(rootNode, []);
    });
  }

  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'drive-grid';

  folders.forEach(sem => {
    const subjectsCount = (sem.folders || []).length;
    const directFilesCount = (sem.files || []).length;
    const card = document.createElement('div');
    card.className = 'drive-folder-card';
    card.innerHTML = `
      <div class="drive-folder-main">
        <div class="drive-folder-icon icon-semester">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </div>
        <div class="drive-folder-info">
          <div class="drive-folder-title">${sem.name}</div>
          <div class="drive-folder-meta">${subjectsCount > 0 ? `${subjectsCount} materie e percorsi` : `${directFilesCount} file audio`} • Clicca per aprire</div>
        </div>
      </div>
      <div class="drive-folder-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
    `;

    card.addEventListener('click', () => {
      drivePathStack.push(sem);
      saveCurrentDrivePath();
      renderDriveView();
    });

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

/**
 * Livello 1: Mostra le materie / percorsi del semestre (es. "1° Semestre")
 */
function renderSemesterLevel(container, semesterNode, folders, directFiles) {
  const isDefault = isCurrentNodeDefault(semesterNode.id);
  const subjectsCount = folders.length;

  const header = document.createElement('div');
  header.className = 'drive-level-header';
  header.innerHTML = `
    <div class="drive-level-title">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="16" y1="2" x2="16" y2="6"></line>
        <line x1="8" y1="2" x2="8" y2="6"></line>
        <line x1="3" y1="10" x2="21" y2="10"></line>
      </svg>
      <span>${semesterNode.name}</span>
      ${isDefault ? '<span class="default-folder-tag" title="Cartella predefinita">⭐ Predefinita</span>' : ''}
      <button class="btn-set-default ${isDefault ? 'is-default' : ''}" type="button" title="${isDefault ? 'Cartella predefinita all\'avvio' : 'Imposta come cartella predefinita all\'avvio'}">
        ${isDefault ? '⭐ Cartella di default' : '☆ Imposta come default'}
      </button>
    </div>
    <div class="drive-level-count">${subjectsCount} materia/e disponibile/i</div>
  `;

  const btnDefault = header.querySelector('.btn-set-default');
  if (btnDefault) {
    btnDefault.addEventListener('click', (e) => {
      e.stopPropagation();
      setFolderAsDefault(semesterNode, drivePathStack);
    });
  }

  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'drive-grid';

  folders.forEach(subj => {
    const lessonsCount = (subj.folders || []).length;
    const directFilesCount = (subj.files || []).length;
    const card = document.createElement('div');
    card.className = 'drive-folder-card';
    card.innerHTML = `
      <div class="drive-folder-main">
        <div class="drive-folder-icon icon-subject">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
        </div>
        <div class="drive-folder-info">
          <div class="drive-folder-title">${subj.name}</div>
          <div class="drive-folder-meta">${directFilesCount > 0 ? `${directFilesCount} registrazioni audio` : (lessonsCount > 0 ? `${lessonsCount} cartelle lezioni` : 'Cartella registrazioni')} • Clicca per aprire</div>
        </div>
      </div>
      <div class="drive-folder-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
    `;

    card.addEventListener('click', () => {
      drivePathStack.push(subj);
      saveCurrentDrivePath();
      renderDriveView();
    });

    grid.appendChild(card);
  });

  container.appendChild(grid);

  if (directFiles && directFiles.length > 0) {
    renderFilesSection(container, directFiles, semesterNode.name);
  }
}

/**
 * Livello 2: Mostra le lezioni o registrazioni della materia (es. "IngSw")
 */
function renderSubjectLevel(container, subjectNode, folders, directFiles) {
  renderLessonsLevel(container, subjectNode, folders, directFiles);
}

/**
 * Livello 3 o lezioni: Elenco delle Lezioni o file audio diretti con registrazioni
 */
function renderLessonsLevel(container, subjectNode, lessonFolders, directFiles) {
  const isDefault = isCurrentNodeDefault(subjectNode.id);
  const totalCount = lessonFolders.length > 0 ? lessonFolders.length : (directFiles ? directFiles.length : 0);
  const countLabel = lessonFolders.length > 0 
    ? `${lessonFolders.length} lezione/i registrata/e` 
    : `${(directFiles || []).length} registrazione/i audio`;

  const header = document.createElement('div');
  header.className = 'drive-level-header';
  header.innerHTML = `
    <div class="drive-level-title">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <line x1="12" y1="19" x2="12" y2="23"></line>
        <line x1="8" y1="23" x2="16" y2="23"></line>
      </svg>
      <span>${subjectNode.name}</span>
      ${isDefault ? '<span class="default-folder-tag" title="Cartella predefinita">⭐ Predefinita</span>' : ''}
      <button class="btn-set-default ${isDefault ? 'is-default' : ''}" type="button" title="${isDefault ? 'Cartella predefinita all\'avvio' : 'Imposta come cartella predefinita all\'avvio'}">
        ${isDefault ? '⭐ Cartella di default' : '☆ Imposta come default'}
      </button>
    </div>
    <div class="drive-level-count">${countLabel}</div>
  `;

  const btnDefault = header.querySelector('.btn-set-default');
  if (btnDefault) {
    btnDefault.addEventListener('click', (e) => {
      e.stopPropagation();
      setFolderAsDefault(subjectNode, drivePathStack);
    });
  }

  container.appendChild(header);

  // Se non ci sono cartelle di lezione né file
  if (lessonFolders.length === 0 && (!directFiles || directFiles.length === 0)) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'empty-state';
    emptyNotice.innerHTML = `
      <div class="empty-state-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        </svg>
      </div>
      <h3 class="empty-state-title">Nessuna lezione ancora caricata</h3>
      <p class="empty-state-desc">La cartella "<strong>${subjectNode.name}</strong>" su Google Drive è attualmente vuota.</p>
      <div class="empty-state-actions">
        <button class="btn-primary" id="btn-load-demo-inline">
          ✨ Carica lezioni demo di IngSw
        </button>
      </div>
    `;
    const demoBtn = emptyNotice.querySelector('#btn-load-demo-inline');
    if (demoBtn) demoBtn.addEventListener('click', loadDemoRecordingsData);
    container.appendChild(emptyNotice);
    return;
  }

  // CASO 1: La cartella contiene direttamente file audio (es. IngSw con 13 file audio)
  if (lessonFolders.length === 0 && directFiles && directFiles.length > 0) {
    const directContainer = document.createElement('div');
    directContainer.className = 'lesson-card expanded';
    directContainer.style.overflow = 'hidden';

    const cardBody = document.createElement('div');
    cardBody.className = 'lesson-body';

    const toolbar = document.createElement('div');
    toolbar.className = 'lesson-toolbar';
    toolbar.innerHTML = `
      <span>Tutte le registrazioni (${directFiles.length})</span>
      <button class="lesson-select-all-btn" type="button">
        Seleziona tutte (${directFiles.length})
      </button>
    `;

    const selectAllBtn = toolbar.querySelector('.lesson-select-all-btn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const allSelected = directFiles.every(r => selectedRecordings.has(r.id));
        if (allSelected) {
          directFiles.forEach(r => selectedRecordings.delete(r.id));
          selectAllBtn.textContent = `Seleziona tutte (${directFiles.length})`;
        } else {
          directFiles.forEach(r => selectedRecordings.set(r.id, r));
          selectAllBtn.textContent = 'Deseleziona tutte';
        }
        updateBatchBarUI();
        renderDriveView();
      });
    }
    cardBody.appendChild(toolbar);

    directFiles.forEach(rec => {
      const itemRow = createRecordingItemElement(rec, subjectNode.name);
      cardBody.appendChild(itemRow);
    });

    directContainer.appendChild(cardBody);
    container.appendChild(directContainer);
    return;
  }

  // CASO 2: La cartella contiene sottocartelle di lezioni (accordion)
  const lessonsList = document.createElement('div');
  lessonsList.style.display = 'flex';
  lessonsList.style.flexDirection = 'column';
  lessonsList.style.gap = '0.875rem';

  lessonFolders.forEach((lesson, index) => {
    const recordings = lesson.files || [];
    const isExpanded = expandedLessons.has(lesson.id) || index === 0;

    const card = document.createElement('div');
    card.className = `lesson-card ${isExpanded ? 'expanded' : ''}`;
    card.id = `lesson-card-${lesson.id}`;

    const cardHeader = document.createElement('div');
    cardHeader.className = 'lesson-card-header';
    cardHeader.innerHTML = `
      <div class="lesson-header-left">
        <div class="drive-folder-icon icon-lesson" style="width: 38px; height: 38px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
        </div>
        <div>
          <div class="lesson-title">${lesson.name}</div>
          <div class="lesson-meta">${recordings.length} file audio • Tocca per ${isExpanded ? 'comprimere' : 'espandere'}</div>
        </div>
      </div>
      <div class="lesson-header-right">
        <span class="lesson-recordings-count-badge">${recordings.length} file</span>
        <div class="lesson-toggle-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </div>
    `;

    cardHeader.addEventListener('click', () => {
      if (expandedLessons.has(lesson.id)) {
        expandedLessons.delete(lesson.id);
        card.classList.remove('expanded');
      } else {
        expandedLessons.add(lesson.id);
        card.classList.add('expanded');
      }
    });

    card.appendChild(cardHeader);

    const cardBody = document.createElement('div');
    cardBody.className = 'lesson-body';

    if (recordings.length === 0) {
      cardBody.innerHTML = `
        <div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.875rem;">
          Nessuna registrazione audio presente in questa cartella.
        </div>
      `;
    } else {
      const toolbar = document.createElement('div');
      toolbar.className = 'lesson-toolbar';
      toolbar.innerHTML = `
        <span>Registrazioni della lezione</span>
        <button class="lesson-select-all-btn" type="button">
          Seleziona tutte (${recordings.length})
        </button>
      `;

      const selectAllBtn = toolbar.querySelector('.lesson-select-all-btn');
      if (selectAllBtn) {
        selectAllBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const allSelected = recordings.every(r => selectedRecordings.has(r.id));
          if (allSelected) {
            recordings.forEach(r => selectedRecordings.delete(r.id));
            selectAllBtn.textContent = `Seleziona tutte (${recordings.length})`;
          } else {
            recordings.forEach(r => selectedRecordings.set(r.id, r));
            selectAllBtn.textContent = 'Deseleziona tutte';
          }
          updateBatchBarUI();
          renderDriveView();
        });
      }
      cardBody.appendChild(toolbar);

      recordings.forEach(rec => {
        const itemRow = createRecordingItemElement(rec, lesson.name);
        cardBody.appendChild(itemRow);
      });
    }

    card.appendChild(cardBody);
    lessonsList.appendChild(card);
  });

  container.appendChild(lessonsList);

  if (directFiles && directFiles.length > 0) {
    renderFilesSection(container, directFiles, subjectNode.name);
  }
}


/**
 * Renderizza una sezione per file diretti (non all'interno di una sottocartella)
 */
function renderFilesSection(container, files, contextName) {
  const header = document.createElement('div');
  header.className = 'drive-level-header';
  header.style.marginTop = '1.5rem';
  header.innerHTML = `
    <div class="drive-level-title">
      <span>File Diretti</span>
    </div>
    <div class="drive-level-count">${files.length} file</div>
  `;
  container.appendChild(header);

  const list = document.createElement('div');
  files.forEach(file => {
    list.appendChild(createRecordingItemElement(file, contextName));
  });
  container.appendChild(list);
}

/**
 * Crea l'elemento DOM per una singola registrazione audio con checkbox, anteprima e download
 */
function createRecordingItemElement(rec, lessonName) {
  const isSelected = selectedRecordings.has(rec.id);
  const cleanName = cleanDriveItemName(rec.name, false);
  rec.name = cleanName;

  // Estrae l'estensione pulita (es. 'mp3', 'm4a', 'wav')
  let ext = 'mp3';
  if (cleanName.includes('.')) {
    const parts = cleanName.split('.');
    ext = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  if (!ext || ext.length > 5) ext = 'mp3';

  const item = document.createElement('div');
  item.className = `recording-item ${isSelected ? 'selected' : ''}`;
  item.id = `recording-row-${rec.id}`;

  item.innerHTML = `
    <div class="recording-left">
      <input type="checkbox" class="recording-checkbox" aria-label="Seleziona ${cleanName}" ${isSelected ? 'checked' : ''}>
      <div class="recording-audio-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
      </div>
      <div class="recording-details">
        <div class="recording-name" title="${cleanName}">${cleanName}</div>
        <div class="recording-meta">
          <span class="recording-tag">${ext}</span>
          ${rec.size ? `<span>${rec.size}</span>` : ''}
          ${rec.duration ? `<span>• ${rec.duration}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="recording-actions">
      <button type="button" class="recording-btn-play" title="Ascolta anteprima audio">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>Ascolta</span>
      </button>
      <button type="button" class="recording-btn-download" title="Scarica questa registrazione">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Scarica</span>
      </button>
    </div>
  `;

  // Listener checkbox selezione multipla
  const checkbox = item.querySelector('.recording-checkbox');
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    if (checkbox.checked) {
      selectedRecordings.set(rec.id, rec);
      item.classList.add('selected');
    } else {
      selectedRecordings.delete(rec.id);
      item.classList.remove('selected');
    }
    updateBatchBarUI();
  });

  // Tasto Ascolta Anteprima
  const playBtn = item.querySelector('.recording-btn-play');
  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playAudioRecording(rec, lessonName);
  });

  // Tasto Scarica Singolo
  const dlBtn = item.querySelector('.recording-btn-download');
  dlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadSingleRecording(rec);
  });

  return item;
}

/**
 * Aggiorna la barra fluttuante di selezione multipla (Download Multiplo)
 */
function updateBatchBarUI() {
  const batchBar = document.getElementById('recordings-batch-bar');
  const countBadge = document.getElementById('batch-selected-count');
  const dlButtonText = document.getElementById('btn-batch-download-text');

  const count = selectedRecordings.size;

  if (count > 0) {
    if (batchBar) batchBar.classList.remove('hidden');
    if (countBadge) countBadge.textContent = String(count);
    if (dlButtonText) dlButtonText.textContent = `Scarica Selezionate (${count})`;
  } else {
    if (batchBar) batchBar.classList.add('hidden');
  }
}

/**
 * Avvia il download di una singola registrazione con nome pulito (.mp3) tramite Blob in-page
 */
async function downloadSingleRecording(rec) {
  const cleanName = cleanDriveItemName(rec.name, false);
  const finalFilename = /\.[a-zA-Z0-9]+$/.test(cleanName) ? cleanName : `${cleanName}.mp3`;
  rec.name = finalFilename;

  if (rec.isDemo) {
    downloadSyntheticAudioFile(finalFilename);
    return;
  }

  showToast(`⏳ Preparazione download: ${finalFilename}...`, 'info');

  try {
    // 1. Tenta il download diretto tramite fetch del Blob per evitare che l'iframe apra una scheda vuota
    const downloadUrl = `/api/drive/download/${encodeURIComponent(rec.id)}?name=${encodeURIComponent(finalFilename)}`;
    
    let res;
    try {
      res = await fetch(downloadUrl);
    } catch (fetchErr) {
      // Fallback su endpoint usercontent diretto di Google Drive (ha CORS abilitato)
      res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(rec.id)}&export=download`);
    }

    if (!res || !res.ok) {
      throw new Error(`Risposta server non valida (${res ? res.status : 'errore di rete'})`);
    }

    const contentLength = res.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

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
        if (totalBytes > 0 && now - lastToast > 2000) {
          lastToast = now;
          const pct = Math.round((loaded / totalBytes) * 100);
          const mbL = (loaded / (1024 * 1024)).toFixed(1);
          const mbT = (totalBytes / (1024 * 1024)).toFixed(1);
          showToast(`⏳ Scaricamento: ${pct}% (${mbL} di ${mbT} MB)...`, 'info');
        }
      }
      blob = new Blob(chunks, { type: 'audio/mpeg' });
    } else {
      blob = await res.blob();
    }

    // 2. Crea un Object URL dal Blob scaricato
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 45000);

    showToast(`✅ Download completato: ${finalFilename}`, 'success');
  } catch (err) {
    console.error('Errore download registrazione:', err);
    // Fallback: se il download Blob fallisce per restrizioni del browser, apri il link diretto
    showToast(`Apertura download diretto per ${finalFilename}...`, 'info');
    const directA = document.createElement('a');
    directA.href = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(rec.id)}&export=download`;
    directA.target = '_blank';
    directA.rel = 'noopener noreferrer';
    directA.download = finalFilename;
    document.body.appendChild(directA);
    directA.click();
    directA.remove();
  }
}

/**
 * Avvia il download sequenziale di tutte le registrazioni selezionate
 */
async function downloadSelectedBatchRecordings() {
  const filesToDownload = Array.from(selectedRecordings.values());
  if (filesToDownload.length === 0) {
    showToast('Nessuna registrazione selezionata.', 'info');
    return;
  }

  const total = filesToDownload.length;
  showToast(`Avvio download di ${total} registrazioni...`, 'info');

  for (let i = 0; i < total; i++) {
    const file = filesToDownload[i];
    await downloadSingleRecording(file);

    // Piccolo intervallo tra i download per evitare che i browser mobili blocchino i download multipli
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  showToast(`Tutte le ${total} registrazioni sono state avviate al download!`, 'success');
  selectedRecordings.clear();
  updateBatchBarUI();
  renderDriveView();
}

/**
 * Genera un file audio sintetico scaricabile per i dati demo
 */
function downloadSyntheticAudioFile(filename) {
  try {
    // Genera un piccolo buffer audio WAV standard (tono a 440Hz di 2 secondi)
    const sampleRate = 44100;
    const numSamples = sampleRate * 2;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // Intestazione RIFF/WAVE
    function writeString(offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true);  // AudioFormat (PCM)
    view.setUint16(22, 1, true);  // NumChannels (Mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);  // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    // Genera tono sinusoidale a 440Hz
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('Errore creazione audio sintetico:', err);
  }
}

/**
 * Riproduce l'anteprima audio nel mini-player fluttuante
 */
function playAudioRecording(rec, lessonName) {
  const playerBar = document.getElementById('audio-player-bar');
  const titleEl = document.getElementById('audio-player-title');
  const subtitleEl = document.getElementById('audio-player-subtitle');
  const audioElement = document.getElementById('global-audio-element');

  if (!playerBar || !audioElement) return;

  activeAudioFile = rec;
  if (titleEl) titleEl.textContent = rec.name;
  if (subtitleEl) subtitleEl.textContent = lessonName || 'Registrazione Lezione';

  let srcUrl = '';
  if (rec.isDemo) {
    // Genera un tono sinusoidale con Web Audio API
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 3);
      showToast(`Riproduzione anteprima demo: ${rec.name}`, 'info');
    } catch (e) {}
  } else {
    srcUrl = `/api/drive/download/${encodeURIComponent(rec.id)}?name=${encodeURIComponent(rec.name)}`;
    audioElement.src = srcUrl;
    audioElement.play().catch(e => {
      console.warn('Autoplay bloccato dal browser:', e);
    });
  }

  playerBar.classList.remove('hidden');
}

/**
 * Chiude il mini-player audio
 */
function closeAudioPlayer() {
  const playerBar = document.getElementById('audio-player-bar');
  const audioElement = document.getElementById('global-audio-element');
  if (audioElement) {
    audioElement.pause();
    audioElement.src = '';
  }
  if (playerBar) playerBar.classList.add('hidden');
  activeAudioFile = null;
}
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

  // Pulsante Indice nella barra superiore: salta direttamente all'indice
  const goIndexBtn = document.getElementById('btn-go-to-index');
  if (goIndexBtn) {
    goIndexBtn.addEventListener('click', () => {
      if (!currentPdfDoc) return;
      goToPage(detectedIndexPageNum);
      showToast(`Passato all'indice (Pagina ${detectedIndexPageNum})`, 'info');
    });
  }

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

  /* ========================================================================
     INIZIALIZZAZIONE EVENTI SEZIONE REGISTRAZIONI (GOOGLE DRIVE)
     ======================================================================== */

  // Switcher Tab Dispense PDF vs Registrazioni
  const tabPdfsBtn = document.getElementById('tab-btn-pdfs');
  const tabRecordingsBtn = document.getElementById('tab-btn-recordings');
  if (tabPdfsBtn) tabPdfsBtn.addEventListener('click', () => switchAppTab('pdfs'));
  if (tabRecordingsBtn) tabRecordingsBtn.addEventListener('click', () => switchAppTab('recordings'));

  // Ripristina l'ultimo tab attivo salvato dall'utente (default: Registrazioni con la cartella predefinita)
  const savedTab = localStorage.getItem(window.APP_CONFIG.STORAGE_KEY_ACTIVE_TAB);
  if (savedTab === 'pdfs') {
    switchAppTab('pdfs');
  } else {
    // Di default all'avvio mostra la sezione Registrazioni con la cartella predefinita
    switchAppTab('recordings');
  }

  // Tasti sincronizzazione Google Drive
  const driveSyncTopBtn = document.getElementById('btn-drive-sync-top');
  if (driveSyncTopBtn) driveSyncTopBtn.addEventListener('click', () => syncFromDrive({ isForce: true, showNotice: true }));

  const driveRefreshBtn = document.getElementById('btn-drive-refresh');
  if (driveRefreshBtn) driveRefreshBtn.addEventListener('click', () => syncFromDrive({ isForce: true, showNotice: true }));

  const driveEmptyRefreshBtn = document.getElementById('btn-drive-empty-refresh');
  if (driveEmptyRefreshBtn) driveEmptyRefreshBtn.addEventListener('click', () => syncFromDrive({ isForce: true, showNotice: true }));

  const driveEmptyDemoBtn = document.getElementById('btn-drive-empty-demo');
  if (driveEmptyDemoBtn) driveEmptyDemoBtn.addEventListener('click', loadDemoRecordingsData);

  // Ricerca Registrazioni Google Drive
  const driveSearchInput = document.getElementById('drive-search-input');
  const driveSearchClear = document.getElementById('drive-search-clear');
  if (driveSearchInput) {
    driveSearchInput.addEventListener('input', () => {
      if (driveSearchClear) {
        driveSearchClear.classList.toggle('visible', driveSearchInput.value.length > 0);
      }
      renderDriveView();
    });
  }
  if (driveSearchClear && driveSearchInput) {
    driveSearchClear.addEventListener('click', () => {
      driveSearchInput.value = '';
      driveSearchClear.classList.remove('visible');
      renderDriveView();
      driveSearchInput.focus();
    });
  }

  // Barra di Azioni per Selezione Multipla
  const batchSelectAllBtn = document.getElementById('btn-batch-select-all');
  if (batchSelectAllBtn) {
    batchSelectAllBtn.addEventListener('click', () => {
      const currentNode = getCurrentDriveNode();
      if (!currentNode) return;
      function collectFiles(node) {
        let list = [...(node.files || [])];
        if (node.folders) {
          for (const f of node.folders) {
            list = list.concat(collectFiles(f));
          }
        }
        return list;
      }
      const allFiles = collectFiles(currentNode);
      allFiles.forEach(f => selectedRecordings.set(f.id, f));
      updateBatchBarUI();
      renderDriveView();
      showToast(`${allFiles.length} registrazioni selezionate`, 'info');
    });
  }

  const batchClearBtn = document.getElementById('btn-batch-clear');
  if (batchClearBtn) {
    batchClearBtn.addEventListener('click', () => {
      selectedRecordings.clear();
      updateBatchBarUI();
      renderDriveView();
    });
  }

  const batchDownloadBtn = document.getElementById('btn-batch-download');
  if (batchDownloadBtn) {
    batchDownloadBtn.addEventListener('click', downloadSelectedBatchRecordings);
  }

  // Mini-player audio close button
  const audioCloseBtn = document.getElementById('btn-audio-player-close');
  if (audioCloseBtn) audioCloseBtn.addEventListener('click', closeAudioPlayer);
});



// Funzione per avviare il download del file PDF
async function downloadPdf(pdfData, sha) {
  try {
    let record = pdfData && (pdfData.blob || pdfData.data) ? pdfData : null;

    if (!record) {
      const path = typeof pdfData === 'string' ? pdfData : null;
      const all = await dbGetAllPdfs();
      record = all.find(p => (path && p.path === path) || (sha && p.sha === sha));
    }

    if (!record || (!record.blob && !record.data)) {
      showToast('File non trovato in memoria offline. Aggiorna prima la sincronizzazione.', 'error');
      return;
    }

    const blob = record.blob || new Blob([record.data], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = record.fileName || 'documento.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Rilascia l'URL dopo che il download è partito
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast(`Download avviato: ${record.fileName}`, 'success');
  } catch (err) {
    console.error('Errore download PDF:', err);
    showToast('Impossibile scaricare il PDF: ' + err.message, 'error');
  }
}
