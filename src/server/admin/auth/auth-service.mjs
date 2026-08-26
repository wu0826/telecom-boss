import {
  findActiveStaff,
  findPasswordLoginCandidate,
  listDevelopmentStaff,
  recordFailedPasswordLogin,
  recordSuccessfulLogin,
  recordSuccessfulPasswordLogin,
} from './auth-repository.mjs';
import { fakeVerifyPassword, verifyPassword } from './password-hash.mjs';
import { getStaffAccess } from './permission-service.mjs';

export const SESSION_COOKIE_NAME = 'telecom_admin_session';
const SESSION_COOKIE_PATH = '/api/v1/admin';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_PASSWORD_POLICY = Object.freeze({
  threshold: 5,
  observationWindowMs: 15 * 60_000,
  lockDurationMs: 15 * 60_000,
});

export class AuthServiceError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AuthServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function safeUser(staff) {
  return {
    id: staff.id,
    staffNo: staff.staffNo,
    displayName: staff.displayName,
    department: staff.department,
  };
}

function developmentDisabled() {
  return new AuthServiceError(404, 'DEVELOPMENT_LOGIN_DISABLED', '開發登入未啟用');
}

function authenticationRequired(code = 'AUTHENTICATION_REQUIRED') {
  return new AuthServiceError(401, code, '帳號或密碼錯誤');
}

function passwordLoginPayload(payload) {
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  if (keys.length !== 2 || keys[0] !== 'identifier' || keys[1] !== 'password') {
    throw new AuthServiceError(422, 'VALIDATION_FAILED', '輸入資料不正確', [
      { field: 'identifier', message: '請輸入員工編號或公司信箱' },
      { field: 'password', message: '請輸入密碼' },
    ]);
  }
  const identifier = typeof payload.identifier === 'string' ? payload.identifier.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password.normalize('NFC') : '';
  if (!identifier || identifier.length > 191 || password.length < 1 || [...password].length > 128) {
    throw new AuthServiceError(422, 'VALIDATION_FAILED', '輸入資料不正確', [
      ...(!identifier || identifier.length > 191
        ? [{ field: 'identifier', message: '請輸入有效的員工編號或公司信箱' }]
        : []),
      ...(password.length < 1 || [...password].length > 128
        ? [{ field: 'password', message: '密碼格式不正確' }]
        : []),
    ]);
  }
  return { identifier, password };
}

export function readSessionToken(request) {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 4_096) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === SESSION_COOKIE_NAME && SESSION_TOKEN_PATTERN.test(value)) return value;
  }
  return null;
}

export function sessionCookie(token, idleTimeoutMs, { secure = false } = {}) {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new TypeError('Invalid session token');
  const maxAge = Math.max(1, Math.floor(idleTimeoutMs / 1_000));
  return `${SESSION_COOKIE_NAME}=${token}; Path=${SESSION_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE_NAME}=; Path=${SESSION_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function createAuthService({
  telecomDatabasePath,
  sessionStore,
  enableDevelopmentLogin,
  sessionIdleTimeoutMs,
  secureSessionCookie = false,
  passwordPolicy = DEFAULT_PASSWORD_POLICY,
  passwordHasher = { verifyPassword, fakeVerifyPassword },
  clock = Date.now,
}) {
  function assertDevelopmentEnabled() {
    if (!enableDevelopmentLogin) throw developmentDisabled();
  }

  function validateDevelopmentLoginPayload(payload) {
    const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (
      keys.length !== 1
      || keys[0] !== 'staffUserId'
      || !Number.isSafeInteger(payload.staffUserId)
      || payload.staffUserId < 1
    ) {
      throw new AuthServiceError(422, 'VALIDATION_FAILED', '輸入資料不正確', [
        { field: 'staffUserId', message: '請選擇有效的開發測試帳號' },
      ]);
    }
    return payload.staffUserId;
  }

  return {
    assertDevelopmentEnabled,
    validateDevelopmentLoginPayload,
    validatePasswordLoginPayload: passwordLoginPayload,
    capabilities() {
      return { passwordLogin: true, developmentLogin: enableDevelopmentLogin };
    },

    async listDevelopmentUsers() {
      assertDevelopmentEnabled();
      return (await listDevelopmentStaff(telecomDatabasePath)).map(safeUser);
    },

    async loginPasswordUser(identifier, password, previousToken) {
      const candidate = await findPasswordLoginCandidate(telecomDatabasePath, identifier);
      if (!candidate) {
        await passwordHasher.fakeVerifyPassword(password);
        throw authenticationRequired('AUTHENTICATION_FAILED');
      }

      const passwordMatches = await passwordHasher.verifyPassword(password, candidate.passwordHash);
      const now = clock();
      const timestamp = new Date(now).toISOString();
      const lockedUntil = candidate.lockedUntil ? Date.parse(candidate.lockedUntil) : NaN;
      const currentlyLocked = Number.isFinite(lockedUntil) && lockedUntil > now;

      if (!passwordMatches || currentlyLocked) {
        if (!currentlyLocked) {
          await recordFailedPasswordLogin(telecomDatabasePath, candidate.id, timestamp, passwordPolicy);
        }
        throw authenticationRequired('AUTHENTICATION_FAILED');
      }

      if (previousToken) sessionStore.destroy(previousToken);
      await recordSuccessfulPasswordLogin(telecomDatabasePath, candidate.id, timestamp);
      const session = sessionStore.create(candidate.id);
      return { ...session, user: safeUser(candidate) };
    },

    async loginDevelopmentUser(staffUserId, previousToken) {
      assertDevelopmentEnabled();
      const staff = await findActiveStaff(telecomDatabasePath, staffUserId, { developmentOnly: true });
      if (!staff) throw authenticationRequired('AUTHENTICATION_FAILED');
      if (previousToken) sessionStore.destroy(previousToken);
      const timestamp = new Date(clock()).toISOString();
      await recordSuccessfulLogin(telecomDatabasePath, staff.id, timestamp);
      const session = sessionStore.create(staff.id);
      return { ...session, user: safeUser(staff) };
    },

    async authenticate(token) {
      if (!token) throw new AuthServiceError(401, 'AUTHENTICATION_REQUIRED', '無法驗證後台工作階段');
      const session = sessionStore.get(token);
      if (!session) throw new AuthServiceError(401, 'AUTHENTICATION_REQUIRED', '無法驗證後台工作階段');
      const staff = await findActiveStaff(telecomDatabasePath, session.userId);
      if (!staff) {
        sessionStore.destroy(token);
        throw new AuthServiceError(401, 'AUTHENTICATION_REQUIRED', '無法驗證後台工作階段');
      }
      const access = await getStaffAccess(telecomDatabasePath, staff.id);
      return {
        user: safeUser(staff),
        roles: access.roles,
        permissions: access.permissions,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    },

    async logout(token) {
      await this.authenticate(token);
      sessionStore.destroy(token);
    },

    async revokeUserSessions(staffUserId) {
      return sessionStore.destroyForUser(staffUserId);
    },

    async sessionCookie(token) {
      return sessionCookie(token, sessionIdleTimeoutMs, { secure: secureSessionCookie });
    },

    clearedSessionCookie() {
      return clearedSessionCookie({ secure: secureSessionCookie });
    },
  };
}
