import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoots = [
  'src/server/admin',
  'src/server/services',
  'src/server/http',
];

async function sourceFiles(relativeDirectory) {
  const absoluteDirectory = path.join(projectRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relativePath));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(relativePath);
  }
  return files;
}

test('runtime repositories and services no longer import SQLite directly', async () => {
  const files = [
    ...await Promise.all(runtimeRoots.map(sourceFiles)).then((groups) => groups.flat()),
    'src/server/main.mjs',
  ];
  const violations = [];
  for (const relativePath of files) {
    const source = await readFile(path.join(projectRoot, relativePath), 'utf8');
    if (/node:sqlite|db\/sqlite\.mjs|openSqliteDatabase/.test(source)) violations.push(relativePath);
  }
  assert.deepEqual(violations, []);
});

test('runtime SQL avoids SQLite-only write/query syntax outside the explicit SQLite health check', async () => {
  const files = [
    ...await Promise.all(runtimeRoots.map(sourceFiles)).then((groups) => groups.flat()),
    'src/server/main.mjs',
  ];
  const violations = [];
  const forbidden = /\bRETURNING\b|\bON\s+CONFLICT\b|\bINSERT\s+OR\b|strftime\s*\(|date\s*\(\s*['"]now['"]\s*\)/i;
  for (const relativePath of files) {
    const source = await readFile(path.join(projectRoot, relativePath), 'utf8');
    if (forbidden.test(source)) violations.push(relativePath);
  }
  assert.deepEqual(violations, []);

  const healthSource = await readFile(path.join(projectRoot, 'src/server/services/health-service.mjs'), 'utf8');
  assert.match(healthSource, /database\.kind === 'sqlite'/);
  assert.match(healthSource, /PRAGMA quick_check\(1\)/);
});
