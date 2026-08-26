import { HttpError } from './responses.mjs';

const BODY_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

export async function readJsonRequestBody(request, { limitBytes }) {
  if (!BODY_METHODS.has(request.method)) return null;

  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    request.resume();
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '請求內容超過大小限制');
  }

  const chunks = [];
  let receivedBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > limitBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '請求內容超過大小限制');
  if (receivedBytes === 0) return null;

  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '請使用 application/json');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'MALFORMED_JSON', 'JSON 格式不正確');
  }
}
