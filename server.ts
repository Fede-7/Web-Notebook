import express from 'express';
import type { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

import fs from 'fs';

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
  const cfg = getEnvConfig();
  res.json({
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    rootPath: cfg.rootPath,
    excludeDirs: cfg.excludeDirs,
    hasToken: cfg.hasToken,
    serverMode: true,
  });
});

/**
 * GET /api/tree
 * Esegue la scansione dell'albero Git trees di GitHub iniettando il token .env
 * Supporta If-None-Match (ETag) per restituire 304 Not Modified se nulla è cambiato.
 */
app.get('/api/tree', async (req: Request, res: Response) => {
  try {
    const cfg = getEnvConfig();
    const queryOwner = (req.query.owner as string) || cfg.owner;
    const queryRepo = (req.query.repo as string) || cfg.repo;
    const queryBranch = (req.query.branch as string) || cfg.branch;

    const url = `https://api.github.com/repos/${encodeURIComponent(queryOwner)}/${encodeURIComponent(queryRepo)}/git/trees/${encodeURIComponent(queryBranch)}?recursive=1`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'NotePDF-Server-Proxy/1.0',
    };

    // Inietta il token segreto configurato in .env
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    // Inoltra l'ETag per consentire a GitHub di rispondere con 304
    const clientETag = req.headers['if-none-match'];
    if (clientETag) {
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
