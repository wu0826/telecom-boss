import { openRuntimeDatabase } from '../../db/runtime-database.mjs';

const STAFF_SELECT = `
  SELECT id, staff_no, email, display_name, department, auth_provider, provider_subject, is_active
  FROM staff_users
`;

function databaseTimestamp(database, timestamp) {
  if (database?.kind !== 'mysql') return timestamp;

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError('Invalid authentication timestamp');
  }

  return parsed.toISOString().slice(0, 23).replace('T', ' ');
}

function applicationTimestamp(database, value) {
  if (value === null || value === undefined || value === '') return null;
  if (database?.kind !== 'mysql') return value;

  const text = String(value);

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(text)) {
    return `${text.replace(' ', 'T')}Z`;
  }

  return text;
}

function staffRecord(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    staffNo: row.staff_no,
    email: row.email,
    displayName: row.display_name,
    department: row.department,
    authProvider: row.auth_provider,
    providerSubject: row.provider_subject,
    isActive: row.is_active === 1,
  };
}

function passwordCandidate(row, database) {
  if (!row) return null;
  return {
    ...staffRecord(row),
    passwordHash: row.password_hash,
    failedAttempts: Number(row.failed_attempts ?? 0),
    firstFailedAt: applicationTimestamp(database, row.first_failed_at),
    lockedUntil: applicationTimestamp(database, row.locked_until),
    passwordChangedAt: applicationTimestamp(database, row.password_changed_at),
  };
}

export async function listDevelopmentStaff(databasePath) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return (await database.prepare(`
      ${STAFF_SELECT}
      WHERE is_active = 1
        AND auth_provider = 'OTHER'
        AND provider_subject LIKE 'dev:%'
      ORDER BY id
    `).all()).map(staffRecord);
  } finally {
    database.close();
  }
}

export async function findActiveStaff(databasePath, staffUserId, { developmentOnly = false } = {}) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    const developmentClause = developmentOnly
      ? "AND auth_provider = 'OTHER' AND provider_subject LIKE 'dev:%'"
      : '';
    return staffRecord(await database.prepare(`
      ${STAFF_SELECT}
      WHERE id = ? AND is_active = 1 ${developmentClause}
    `).get(staffUserId));
  } finally {
    database.close();
  }
}

export async function findPasswordLoginCandidate(databasePath, identifier) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return passwordCandidate(await database.prepare(`
      SELECT
        staff.id, staff.staff_no, staff.email, staff.display_name, staff.department,
        staff.auth_provider, staff.provider_subject, staff.is_active,
        credentials.password_hash, credentials.failed_attempts,
        credentials.first_failed_at, credentials.locked_until, credentials.password_changed_at
      FROM staff_users AS staff
      JOIN staff_password_credentials AS credentials
        ON credentials.staff_user_id = staff.id
      WHERE staff.is_active = 1
        AND (LOWER(staff.staff_no) = LOWER(?) OR LOWER(staff.email) = LOWER(?))
      LIMIT 1
    `).get(identifier, identifier), database);
  } finally {
    database.close();
  }
}

export async function findActiveStaffByIdentifier(databasePath, identifier) {
  const database = openRuntimeDatabase(databasePath, { readOnly: true });
  try {
    return staffRecord(await database.prepare(`
      ${STAFF_SELECT}
      WHERE is_active = 1
        AND (LOWER(staff_no) = LOWER(?) OR LOWER(email) = LOWER(?))
      LIMIT 1
    `).get(identifier, identifier));
  } finally {
    database.close();
  }
}

export async function recordSuccessfulLogin(databasePath, staffUserId, timestamp) {
  const database = openRuntimeDatabase(databasePath);
  try {
    const dbTimestamp = databaseTimestamp(database, timestamp);
    await database.prepare(`
      UPDATE staff_users
      SET last_login_at = ?, updated_at = ?
      WHERE id = ? AND is_active = 1
    `).run(dbTimestamp, dbTimestamp, staffUserId);
  } finally {
    database.close();
  }
}

export async function recordSuccessfulPasswordLogin(databasePath, staffUserId, timestamp) {
  const database = openRuntimeDatabase(databasePath);
  try {
    const dbTimestamp = databaseTimestamp(database, timestamp);
    await database.transaction(async () => {
      const staffResult = await database.prepare(`
        UPDATE staff_users
        SET last_login_at = ?, updated_at = ?
        WHERE id = ? AND is_active = 1
      `).run(dbTimestamp, dbTimestamp, staffUserId);
      if (Number(staffResult.changes) !== 1) throw new Error('Active staff account disappeared during login');
      const credentialResult = await database.prepare(`
        UPDATE staff_password_credentials
        SET failed_attempts = 0,
            first_failed_at = NULL,
            locked_until = NULL,
            updated_at = ?
        WHERE staff_user_id = ?
      `).run(dbTimestamp, staffUserId);
      if (Number(credentialResult.changes) !== 1) throw new Error('Password credential disappeared during login');
    });
  } finally {
    database.close();
  }
}

export async function recordFailedPasswordLogin(databasePath, staffUserId, timestamp, {
  threshold,
  observationWindowMs,
  lockDurationMs,
}) {
  const database = openRuntimeDatabase(databasePath);
  try {
    return await database.transaction(async () => {
      const row = await database.prepare(`
        SELECT failed_attempts, first_failed_at, locked_until
        FROM staff_password_credentials
        WHERE staff_user_id = ?
      `).get(staffUserId);
      if (!row) return { lockedUntil: null, attempts: 0 };

      const now = Date.parse(timestamp);
      const existingLockValue = applicationTimestamp(database, row.locked_until);
      const existingLock = existingLockValue ? Date.parse(existingLockValue) : NaN;
      if (Number.isFinite(existingLock) && existingLock > now) {
        return { lockedUntil: new Date(existingLock).toISOString(), attempts: Number(row.failed_attempts) };
      }

      const firstFailureValue = applicationTimestamp(database, row.first_failed_at);
      const firstFailure = firstFailureValue ? Date.parse(firstFailureValue) : NaN;
      const withinWindow = Number.isFinite(firstFailure) && now - firstFailure <= observationWindowMs;
      const firstFailedAt = withinWindow ? new Date(firstFailure).toISOString() : timestamp;
      const attempts = withinWindow ? Number(row.failed_attempts) + 1 : 1;
      const lockedUntil = attempts >= threshold
        ? new Date(now + lockDurationMs).toISOString()
        : null;

      await database.prepare(`
        UPDATE staff_password_credentials
        SET failed_attempts = ?, first_failed_at = ?, locked_until = ?, updated_at = ?
        WHERE staff_user_id = ?
      `).run(
        attempts,
        databaseTimestamp(database, firstFailedAt),
        lockedUntil ? databaseTimestamp(database, lockedUntil) : null,
        databaseTimestamp(database, timestamp),
        staffUserId,
      );
      return { lockedUntil, attempts };
    });
  } finally {
    database.close();
  }
}

export async function setPasswordCredential(databasePath, staffUserId, passwordHash, timestamp) {
  const database = openRuntimeDatabase(databasePath);
  try {
    const dbTimestamp = databaseTimestamp(database, timestamp);

    await database.transaction(async () => {
      const updated = await database.prepare(`
        UPDATE staff_password_credentials
        SET password_hash = ?, failed_attempts = 0, first_failed_at = NULL, locked_until = NULL,
            password_changed_at = ?, updated_at = ?
        WHERE staff_user_id = ?
      `).run(passwordHash, dbTimestamp, dbTimestamp, staffUserId);

      if (Number(updated.changes) === 1) return;

      await database.prepare(`
        INSERT INTO staff_password_credentials (
          staff_user_id, password_hash, failed_attempts, first_failed_at, locked_until,
          password_changed_at, created_at, updated_at
        ) VALUES (?, ?, 0, NULL, NULL, ?, ?, ?)
      `).run(
        staffUserId,
        passwordHash,
        dbTimestamp,
        dbTimestamp,
        dbTimestamp,
      );
    });
  } finally {
    database.close();
  }
}
