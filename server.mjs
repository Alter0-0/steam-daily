import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(root, 'outputs');
const dataDir = path.join(root, 'data');
const port = Number(process.env.PORT || 4173);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/status') {
    const status = await readJson(path.join(dataDir, 'status.json'), { state: 'never-run', message: '尚未运行采集器' });
    return send(res, 200, status);
  }
  if (url.pathname === '/api/reports') {
    const state = await readJson(path.join(dataDir, 'state.json'), { reports: [], generatedAt: null });
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days') || 7)));
    return send(res, 200, { ...state, reports: (state.reports || []).slice(0, days) });
  }
  const requested = url.pathname === '/' ? '/steam-daily.html' : url.pathname;
  const file = path.resolve(outputDir, `.${requested}`);
  if (!file.startsWith(path.resolve(outputDir))) return send(res, 403, { error: 'forbidden' });
  try { return send(res, 200, await fs.readFile(file), mime[path.extname(file)] || 'application/octet-stream'); }
  catch { return send(res, 404, { error: 'not_found' }); }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Open http://127.0.0.1:${port}/steam-daily.html instead.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Steam Daily running at http://127.0.0.1:${port}/steam-daily.html`));
