import { readFileSync } from 'node:fs';
import { cases } from '../src/cases.js';
import { validateLibrary } from '../src/library.js';
const args = process.argv.slice(2); let library = cases;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--draft') { console.error('用法：pnpm library:check [--draft path/to/draft.json]'); process.exit(2); }
  try { const value = JSON.parse(readFileSync(args[1], 'utf8')); library = Array.isArray(value) ? value : [value]; }
  catch { console.error('无法读取合法的题库 JSON 草稿'); process.exit(2); }
}
const errors = validateLibrary(library);
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log(`PASS: ${library.length} 道题结构、事实引用、提示阶段和评分规准检查通过。\n这不等于内容逻辑或真人体验合格；草稿不会自动进入线上题库。`);
