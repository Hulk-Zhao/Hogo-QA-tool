/**
 * serve.mjs —— 零依赖本地静态服务器（Hogo-QA-tool）。
 *
 * 目的：`file://` 协议下 Chrome 会阻止 IndexedDB，导致「项目库」无法持久化。
 *       通过 `http://127.0.0.1:<port>` 访问即可获得完整能力。
 *
 * 只依赖 Node 内置模块，无需 npm install。
 *
 * 用法：`node scripts/serve.mjs [端口]`（默认 8787）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist-server', import.meta.url)));
const PORT = Number(process.argv[2] || 8787);
const HOST = '127.0.0.1';

/** 扩展名 → Content-Type。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 把请求路径解析为磁盘上的绝对路径，并阻止目录穿越。
 *
 * @param {string} urlPath 请求路径
 * @returns {string} 安全的绝对路径
 */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = resolve(join(ROOT, rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) {
    throw new Error('路径越界');
  }
  return abs;
}

const server = createServer(async (req, res) => {
  try {
    let target = safeResolve(req.url || '/');

    let info = null;
    try {
      info = await stat(target);
    } catch {
      info = null;
    }

    // 目录或未命中 → 回退到 index.html（SPA 路由需要）
    if (!info || info.isDirectory()) {
      target = join(ROOT, 'index.html');
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未找到资源：' + String(err && err.message ? err.message : err));
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。请换一个端口，例如：node scripts/serve.mjs 8899\n`);
  } else {
    console.error('\n服务器启动失败：', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log('');
  console.log('  Hogo-QA-tool 已启动');
  console.log('  ' + url);
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});
