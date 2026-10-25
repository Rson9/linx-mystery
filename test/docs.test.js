import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('产品文档中的本地链接与图片均可访问', () => {
  const files = ['README.md', 'CHANGELOG.md', 'clients/lingxi/README.md', ...readdirSync(resolve(root, 'docs')).filter(p => p.endsWith('.md')).map(p => `docs/${p}`)];
  const missing = [];
  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8');
    const links = [...content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(x => x[1]);
    links.push(...[...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map(x => x[1]));
    for (const link of links) {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(link)) continue;
      const path = decodeURIComponent(link.split('#')[0].split('?')[0]);
      if (!existsSync(resolve(dirname(resolve(root, file)), path))) missing.push(`${file}: ${link}`);
    }
  }
  assert.deepEqual(missing, []);
});
