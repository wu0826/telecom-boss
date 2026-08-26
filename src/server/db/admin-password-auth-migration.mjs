export const ADMIN_PASSWORD_AUTH_MIGRATION = Object.freeze({
  version: 3,
  name: 'create_admin_password_auth',
  up(database) {
    database.exec(`
      CREATE TABLE staff_password_credentials (
        staff_user_id INTEGER PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL CHECK(length(password_hash) BETWEEN 60 AND 255),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
        first_failed_at TEXT,
        locked_until TEXT,
        password_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE INDEX idx_staff_password_credentials_locked_until
        ON staff_password_credentials(locked_until);
    `);
  },
  down(database) {
    database.exec('DROP TABLE IF EXISTS staff_password_credentials;');
  },
});
