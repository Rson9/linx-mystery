import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalKey, serviceProof, validServiceProof, authenticateLocalService, NONCE_HEADER, PROOF_HEADER } from '../src/local-service-auth.js';
test('本机认证密钥持久化且仅属主可读，证明绑定角色、端口与随机挑战', t => {
  const home = mkdtempSync(join(tmpdir(), 'misheng-local-key-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const key = loadLocalKey(home), nonce = 'a'.repeat(64); assert.equal(loadLocalKey(home), key);
  assert.equal(statSync(join(home, '.local/desktop-server.key')).mode & 0o777, 0o600);
  const proof = serviceProof(key, 'pet', 3212, nonce); assert.equal(validServiceProof(key, 'pet', 3212, nonce, proof), true);
  for (const args of [[key, 'engine', 3212, nonce], [key, 'pet', 3213, nonce], [key, 'pet', 3212, 'c'.repeat(64)], ['d'.repeat(64), 'pet', 3212, nonce]]) assert.equal(validServiceProof(...args, proof), false);
  assert.equal(validServiceProof(key, 'pet', 3212, nonce, 'not a proof'), false);
});
test('本机健康标识不能代替身份认证，端口冒用与不匹配的证明被拒绝', async () => {
  const key = 'e'.repeat(64);
  assert.equal(await authenticateLocalService('http://127.0.0.1:3212', 'pet', key, async () => new Response('{"service":"misheng-pet"}')), false);
  assert.equal(await authenticateLocalService('http://127.0.0.1:3212', 'pet', key, async (_url, options) => new Response('{}', { headers: { [PROOF_HEADER]: serviceProof(key, 'pet', 3212, options.headers[NONCE_HEADER]) } })), true);
  assert.equal(await authenticateLocalService('http://127.0.0.1:3212', 'pet', key, async (_url, options) => new Response('{}', { headers: { [PROOF_HEADER]: serviceProof(key, 'pet', 3213, options.headers[NONCE_HEADER]) } })), false);
  await assert.rejects(authenticateLocalService('https://example.com', 'pet', key), /回环/);
});
