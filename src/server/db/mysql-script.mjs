import { createHash } from 'node:crypto';

export class MysqlScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MysqlScriptError';
  }
}

export function sha256Text(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * Split a controlled MySQL migration script into executable statements.
 *
 * The project migration files use one delimiter directive per line and keep
 * statement terminators at the end of a line. This parser intentionally
 * supports that constrained format instead of trying to implement the full
 * mysql CLI grammar.
 */
export function splitMysqlScript(source) {
  if (typeof source !== 'string') {
    throw new MysqlScriptError('MySQL script source must be a string');
  }

  const statements = [];
  let delimiter = ';';
  let buffer = [];

  const executableText = () => buffer.join('\n')
    .replace(/^\s*--.*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
    .trim();

  const flush = () => {
    const statement = buffer.join('\n').trim();
    buffer = [];
    if (statement && statement.replace(/^\s*--.*$/gm, '').replace(/^\s*#.*$/gm, '').trim()) {
      statements.push(statement);
    }
  };

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    const delimiterMatch = /^DELIMITER\s+(\S+)$/i.exec(trimmed);
    if (delimiterMatch) {
      if (executableText()) {
        throw new MysqlScriptError('DELIMITER directive appeared before the previous statement ended');
      }
      buffer = [];
      delimiter = delimiterMatch[1];
      continue;
    }

    // Keep comments in the statement text. MySQL accepts them and they are
    // useful when a failed statement is logged without exposing credentials.
    buffer.push(rawLine);

    const rightTrimmed = rawLine.trimEnd();
    if (!rightTrimmed.endsWith(delimiter)) continue;

    const suffixIndex = buffer.length - 1;
    buffer[suffixIndex] = rightTrimmed.slice(0, -delimiter.length);
    flush();
  }

  if (executableText()) {
    throw new MysqlScriptError(`MySQL script ended before delimiter ${JSON.stringify(delimiter)}`);
  }

  return statements;
}

export function summarizeMysqlScript(source) {
  const statements = splitMysqlScript(source);
  return {
    sha256: sha256Text(source),
    statementCount: statements.length,
    createTableCount: statements.filter((sql) => /^\s*(?:--[^\n]*\n\s*)*CREATE\s+TABLE\b/i.test(sql)).length,
    createTriggerCount: statements.filter((sql) => /^\s*(?:--[^\n]*\n\s*)*CREATE\s+TRIGGER\b/i.test(sql)).length,
    dropTableCount: statements.filter((sql) => /^\s*(?:--[^\n]*\n\s*)*DROP\s+TABLE\b/i.test(sql)).length,
    dropTriggerCount: statements.filter((sql) => /^\s*(?:--[^\n]*\n\s*)*DROP\s+TRIGGER\b/i.test(sql)).length,
  };
}
