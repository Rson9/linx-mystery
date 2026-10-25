import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const NONCE_HEADER = 'X-Misheng-Local-Nonce';
export const PROOF_HEADER = 'X-Misheng-Local-Proof';
export function loadLocalKey(home = process.env.MISHENG_HOME || root) {
  if (process.env.MISHENG_DESKTOP_TEST === '1' && /^[a-f0-9]{64}$/.test(process.env.MISHENG_LOCAL_AUTH_KEY || '')) return process.env.MISHENG_LOCAL_AUTH_KEY;
  const path = resolve(home, '.local/desktop-server.key');
  let key;
  try { key = readFileSync(path, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    key = readFileSync(path, 'utf8').trim();
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('本机服务认证文件无效');
  chmodSync(path, 0o600); return key;
}
export function serviceProof(key, role, port, nonce) {
  if (!/^[a-f0-9]{64}$/.test(nonce || '')) return null;
  return createHmac('sha256', Buffer.from(key, 'hex')).update(`misheng-local-v1:${role}:${port}:${nonce}`).digest('hex');
}
export function validServiceProof(key, role, port, nonce, proof) {
  if (!/^[a-f0-9]{64}$/.test(proof || '')) return false;
  const expected = serviceProof(key, role, port, nonce);
  return Boolean(expected) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'));
}
export function localProofMiddleware(role, key) {
  return (req, res, next) => {
    const nonce = req.headers[NONCE_HEADER.toLowerCase()];
    if (/^[a-f0-9]{64}$/.test(nonce || '')) res.setHeader(PROOF_HEADER, serviceProof(key || loadLocalKey(), role, req.socket.localPort, nonce));
    next();
  };
}
export async function authenticateLocalService(origin, role, key, fetchImpl = fetch) {
  const url = new URL('/healthz', origin), nonce = randomBytes(32).toString('hex');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('本机服务认证只允许回环地址');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(1500), headers: { [NONCE_HEADER]: nonce } });
  return response.ok && validServiceProof(key, role, Number(url.port || 80), nonce, response.headers.get(PROOF_HEADER));
}
