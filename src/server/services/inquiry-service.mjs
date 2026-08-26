import { createHash, createHmac } from 'node:crypto';

import { openRuntimeDatabase, runInTransaction } from '../db/runtime-database.mjs';

const ALLOWED_FIELDS = new Set([
  'address',
  'company',
  'consent',
  'email',
  'name',
  'phone',
  'planId',
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{8,30}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export class InquiryServiceError extends Error {
  constructor(code, message, { details = [] } = {}) {
    super(message);
    this.name = 'InquiryServiceError';
    this.code = code;
    this.details = details;
  }
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validationDetail(field, message) {
  return { field, message };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InquiryServiceError('VALIDATION_FAILED', '申裝資料驗證失敗', {
      details: [validationDetail('body', '請提供 JSON 物件')],
    });
  }

  const details = Object.keys(payload)
    .filter((field) => !ALLOWED_FIELDS.has(field))
    .map((field) => validationDetail(field, '不接受此欄位'));
  const name = textValue(payload.name);
  const phone = textValue(payload.phone);
  const email = textValue(payload.email).toLowerCase();
  const address = textValue(payload.address);

  if (name.length < 2 || name.length > 150) {
    details.push(validationDetail('name', '姓名須為 2 至 150 個字元'));
  }
  if (phone && !PHONE_PATTERN.test(phone)) {
    details.push(validationDetail('phone', '電話格式不正確'));
  }
  if (email && (email.length > 191 || !EMAIL_PATTERN.test(email))) {
    details.push(validationDetail('email', '電子郵件格式不正確'));
  }
  if (!phone && !email) {
    details.push(validationDetail('contact', '電話與電子郵件至少填寫一項'));
  }
  if (!Number.isSafeInteger(payload.planId) || payload.planId < 1) {
    details.push(validationDetail('planId', '請選擇有效方案'));
  }
  if (address.length < 6 || address.length > 255) {
    details.push(validationDetail('address', '地址須為 6 至 255 個字元'));
  }
  if (payload.consent !== true) {
    details.push(validationDetail('consent', '須同意聯絡與資料使用說明'));
  }
  if (textValue(payload.company)) {
    details.push(validationDetail('company', '欄位內容不正確'));
  }

  if (details.length > 0) {
    throw new InquiryServiceError('VALIDATION_FAILED', '申裝資料驗證失敗', { details });
  }

  return {
    planId: payload.planId,
    name,
    phone: phone || null,
    email: email || null,
    address,
  };
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function publicResult(row, duplicate) {
  return {
    inquiryNo: row.inquiry_no,
    status: row.status,
    createdAt: row.created_at,
    duplicate,
  };
}

export async function createPublicInquiry({ telecomDatabasePath, payload, idempotencyKey, clock = Date.now }) {
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new InquiryServiceError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 格式不正確');
  }

  const inquiry = validatePayload(payload);
  const inquiryNo = `WEB-${digest(idempotencyKey).slice(0, 24).toUpperCase()}`;
  const payloadHash = createHmac('sha256', idempotencyKey)
    .update(JSON.stringify(inquiry), 'utf8')
    .digest('hex');
  const internalNote = `PUBLIC_WEB_V1:${payloadHash}`;
  const database = openRuntimeDatabase(telecomDatabasePath);
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new Error('Inquiry clock must return a valid timestamp');
  const today = now.toISOString().slice(0, 10);

  return runInTransaction(database, async () => {
      const existing = await database.prepare(`
        SELECT inquiry_no, status, created_at, notes
        FROM service_inquiries
        WHERE inquiry_no = ?
      `).get(inquiryNo);
      if (existing) {
        if (existing.notes !== internalNote) {
          throw new InquiryServiceError(
            'IDEMPOTENCY_CONFLICT',
            '相同 Idempotency-Key 已用於不同申裝資料',
          );
        }
        return publicResult(existing, true);
      }

      const plan = await database.prepare(`
        SELECT id
        FROM service_plans
        WHERE id = ?
          AND is_active = 1
          AND (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to IS NULL OR effective_to >= ?)
      `).get(inquiry.planId, today, today);
      if (!plan) {
        throw new InquiryServiceError('VALIDATION_FAILED', '申裝資料驗證失敗', {
          details: [validationDetail('planId', '方案不存在或目前未開放申裝')],
        });
      }

      await database.prepare(`
        INSERT INTO service_inquiries (
          inquiry_no,
          prospect_name,
          phone,
          email,
          requested_plan_id,
          address_text,
          channel,
          status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, 'WEB', 'NEW', ?)
      `).run(
        inquiryNo,
        inquiry.name,
        inquiry.phone,
        inquiry.email,
        inquiry.planId,
        inquiry.address,
        internalNote,
      );

      const created = await database.prepare(`
        SELECT inquiry_no, status, created_at
        FROM service_inquiries
        WHERE inquiry_no = ?
      `).get(inquiryNo);
      return publicResult(created, false);
  });
}
