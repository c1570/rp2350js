// Tiny static file server for the demo (no dependencies).
// Usage: node demo/web/server.mjs [port]  (default 8080, serves demo/web/public/)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = parseInt(process.argv[2] || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.hex': 'text/plain; charset=utf-8',
  '.dis': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) throw new Error('traversal');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`rp2350js web demo: http://localhost:${port}/`);
});
