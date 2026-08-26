import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import { applySecurityHeaders, HttpError } from './responses.mjs';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.jpg','image/jpeg'],
  ['.jpeg','image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function notFound() {
  return new HttpError(404, 'NOT_FOUND', '找不到要求的資源');
}

export async function serveStaticFile({ request, response, pathname, webRoot, requestId }) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此端點不支援該 HTTP 方法', {
      headers: { Allow: 'GET, HEAD' },
    });
  }

  let decodedPath;
  try {
    const entryPath = pathname === '/'
      ? '/index.html'
      : pathname === '/admin' || pathname === '/admin/'
        ? '/admin/index.html'
        : pathname;
    decodedPath = decodeURIComponent(entryPath);
  } catch {
    throw notFound();
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) throw notFound();

  const relativeRequestPath = decodedPath.replace(/^\/+/, '');
  if (relativeRequestPath.split('/').includes('..')) throw notFound();
  const rootPath = resolve(webRoot);
  const targetPath = resolve(rootPath, relativeRequestPath);
  const targetRelativePath = relative(rootPath, targetPath);
  if (targetRelativePath.startsWith('..') || isAbsolute(targetRelativePath)) throw notFound();

  const extension = extname(targetPath).toLowerCase();
  const contentType = CONTENT_TYPES.get(extension);
  if (!contentType) throw notFound();

  let fileStats;
  let resolvedTargetPath;
  try {
    [fileStats, resolvedTargetPath] = await Promise.all([stat(targetPath), realpath(targetPath)]);
  } catch {
    throw notFound();
  }
  if (!fileStats.isFile()) throw notFound();

  const realRootPath = await realpath(rootPath);
  const realRelativePath = relative(realRootPath, resolvedTargetPath);
  if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) throw notFound();

  const body = await readFile(resolvedTargetPath);
  applySecurityHeaders(response, requestId);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', body.length);
  response.setHeader(
    'Cache-Control',
    extension === '.html' ? 'no-store' : 'public, max-age=3600',
  );
  response.setHeader('Last-Modified', fileStats.mtime.toUTCString());
  response.end(request.method === 'HEAD' ? undefined : body);
}
