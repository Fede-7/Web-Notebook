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

/* ==========================================================================
   GOOGLE DRIVE INTEGRATION (Cartella Radice Condivisa -> Sottocartelle & File)
   Scansione ricorsiva con metadati reali (data modifica, dimensione) e
   rinomina automatica dei PDF "main" con il nome della cartella genitore.
   ========================================================================== */

const DEFAULT_DRIVE_FOLDER_ID =
  (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim() || '1k77YG_N_xwMctML4d-aV2PfuyIY-ECKS';

interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType: string;
  size?: string;
  sizeBytes?: number;
  modified?: string;
  modifiedMs?: number;
  folders?: DriveItem[];
  files?: DriveItem[];
}

const driveCache: { [folderId: string]: { tree: DriveItem; timestamp: number; refreshing?: boolean } } = {};
const DRIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuti

/**
 * Decodifica le entità HTML e le sequenze unicode restituite da Google Drive
 */
function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Pulisce i nomi dei file e delle cartelle rimuovendo entità HTML e suffissi di accessibilità di Google Drive
 */
function cleanDriveItemName(raw: string, isFolder: boolean): string {
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
 * (es. "main-A4.pdf" dentro "Tecnologie Web" -> "Tecnologie Web-A4.pdf")
 */
function applyParentFolderNameToPdf(fileName: string, parentFolderName?: string): string {
  if (!fileName || !parentFolderName) return fileName;
  const cleanParent = cleanDriveItemName(parentFolderName, true);
  if (!cleanParent || !/\.pdf$/i.test(fileName)) return fileName;
  return fileName.replace(/(^|[-_. ()[\]])main(?=$|[-_. ()[\]])/i, (_match, prefix) => `${prefix}${cleanParent}`);
}

/**
 * Formatta una dimensione in byte in formato leggibile (KB / MB / GB)
 */
function formatBytes(bytes: number | null | undefined): string | undefined {
  if (bytes === null || bytes === undefined || isNaN(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Determina il Content-Type accurato in base all'estensione del file
 */
function inferMimeType(filename: string, fallback = 'application/octet-stream'): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  return fallback;
}

/**
 * Esegue il parsing di una singola cartella pubblica condivisa su Google Drive
 * estraendo anche timestamp esatti di modifica (modifiedMs) e dimensioni in byte
 */
async function parseDriveFolder(folderId: string): Promise<{ title: string; items: DriveItem[] }> {
  const url = `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  if (!response.ok) {
    throw new Error(`Google Drive ha risposto con HTTP ${response.status}`);
  }

  const text = await response.text();

  const titleMatch = text.match(/<title>([^<]+)<\/title>/);
  const rawTitle = titleMatch
    ? titleMatch[1].replace(/\s*[–-]\s*Google\s*Drive\s*$/i, '').trim()
    : 'Archivio Drive';
  const title = cleanDriveItemName(rawTitle, true);

  const itemsMap = new Map<string, DriveItem>();

  // Pattern 0 (Primario ad alta precisione): payload _initData con nome esatto, MIME, timestamp ms e dimensione byte
  const unescaped = text
    .replace(/\\x22/g, '"')
    .replace(/\\x5b/g, '[')
    .replace(/\\x5d/g, ']')
    .replace(/\\\//g, '/');

  const reInitData =
    /"([a-zA-Z0-9_-]{25,})",\["([a-zA-Z0-9_-]+)"\],"([^"]+)","([^"]+)",[0-9]+,null,[0-9]+,[0-9]+,[0-9]+,([0-9]{10,15}),([0-9]{10,15}),null,null,([0-9]+|null)/g;

  let match: RegExpExecArray | null;
  while ((match = reInitData.exec(unescaped)) !== null) {
    const id = match[1];
    const parentId = match[2];
    if (parentId !== folderId) continue;

    const rawName = match[3];
    const mimeType = match[4];
    const modifiedMs = Number(match[6]);
    const sizeBytes = match[7] !== 'null' ? Number(match[7]) : undefined;

    const isFolder = mimeType === 'application/vnd.google-apps.folder';
    const cleanName = cleanDriveItemName(rawName, isFolder);

    itemsMap.set(id, {
      id,
      name: cleanName,
      isFolder,
      mimeType: isFolder ? mimeType : inferMimeType(cleanName, mimeType),
      modifiedMs: !isNaN(modifiedMs) ? modifiedMs : undefined,
      modified: !isNaN(modifiedMs) ? new Date(modifiedMs).toISOString() : undefined,
      sizeBytes,
      size: isFolder ? undefined : formatBytes(sizeBytes),
    });
  }

  // Pattern 1 (Fallback HTML aria-label + ssk)
  const reSsk = /aria-label="([^"]+)"[^>]*ssk='5:[^:]*:([a-zA-Z0-9_-]+)-0-16'/g;
  while ((match = reSsk.exec(text)) !== null) {
    const rawLabel = match[1];
    const id = match[2];
    if (itemsMap.has(id)) continue;

    const isFolder = /folder|cartella/i.test(rawLabel) && !/\.(pdf|mp3|mp4|m4a|wav|mkv|zip)\b/i.test(rawLabel);
    const cleanName = cleanDriveItemName(rawLabel, isFolder);
    itemsMap.set(id, {
      id,
      name: cleanName,
      isFolder,
      mimeType: isFolder ? 'application/vnd.google-apps.folder' : inferMimeType(cleanName),
    });
  }

  // Pattern 2 (Fallback JSON ds)
  const reDs = /\[\[null,"([a-zA-Z0-9_-]{25,})"\],null,null,null,"([^"]+)",(?:(?!\[\[null,")[\s\S])*?\[\[\["([^"]+)"/g;
  while ((match = reDs.exec(text)) !== null) {
    const id = match[1];
    const mimeType = match[2];
    const rawName = match[3];
    if (!itemsMap.has(id)) {
      const isFolder = mimeType === 'application/vnd.google-apps.folder';
      const cleanName = cleanDriveItemName(rawName, isFolder);
      itemsMap.set(id, {
        id,
        name: cleanName,
        isFolder,
        mimeType: isFolder ? mimeType : inferMimeType(cleanName, mimeType),
      });
    }
  }

  return { title, items: Array.from(itemsMap.values()) };
}

/**
 * Confronta due file in ordine decrescente (il più recente sempre in cima, indipendentemente dalla cartella)
 */
function compareItemsDescending(a: DriveItem, b: DriveItem): number {
  const nameA = a.name || '';
  const nameB = b.name || '';

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

  if (typeof a.modifiedMs === 'number' && typeof b.modifiedMs === 'number' && a.modifiedMs !== b.modifiedMs) {
    return b.modifiedMs - a.modifiedMs;
  }

  if (matchA && !matchB) return -1;
  if (!matchA && matchB) return 1;

  if (a.modified && b.modified && a.modified !== b.modified) {
    const timeA = new Date(a.modified).getTime();
    const timeB = new Date(b.modified).getTime();
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeB - timeA;
    }
  }

  return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Esegue promesse con limite di concorrenza per evitare rate-limiting su Google Drive
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx]);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

/**
 * Scansione ricorsiva completa dell'albero di cartelle di Google Drive
 */
async function crawlDriveTree(
  folderId: string,
  depth = 0,
  maxDepth = 6,
  visited = new Set<string>(),
  explicitFolderName?: string
): Promise<DriveItem> {
  if (visited.has(folderId) || depth >= maxDepth) {
    return {
      id: folderId,
      name: explicitFolderName || 'Cartella',
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      folders: [],
      files: [],
    };
  }
  visited.add(folderId);

  const parsed = await parseDriveFolder(folderId);
  const folderName = explicitFolderName || parsed.title;

  const node: DriveItem = {
    id: folderId,
    name: folderName,
    isFolder: true,
    mimeType: 'application/vnd.google-apps.folder',
    folders: [],
    files: [],
  };

  const folderItems = parsed.items.filter((i) => i.isFolder);
  const fileItems = parsed.items.filter((i) => !i.isFolder);

  // Applica la sostituzione "main" -> nome cartella genitore sui file PDF
  node.files = fileItems.map((file) => ({
    ...file,
    name: applyParentFolderNameToPdf(file.name, folderName),
  }));

  const subResults = await mapWithConcurrency(folderItems, 4, async (item) => {
    try {
      const subNode = await crawlDriveTree(item.id, depth + 1, maxDepth, visited, item.name);
      subNode.name = item.name || subNode.name;
      return subNode;
    } catch (subErr) {
      console.warn(`Errore scansione sottocartella ${item.name} (${item.id}):`, subErr);
      return {
        id: item.id,
        name: item.name,
        isFolder: true,
        mimeType: 'application/vnd.google-apps.folder',
        folders: [],
        files: [],
      } as DriveItem;
    }
  });

  node.folders = subResults;
  node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  node.files.sort((a, b) => compareItemsDescending(a, b));

  return node;
}

/* ==========================================================================
   ENDPOINT API SERVER-SIDE
   ========================================================================== */

app.get('/api/config', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({
    driveFolderId: DEFAULT_DRIVE_FOLDER_ID,
    serverMode: true,
  });
});

app.get('/api/drive/tree', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    const folderId = ((req.query.folderId as string) || '').trim() || DEFAULT_DRIVE_FOLDER_ID;
    const isForce = req.query.force === 'true';

    const now = Date.now();
    const cached = driveCache[folderId];

    // Strategia Stale-While-Revalidate: risposta istantanea dalla cache e refresh in background se scaduta
    if (!isForce && cached) {
      const isStale = now - cached.timestamp >= DRIVE_CACHE_TTL_MS;
      if (isStale && !cached.refreshing) {
        cached.refreshing = true;
        crawlDriveTree(folderId)
          .then((freshTree) => {
            driveCache[folderId] = { tree: freshTree, timestamp: Date.now(), refreshing: false };
          })
          .catch((bgErr) => {
            console.warn('[Drive] Errore aggiornamento background:', bgErr);
            if (driveCache[folderId]) driveCache[folderId].refreshing = false;
          });
      }

      res.json({
        cached: true,
        timestamp: cached.timestamp,
        folderId,
        tree: cached.tree,
      });
      return;
    }

    console.log(`[Drive] Scansione cartella radice: ${folderId} (force=${isForce})`);
    const tree = await crawlDriveTree(folderId);

    driveCache[folderId] = {
      tree,
      timestamp: now,
      refreshing: false,
    };

    res.json({
      cached: false,
      timestamp: now,
      folderId,
      tree,
    });
  } catch (err: any) {
    console.error('Errore /api/drive/tree:', err);
    res.status(500).json({
      error: 'Errore durante la scansione di Google Drive',
      details: err.message,
    });
  }
});

app.get('/api/drive/download/:fileId', async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId;
    if (!fileId) {
      res.status(400).json({ error: 'fileId mancante' });
      return;
    }

    const requestedName = (req.query.name as string) || `file_${fileId}`;
    const isInline = req.query.inline === '1' || req.query.inline === 'true';

    let cleanFilename = cleanDriveItemName(requestedName, false);
    if (!/\.[a-zA-Z0-9]+$/.test(cleanFilename)) {
      cleanFilename += '.pdf';
    }

    const asciiFilename = cleanFilename.replace(/["\\]/g, '').replace(/[^\x20-\x7E]/g, '_');
    const utf8Filename = encodeURIComponent(cleanFilename);
    const dispositionType = isInline ? 'inline' : 'attachment';
    const contentDisposition = `${dispositionType}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`;

    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const downloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

    let driveRes = await fetch(downloadUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    if (!driveRes.ok) {
      const fallbackUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`;
      driveRes = await fetch(fallbackUrl, {
        headers: upstreamHeaders,
        redirect: 'follow',
      });

      if (!driveRes.ok) {
        res.status(driveRes.status).send(await driveRes.text());
        return;
      }
    }

    const contentType = inferMimeType(
      cleanFilename,
      driveRes.headers.get('content-type') || 'application/octet-stream'
    );

    if (driveRes.status === 206) {
      res.status(206);
      const contentRange = driveRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
    }

    const acceptRanges = driveRes.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

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
    console.log(
      `Server Fede's Notes in ascolto su http://${HOST}:${portNumber} (Ambiente: ${
        isProduction ? 'Produzione' : 'Sviluppo'
      })`
    );
  });
}

startServer();
