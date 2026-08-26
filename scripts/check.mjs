import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const EXPECTED_SNAPSHOTS = {
  website: {
    fileName: 'website_db.schema.json',
    databaseName: 'website_db',
    counts: { groups: 6, tables: 12, columns: 106, relations: 0, sampleRows: 7 },
  },
  telecom: {
    fileName: 'telecom_boss.schema.json',
    databaseName: 'telecom_boss',
    counts: { groups: 8, tables: 39, columns: 421, relations: 64, sampleRows: 24 },
  },
};

export class ProjectCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectCheckError';
  }
}

async function readJson(path, label) {
  let source;

  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ProjectCheckError(`${label} is missing or unreadable: ${path} (${error.code ?? 'UNKNOWN'})`);
  }

  try {
    return JSON.parse(source);
  } catch {
    throw new ProjectCheckError(`${label} is not valid UTF-8 JSON: ${path}`);
  }
}

function countSnapshot(document) {
  return {
    groups: Array.isArray(document.groups) ? document.groups.length : -1,
    tables: Array.isArray(document.tables) ? document.tables.length : -1,
    columns: Array.isArray(document.columns) ? document.columns.length : -1,
    relations: Array.isArray(document.relations) ? document.relations.length : -1,
    sampleRows: Array.isArray(document.sample_data) ? document.sample_data.length : -1,
  };
}

function assertSnapshot(document, expected, label) {
  if (document.format !== 'yk-schema-db') {
    throw new ProjectCheckError(`${label} has unsupported format: ${document.format ?? 'missing'}`);
  }

  if (document.database?.en_name !== expected.databaseName) {
    throw new ProjectCheckError(
      `${label} database name must be ${expected.databaseName}; received ${document.database?.en_name ?? 'missing'}`,
    );
  }

  const counts = countSnapshot(document);
  for (const [key, expectedCount] of Object.entries(expected.counts)) {
    if (counts[key] !== expectedCount) {
      throw new ProjectCheckError(
        `${label} ${key} count must be ${expectedCount}; received ${counts[key]}`,
      );
    }
  }

  return counts;
}

const APPROVED_RUNTIME_DEPENDENCIES = Object.freeze({ mysql2: '3.23.2' });

function validateThirdPartyDependencies(packageDocument) {
  const dependencies = packageDocument.dependencies ?? {};
  const unexpected = Object.keys(dependencies).filter((name) => !(name in APPROVED_RUNTIME_DEPENDENCIES));
  const devDependencies = Object.keys(packageDocument.devDependencies ?? {});
  const optionalDependencies = Object.keys(packageDocument.optionalDependencies ?? {});
  if (unexpected.length || devDependencies.length || optionalDependencies.length) {
    throw new ProjectCheckError(
      `Project contains unapproved third-party dependencies: ${[...unexpected, ...devDependencies, ...optionalDependencies].join(', ')}`,
    );
  }
  for (const [name, version] of Object.entries(APPROVED_RUNTIME_DEPENDENCIES)) {
    if (dependencies[name] !== version) {
      throw new ProjectCheckError(`${name} dependency must be pinned to ${version}`);
    }
  }
  return Object.keys(dependencies).length;
}

export async function validateProject(rootDir) {
  const packageDocument = await readJson(join(rootDir, 'package.json'), 'package.json');
  const thirdPartyDependencyCount = validateThirdPartyDependencies(packageDocument);

  const reports = {};
  for (const [key, expected] of Object.entries(EXPECTED_SNAPSHOTS)) {
    const path = join(rootDir, 'database', 'snapshots', expected.fileName);
    const document = await readJson(path, expected.fileName);
    reports[key] = assertSnapshot(document, expected, expected.fileName);
  }

  return {
    isValid: true,
    thirdPartyDependencyCount,
    ...reports,
  };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  try {
    const report = await validateProject(projectRoot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown project check error';
    process.stderr.write(`Project check failed: ${message}\n`);
    process.exitCode = 1;
  }
}
