import express from 'express';
import type { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

import fs from 'fs';
import { Readable } from 'stream';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());

// Helper per recuperare i parametri GitHub dal file .env
function getEnvConfig() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const owner = (process.env.GITHUB_OWNER || 'federicodellini').trim();
  const repo = (process.env.GITHUB_REPO || 'obsidian-notes').trim();
  const branch = (process.env.GITHUB_BRANCH || 'main').trim();
  const rootPath = (process.env.GITHUB_ROOT_PATH || '00 - Obsidian Notes').trim();
  const rawExcludes = process.env.GITHUB_EXCLUDE_DIRS || 'assets,asset,Wait,Spunto,Essenziale';
  const excludeDirs = rawExcludes.split(',').map(s => s.trim()).filter(Boolean);

  return {
    token,
    owner,
    repo,
    branch,
    rootPath,
    excludeDirs,
    hasToken: Boolean(token),
  };
}

/* ==========================================================================
   ENDPOINT API SICURI (Proxy Server-Side)
   Il token GitHub rimane protetto nel server e NON viene mai inviato al client!
   ========================================================================== */

/**
 * GET /api/config
 * Restituisce le impostazioni pubbliche (.env) senza mai esporre il token segreto
 */
app.get('/api/config', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const cfg = getEnvConfig();
  res.json({
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    rootPath: cfg.rootPath,
    excludeDirs: cfg.excludeDirs,
    hasToken: cfg.hasToken,
    driveFolderId: DEFAULT_DRIVE_FOLDER_ID,
    serverMode: true,
  });
});

/**
 * GET /api/tree
 * Esegue la scansione dell'albero Git trees di GitHub iniettando il token .env
 * Supporta If-None-Match (ETag) per restituire 304 Not Modified se nulla è cambiato.
 */
app.get('/api/tree', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const cfg = getEnvConfig();
    const queryOwner = (req.query.owner as string) || cfg.owner;
    const queryRepo = (req.query.repo as string) || cfg.repo;
    const queryBranch = (req.query.branch as string) || cfg.branch;
    const isForce = req.query.force === 'true';

    const url = `https://api.github.com/repos/${encodeURIComponent(queryOwner)}/${encodeURIComponent(queryRepo)}/git/trees/${encodeURIComponent(queryBranch)}?recursive=1`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'NotePDF-Server-Proxy/1.0',
    };

    // Inietta il token segreto configurato in .env
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    // Inoltra l'ETag solo se non è richiesta una sincronizzazione forzata
    const clientETag = req.headers['if-none-match'];
    if (clientETag && !isForce) {
      headers['If-None-Match'] = Array.isArray(clientETag) ? clientETag[0] : clientETag;
    }

    const githubRes = await fetch(url, { headers });

    // Se GitHub risponde 304, restituisci immediatamente 304 al client
    if (githubRes.status === 304) {
      res.status(304).end();
      return;
    }

    const resETag = githubRes.headers.get('ETag');
    if (resETag) {
      res.setHeader('ETag', resETag);
    }

    // Inoltra intestazioni utili di rate limit
    const rateLimitRemaining = githubRes.headers.get('x-ratelimit-remaining');
    const rateLimitReset = githubRes.headers.get('x-ratelimit-reset');
    if (rateLimitRemaining) res.setHeader('x-ratelimit-remaining', rateLimitRemaining);
    if (rateLimitReset) res.setHeader('x-ratelimit-reset', rateLimitReset);

    if (!githubRes.ok) {
      const errBody = await githubRes.text();
      res.status(githubRes.status).send(errBody);
      return;
    }

    const data = await githubRes.json();
    res.json(data);
  } catch (err: any) {
    console.error('Errore /api/tree proxy:', err);
    res.status(500).json({ error: 'Errore interno nel proxy GitHub', details: err.message });
  }
});

/**
 * GET /api/blob/:sha
 * Scarica il file binario (PDF) da GitHub usando le credenziali sicure del server
 */
app.get('/api/blob/:sha', async (req: Request, res: Response) => {
  try {
    const cfg = getEnvConfig();
    const sha = req.params.sha;
    const queryOwner = (req.query.owner as string) || cfg.owner;
    const queryRepo = (req.query.repo as string) || cfg.repo;

    const url = `https://api.github.com/repos/${encodeURIComponent(queryOwner)}/${encodeURIComponent(queryRepo)}/git/blobs/${encodeURIComponent(sha)}`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.raw',
      'User-Agent': 'NotePDF-Server-Proxy/1.0',
    };

    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    const githubRes = await fetch(url, { headers });

    if (!githubRes.ok) {
      const errText = await githubRes.text();
      res.status(githubRes.status).send(errText);
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const arrayBuffer = await githubRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error('Errore /api/blob proxy:', err);
    res.status(500).json({ error: 'Impossibile recuperare il file PDF', details: err.message });
  }
});

/**
 * GET /api/raw
 * Proxy per file raw percorsi arbitrari
 */
app.get('/api/raw', async (req: Request, res: Response) => {
  try {
    const cfg = getEnvConfig();
    const filePath = req.query.path as string;
    const queryOwner = (req.query.owner as string) || cfg.owner;
    const queryRepo = (req.query.repo as string) || cfg.repo;
    const queryBranch = (req.query.branch as string) || cfg.branch;

    if (!filePath) {
      res.status(400).json({ error: 'Parametro path mancante' });
      return;
    }

    const url = `https://raw.githubusercontent.com/${encodeURIComponent(queryOwner)}/${encodeURIComponent(queryRepo)}/${encodeURIComponent(queryBranch)}/${encodeURI(filePath)}`;

    const headers: Record<string, string> = {
      'User-Agent': 'NotePDF-Server-Proxy/1.0',
    };

    if (cfg.token) {
      headers['Authorization'] = `token ${cfg.token}`;
    }

    const rawRes = await fetch(url, { headers });
    if (!rawRes.ok) {
      res.status(rawRes.status).send(await rawRes.text());
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    const arrayBuffer = await rawRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error('Errore /api/raw proxy:', err);
    res.status(500).json({ error: 'Errore nel download raw', details: err.message });
  }
});

/* ==========================================================================
   GOOGLE DRIVE INTEGRATION (Registrazioni Audio / Video / Lezioni)
   Scansione ricorsiva delle cartelle e download file
   ========================================================================== */

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1k77YG_N_xwMctML4d-aV2PfuyIY-ECKS';

interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType: string;
  size?: string;
  modified?: string;
  folders?: DriveItem[];
  files?: DriveItem[];
}

let driveCache: { [folderId: string]: { tree: DriveItem; timestamp: number } } = {};
const DRIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

/**
 * Pulisce i nomi dei file e delle cartelle rimuovendo i suffissi di accessibilità di Google Drive
 * (es. ".mp3 Audio Shared" -> ".mp3", "Cartella Shared folder" -> "Cartella")
 */
function cleanDriveItemName(raw: string, isFolder: boolean): string {
  if (!raw) return '';
  let name = raw.trim();
  if (isFolder) {
    return name.replace(/\s+(Shared folder|cartella condivisa|folder|cartella|shared|condiviso)$/i, '').trim();
  }
  // Se ha un'estensione nota seguita dai suffissi di accessibilità di Google Drive (es. '.mp3 Audio Shared')
  name = name.replace(/\.(mp3|m4a|wav|aac|flac|ogg|wma|mp4|mkv|pdf|zip|rar|7z)\b.*$/i, '.$1');
  // Rimuove eventuali suffissi di Google Drive rimasti
  name = name.replace(/\s+(Audio Shared|Audio Condiviso|Audio|Video Shared|Video Condiviso|Video|PDF Shared|PDF Condiviso|Document Shared|Document Condiviso|Shared|Condiviso)$/i, '').trim();
  return name;
}

/**
 * Esegue il parsing di una singola cartella pubblica di Google Drive
 */
async function parseDriveFolder(folderId: string): Promise<{ title: string; items: DriveItem[] }> {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (!response.ok) {
    throw new Error(`Google Drive ha risposto con HTTP ${response.status}`);
  }

  const text = await response.text();

  // Estrae il titolo della cartella dal tag <title>
  const titleMatch = text.match(/<title>([^<]+)<\/title>/);
  let title = titleMatch ? titleMatch[1].replace(/\s*[–-]\s*Google\s*Drive\s*$/i, '').trim() : 'Cartella';

  const items: DriveItem[] = [];
  const seenIds = new Set<string>();

  // Pattern 1: elementi aria-label con ID in attributo ssk
  const reSsk = /aria-label="([^"]+)"[^>]*ssk='5:[^:]*:([a-zA-Z0-9_-]+)-0-16'/g;
  let match: RegExpExecArray | null;
  while ((match = reSsk.exec(text)) !== null) {
    const rawLabel = match[1];
    const id = match[2];
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const isFolder = /folder|cartella/i.test(rawLabel);
    const cleanName = cleanDriveItemName(rawLabel, isFolder);
    const isAudio = /\.(mp3|m4a|wav|aac|ogg|flac|wma)$/i.test(cleanName) || /audio/i.test(rawLabel);
    items.push({
      id,
      name: cleanName,
      isFolder,
      mimeType: isFolder ? 'application/vnd.google-apps.folder' : (isAudio ? 'audio/mpeg' : 'application/octet-stream'),
    });
  }

  // Pattern 2: elementi memorizzati nel payload JSON embedded ds:3
  // Es: [[null,"ID"],null,null,null,"MIME_TYPE",... [[["NOME_FILE",null,1]]]]
  const reDs = /\[\[null,"([a-zA-Z0-9_-]{25,})"\],null,null,null,"([^"]+)",(?:(?!\[\[null,")[\s\S])*?\[\[\["([^"]+)"/g;
  while ((match = reDs.exec(text)) !== null) {
    const id = match[1];
    const mimeType = match[2];
    const name = match[3];
    if (!seenIds.has(id)) {
      seenIds.add(id);
      const isFolder = mimeType === 'application/vnd.google-apps.folder';
      const cleanName = cleanDriveItemName(name, isFolder);
      items.push({
        id,
        name: cleanName,
        isFolder,
        mimeType,
      });
    }
  }

  return { title, items };
}

/**
 * Scansione ricorsiva completa dell'albero di cartelle di Google Drive
 */
async function crawlDriveTree(folderId: string, depth = 0, maxDepth = 6, visited = new Set<string>()): Promise<DriveItem> {
  if (visited.has(folderId) || depth >= maxDepth) {
    return {
      id: folderId,
      name: 'Riferimento circolare o limite profondità',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [],
    };
  }
  visited.add(folderId);

  const parsed = await parseDriveFolder(folderId);
  const node: DriveItem = {
    id: folderId,
    name: parsed.title,
    isFolder: true,
    mimeType: 'application/vnd.google-apps.folder',
    folders: [],
    files: [],
  };

  for (const item of parsed.items) {
    if (item.isFolder) {
      try {
        const subNode = await crawlDriveTree(item.id, depth + 1, maxDepth, visited);
        subNode.name = item.name || subNode.name;
        node.folders!.push(subNode);
      } catch (subErr) {
        console.warn(`Errore scansione sottocartella ${item.name} (${item.id}):`, subErr);
        node.folders!.push({
          id: item.id,
          name: item.name,
          isFolder: true,
          mimeType: 'application/vnd.google-apps.folder',
          folders: [],
          files: [],
        });
      }
    } else {
      node.files!.push(item);
    }
  }

  // Ordina sottocartelle e file alfabeticamente/numericamente
  node.folders!.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  node.files!.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return node;
}

/**
 * GET /api/drive/tree
 * Restituisce l'albero gerarchico ricorsivo di Google Drive
 */
app.get('/api/drive/tree', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    const folderId = (req.query.folderId as string) || DEFAULT_DRIVE_FOLDER_ID;
    const isForce = req.query.force === 'true';

    const now = Date.now();
    const cached = driveCache[folderId];

    if (!isForce && cached && (now - cached.timestamp < DRIVE_CACHE_TTL_MS)) {
      res.json({
        cached: true,
        timestamp: cached.timestamp,
        folderId,
        tree: cached.tree,
      });
      return;
    }

    console.log(`[Drive] Avvio scansione ricorsiva per folder ID: ${folderId} (force=${isForce})`);
    const tree = await crawlDriveTree(folderId);

    driveCache[folderId] = {
      tree,
      timestamp: now,
    };

    res.json({
      cached: false,
      timestamp: now,
      folderId,
      tree,
    });
  } catch (err: any) {
    console.error('Errore /api/drive/tree:', err);
    res.status(500).json({ error: 'Errore durante la scansione di Google Drive', details: err.message });
  }
});

/**
 * GET /api/drive/download/:fileId
 * Proxy di streaming per il download di file (audio/video/dispense) da Google Drive
 */
app.get('/api/drive/download/:fileId', async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId;
    const requestedName = (req.query.name as string) || `registrazione_${fileId}.mp3`;
    let cleanFilename = cleanDriveItemName(requestedName, false);
    if (!/\.[a-zA-Z0-9]+$/.test(cleanFilename)) {
      cleanFilename += '.mp3';
    }

    if (!fileId) {
      res.status(400).json({ error: 'fileId mancante' });
      return;
    }

    const asciiFilename = cleanFilename.replace(/["\\]/g, '').replace(/[^\x20-\x7E]/g, '_');
    const utf8Filename = encodeURIComponent(cleanFilename);
    const contentDisposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`;

    const downloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download`;

    const driveRes = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });

    if (!driveRes.ok) {
      // Prova fallback su uc endpoint standard
      const fallbackUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`;
      const fallbackRes = await fetch(fallbackUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        redirect: 'follow',
      });

      if (!fallbackRes.ok) {
        res.status(fallbackRes.status).send(await fallbackRes.text());
        return;
      }

      const contentType = cleanFilename.endsWith('.mp3') 
        ? 'audio/mpeg' 
        : (fallbackRes.headers.get('content-type') || 'application/octet-stream');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', contentDisposition);

      if (fallbackRes.body) {
        Readable.fromWeb(fallbackRes.body as any).pipe(res);
      } else {
        const arrayBuffer = await fallbackRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
      }
      return;
    }

    const contentType = cleanFilename.endsWith('.mp3')
      ? 'audio/mpeg'
      : (driveRes.headers.get('content-type') || 'application/octet-stream');

    const contentLength = driveRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition);

    if (driveRes.body) {
      Readable.fromWeb(driveRes.body as any).pipe(res);
    } else {
      const arrayBuffer = await driveRes.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    }
  } catch (err: any) {
    console.error('Errore /api/drive/download:', err);
    res.status(500).json({ error: 'Errore download da Google Drive', details: err.message });
  }
});

/* ==========================================================================
   INTEGRAZIONE FILE STATICI & VITE
   ========================================================================== */

// Servizio diretto dei file statici con MIME type esatti per evitare trasformazioni Vite
app.get('/style.css', (_req: Request, res: Response) => {
  res.type('text/css').sendFile(path.resolve(__dirname, 'style.css'));
});
app.get('/config.js', (_req: Request, res: Response) => {
  res.type('application/javascript').sendFile(path.resolve(__dirname, 'config.js'));
});
app.get('/app.js', (_req: Request, res: Response) => {
  res.type('application/javascript').sendFile(path.resolve(__dirname, 'app.js'));
});
app.get('/sw.js', (_req: Request, res: Response) => {
  res.type('application/javascript').sendFile(path.resolve(__dirname, 'sw.js'));
});
app.get('/manifest.json', (_req: Request, res: Response) => {
  res.type('application/manifest+json').sendFile(path.resolve(__dirname, 'manifest.json'));
});
app.get('/icon.svg', (_req: Request, res: Response) => {
  res.type('image/svg+xml').sendFile(path.resolve(__dirname, 'icon.svg'));
});

async function startServer() {
  const isCloudRun = Boolean(process.env.K_SERVICE || process.env.K_REVISION);
  const isProduction = process.env.NODE_ENV === 'production' || isCloudRun;
  const portNumber = Number(PORT) || 3000;

  if (!isProduction) {
    try {
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          host: HOST,
          port: portNumber,
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (viteError) {
      console.warn('Vite dev server failed to start, falling back to static files:', viteError);
      app.use(express.static(path.resolve(__dirname, 'dist')));
      app.use(express.static(path.resolve(__dirname)));
    }
  } else {
    // Modalità produzione / Cloud Run: serve i file statici compilati in dist
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      const distIndex = path.resolve(__dirname, 'dist', 'index.html');
      if (fs.existsSync(distIndex)) {
        res.sendFile(distIndex);
      } else {
        res.sendFile(path.resolve(__dirname, 'index.html'));
      }
    });
  }

  app.listen(portNumber, HOST, () => {
    console.log(`Server Note PDF in ascolto su http://${HOST}:${portNumber} (Ambiente: ${isProduction ? 'Cloud Run / Produzione' : 'Sviluppo'})`);
  });
}

startServer();
