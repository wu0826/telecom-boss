import {
  columnOverlayChecks,
  tableOverlayChecks,
  tableOverlayStatements,
} from './constraint-overlays.mjs';

const EXPECTED_COUNTS = Object.freeze({ tables: 39, columns: 421, relations: 64 });
const SUPPORTED_TYPES = new Set([
  'BIGINT',
  'BOOLEAN',
  'CHAR',
  'DATE',
  'DATETIME',
  'DECIMAL',
  'ENUM',
  'INT',
  'TEXT',
  'TINYINT',
  'VARCHAR',
]);
const INTEGER_TYPES = new Set(['BIGINT', 'BOOLEAN', 'INT', 'TINYINT']);

export class SchemaCompilationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaCompilationError';
  }
}

function assertIdentifier(identifier, context) {
  if (typeof identifier !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(identifier)) {
    throw new SchemaCompilationError(`Invalid SQL identifier for ${context}: ${identifier}`);
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parsePositiveInteger(value, context) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw new SchemaCompilationError(`Invalid positive integer for ${context}: ${value}`);
  }
  return Number(value);
}

function parseDecimalDefinition(dataLength, context) {
  const match = /^(\d+)\s*,\s*(\d+)$/.exec(String(dataLength ?? ''));
  if (!match) {
    throw new SchemaCompilationError(`Invalid DECIMAL definition for ${context}: ${dataLength}`);
  }

  const precision = Number(match[1]);
  const scale = Number(match[2]);
  if (precision < 1 || scale < 0 || scale > precision || precision > 18) {
    throw new SchemaCompilationError(`Unsupported DECIMAL definition for ${context}: ${dataLength}`);
  }
  return { precision, scale };
}

export function scaleDecimalValue(value, scale, context = 'decimal value') {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new SchemaCompilationError(`Invalid DECIMAL default for ${context}: ${value}`);

  const fraction = match[3] ?? '';
  if (fraction.length > scale && /[^0]/.test(fraction.slice(scale))) {
    throw new SchemaCompilationError(`DECIMAL default exceeds scale for ${context}: ${value}`);
  }

  const scaledDigits = `${match[2]}${fraction.slice(0, scale).padEnd(scale, '0')}`;
  const scaled = BigInt(scaledDigits || '0') * (match[1] === '-' ? -1n : 1n);
  return scaled.toString();
}

function parseEnumValues(dataLength, context) {
  const values = [];
  const source = String(dataLength ?? '');
  const pattern = /'((?:''|[^'])*)'/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    values.push(match[1].replaceAll("''", "'"));
  }

  if (values.length === 0 || source.replace(pattern, '').replace(/[\s,]/g, '') !== '') {
    throw new SchemaCompilationError(`Invalid ENUM definition for ${context}: ${dataLength}`);
  }
  return values;
}

function sqliteType(column, context, decimalScaleByColumn) {
  if (!SUPPORTED_TYPES.has(column.data_type)) {
    throw new SchemaCompilationError(`Unsupported data type for ${context}: ${column.data_type}`);
  }
  if (column.data_type === 'DECIMAL') {
    const { scale } = parseDecimalDefinition(column.data_length, context);
    decimalScaleByColumn[context] = scale;
    return 'INTEGER';
  }
  if (INTEGER_TYPES.has(column.data_type)) return 'INTEGER';
  return 'TEXT';
}

function defaultSql(column, context, decimalScaleByColumn) {
  const value = column.default_val;
  if (value === null || value === '') return null;
  if (value === 'CURRENT_TIMESTAMP') {
    return `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
  }
  if (column.data_type === 'DECIMAL') {
    return scaleDecimalValue(value, decimalScaleByColumn[context], context);
  }
  if (INTEGER_TYPES.has(column.data_type)) {
    if (!/^-?\d+$/.test(String(value))) {
      throw new SchemaCompilationError(`Invalid integer default for ${context}: ${value}`);
    }
    return String(value);
  }
  return quoteLiteral(value);
}

function intrinsicChecks(column, context) {
  const name = quoteIdentifier(column.en_name);
  const nullablePrefix = column.is_nullable ? `${name} IS NULL OR ` : '';

  if (column.data_type === 'BOOLEAN') {
    return [`${nullablePrefix}${name} IN (0, 1)`];
  }
  if (column.data_type === 'ENUM') {
    const values = parseEnumValues(column.data_length, context).map(quoteLiteral).join(', ');
    return [`${nullablePrefix}${name} IN (${values})`];
  }
  if (column.data_type === 'VARCHAR') {
    const max = parsePositiveInteger(column.data_length, context);
    return [`${nullablePrefix}length(${name}) <= ${max}`];
  }
  if (column.data_type === 'CHAR') {
    const exact = parsePositiveInteger(column.data_length, context);
    return [`${nullablePrefix}length(${name}) = ${exact}`];
  }
  return [];
}

function validateAndIndexSnapshot(snapshot) {
  if (snapshot?.format !== 'yk-schema-db' || snapshot.database?.en_name !== 'telecom_boss') {
    throw new SchemaCompilationError('Snapshot must be a telecom_boss yk-schema-db document');
  }
  if (
    snapshot.tables?.length !== EXPECTED_COUNTS.tables
    || snapshot.columns?.length !== EXPECTED_COUNTS.columns
    || snapshot.relations?.length !== EXPECTED_COUNTS.relations
  ) {
    throw new SchemaCompilationError(
      `Snapshot counts must be ${EXPECTED_COUNTS.tables} tables, ${EXPECTED_COUNTS.columns} columns, and ${EXPECTED_COUNTS.relations} relations`,
    );
  }

  const tableById = new Map();
  const tableNames = new Set();
  for (const table of snapshot.tables) {
    assertIdentifier(table.en_name, `table ${table.id}`);
    if (tableById.has(table.id) || tableNames.has(table.en_name)) {
      throw new SchemaCompilationError(`Duplicate table identity: ${table.id}/${table.en_name}`);
    }
    tableById.set(table.id, table);
    tableNames.add(table.en_name);
  }

  const columnsByTableId = new Map(snapshot.tables.map(({ id }) => [id, []]));
  const columnByKey = new Map();
  for (const column of snapshot.columns) {
    const table = tableById.get(column.table_id);
    if (!table) throw new SchemaCompilationError(`Column ${column.id} references an unknown table`);
    assertIdentifier(column.en_name, `column ${table.en_name}.${column.id}`);
    const key = `${table.id}.${column.en_name}`;
    if (columnByKey.has(key)) throw new SchemaCompilationError(`Duplicate column: ${table.en_name}.${column.en_name}`);
    columnByKey.set(key, column);
    columnsByTableId.get(table.id).push(column);
  }

  for (const table of snapshot.tables) {
    const primaryKeys = columnsByTableId.get(table.id).filter(({ is_pk }) => is_pk);
    if (primaryKeys.length !== 1 || primaryKeys[0].data_type !== 'BIGINT') {
      throw new SchemaCompilationError(`${table.en_name} must have one BIGINT primary key`);
    }
  }

  const relationByChildKey = new Map();
  for (const relation of snapshot.relations) {
    const parentTable = tableById.get(relation.from_table_id);
    const childTable = tableById.get(relation.to_table_id);
    if (!parentTable || !childTable) throw new SchemaCompilationError(`Relation ${relation.id} references an unknown table`);
    assertIdentifier(relation.from_col, `relation ${relation.id} parent column`);
    assertIdentifier(relation.to_col, `relation ${relation.id} child column`);

    const parentColumn = columnByKey.get(`${parentTable.id}.${relation.from_col}`);
    const childColumn = columnByKey.get(`${childTable.id}.${relation.to_col}`);
    if (!parentColumn || !childColumn) throw new SchemaCompilationError(`Relation ${relation.id} references an unknown column`);
    if (!childColumn.is_fk) throw new SchemaCompilationError(`Relation ${relation.id} child column is not marked as a foreign key`);
    if (!parentColumn.is_pk && !parentColumn.is_unique) {
      throw new SchemaCompilationError(`Relation ${relation.id} parent column is not unique`);
    }

    const childKey = `${childTable.id}.${childColumn.en_name}`;
    if (relationByChildKey.has(childKey)) throw new SchemaCompilationError(`Duplicate relation for ${childTable.en_name}.${childColumn.en_name}`);
    relationByChildKey.set(childKey, { relation, parentTable, parentColumn, childTable, childColumn });
  }

  for (const column of snapshot.columns.filter(({ is_fk }) => is_fk)) {
    if (!relationByChildKey.has(`${column.table_id}.${column.en_name}`)) {
      const table = tableById.get(column.table_id);
      throw new SchemaCompilationError(`Missing relation for ${table.en_name}.${column.en_name}`);
    }
  }

  return { tableById, columnsByTableId, relationByChildKey };
}

function compileColumn(table, column, decimalScaleByColumn) {
  const context = `${table.en_name}.${column.en_name}`;
  const type = sqliteType(column, context, decimalScaleByColumn);
  const parts = [quoteIdentifier(column.en_name), type];

  if (column.is_pk) {
    parts.push('PRIMARY KEY AUTOINCREMENT');
  } else {
    if (!column.is_nullable) parts.push('NOT NULL');
    if (column.is_unique) parts.push('UNIQUE');
    const defaultValue = defaultSql(column, context, decimalScaleByColumn);
    if (defaultValue !== null) parts.push(`DEFAULT ${defaultValue}`);

    const checks = [
      ...intrinsicChecks(column, context),
      ...columnOverlayChecks(table.en_name, column.en_name),
    ];
    for (const check of checks) parts.push(`CHECK (${check})`);
  }

  return parts.join(' ');
}

function foreignKeyConstraint({ parentTable, parentColumn, childTable, childColumn }) {
  const policy = childColumn.is_nullable ? 'SET NULL' : 'RESTRICT';
  const name = `fk_${childTable.en_name}_${childColumn.en_name}`;
  return [
    `CONSTRAINT ${quoteIdentifier(name)}`,
    `FOREIGN KEY (${quoteIdentifier(childColumn.en_name)})`,
    `REFERENCES ${quoteIdentifier(parentTable.en_name)} (${quoteIdentifier(parentColumn.en_name)})`,
    `ON UPDATE RESTRICT ON DELETE ${policy}`,
  ].join(' ');
}

export function compileTelecomSchema(snapshot) {
  const { columnsByTableId, relationByChildKey } = validateAndIndexSnapshot(snapshot);
  const decimalScaleByColumn = {};
  const statements = [`
    CREATE TABLE "_schema_migrations" (
      "version" INTEGER PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "applied_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT
  `.trim()];

  for (const table of snapshot.tables) {
    const definitions = columnsByTableId
      .get(table.id)
      .map((column) => compileColumn(table, column, decimalScaleByColumn));

    for (const column of columnsByTableId.get(table.id)) {
      const relation = relationByChildKey.get(`${table.id}.${column.en_name}`);
      if (relation) definitions.push(foreignKeyConstraint(relation));
    }
    for (const check of tableOverlayChecks(table.en_name)) {
      definitions.push(`CHECK (${check})`);
    }

    statements.push(`CREATE TABLE ${quoteIdentifier(table.en_name)} (\n  ${definitions.join(',\n  ')}\n) STRICT`);

    for (const column of columnsByTableId.get(table.id)) {
      if (!column.is_index || column.is_unique) continue;
      const indexName = `idx_${table.en_name}_${column.en_name}`;
      statements.push(
        `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table.en_name)} (${quoteIdentifier(column.en_name)})`,
      );
    }
    statements.push(...tableOverlayStatements(table.en_name));
  }

  return {
    schemaSql: `${statements.join(';\n\n')};`,
    decimalScaleByColumn,
    tableCount: snapshot.tables.length,
    columnCount: snapshot.columns.length,
    relationCount: snapshot.relations.length,
  };
}
