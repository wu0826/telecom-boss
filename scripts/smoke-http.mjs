const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');

async function request(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'telecom-production-smoke/1.0' },
    redirect: 'manual',
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected HTTP ${expectedStatus}, got ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

const health = await request('/api/v1/health', 200);
const catalog = await request('/api/v1/catalog/products', 200);
const bootstrap = await request('/api/v1/admin/auth/bootstrap', 200);

if (health?.status !== 'ok') throw new Error('Health response status is not ok');
if (health?.databases?.metadata !== 'ok' || health?.databases?.telecom !== 'ok') {
  throw new Error('Health response does not report both databases as ok');
}
if (bootstrap?.data?.authenticated !== false) {
  throw new Error('Production unauthenticated Admin bootstrap must not create an implicit session');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  baseUrl,
  health: 'ok',
  catalogEndpoint: 'ok',
  productCount: Array.isArray(catalog?.products) ? catalog.products.length : null,
  adminBootstrap: 'unauthenticated-as-expected',
  productionAdminLogin: bootstrap?.data?.capabilities?.passwordLogin === true ? 'available-not-credential-tested' : 'missing',
}, null, 2)}\n`);
