import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const CONTRACT_PATH = resolve(import.meta.dirname, '..', '..', 'docs', 'api.openapi.json');

test('OpenAPI contract documents only the implemented public endpoints', async () => {
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'));

  assert.equal(contract.openapi, '3.1.0');
  assert.deepEqual(Object.keys(contract.paths), [
    '/health',
    '/catalog',
    '/catalog/products',
    '/catalog/products/{slug}',
    '/content',
    '/catalog/plans/{planId}',
    '/inquiries',
  ]);
  assert.ok(contract.paths['/inquiries'].post.parameters.some(
    ({ name, required }) => name === 'Idempotency-Key' && required,
  ));
  assert.equal(
    contract.components.schemas.InquiryRequest.additionalProperties,
    false,
  );
  assert.equal(contract.paths['/catalog/products'].get.operationId, 'getPublicCatalogV2Products');
  assert.equal(contract.paths['/catalog/products/{slug}'].get.operationId, 'getPublicCatalogV2Product');
  assert.doesNotMatch(JSON.stringify(contract.paths), /\/tables\/|\/dashboard|\/navigation/);
});
