#!/usr/bin/env node
/**
 * verify-platform-memory.mjs —— 面板平台记忆 + 默认豆包
 *
 * 背景（真实事故）：把平台下拉注释掉之后，`useState(DEFAULT_PROVIDER_ID)` 把面板
 * 钉死在 deepseek，DSH 每次重启都跳去 chat.deepseek.com，用户侧表现就是
 * 「我明明登的是豆包，怎么掉登录了 / 换人了」。断言把这条钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'src/client/index.ts'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

console.log('[1] 常量');
ok('PLATFORM_KEY 存在', src.includes("const PLATFORM_KEY = 'dsh-webin:platform'"));
ok('PLATFORM_FALLBACK 是 doubao', /const PLATFORM_FALLBACK = 'doubao'/.test(src));
ok('PLATFORM_FALLBACK 注释说明不等同 DEFAULT_PROVIDER_ID', src.includes('不是 DEFAULT_PROVIDER_ID'));

console.log('[2] 读写函数');
ok('readPlatformId 已定义', /function readPlatformId\(\): string \{/.test(src));
ok('writePlatformId 已定义', /function writePlatformId\(id: string\): void \{/.test(src));
ok('readPlatformId 容错', /catch \{\s*\/\* 读不到就用默认 \*\/\s*\}/.test(src));

console.log('[3] 状态接线');
ok('platformId 初值走 readPlatformId', /const \[platformId, setPlatformId\] = useState<string>\(\(\) => readPlatformId\(\)\)/.test(src));
ok('不再用 DEFAULT_PROVIDER_ID 初始化平台', !/useState<string>\(DEFAULT_PROVIDER_ID\)/.test(src));
ok('client 不再 import DEFAULT_PROVIDER_ID', !/import \{ DEFAULT_PROVIDER_ID/.test(src));
ok('有写回 effect', /useEffect\(\(\) => \{\s*writePlatformId\(platformId\)\s*\}, \[platformId\]\)/.test(src));

console.log('[4] 产物');
ok('bundle 含 key', bundle.includes('dsh-webin:platform'));
ok('bundle 含默认 doubao', bundle.includes('doubao'));
ok('bundle 不再把 DEFAULT_PROVIDER_ID 当平台初值', !/useState\(\(0, [a-zA-Z_$]+\.default\)\)/.test(bundle));

console.log('');
console.log(fail === 0 ? 'ALL CLEAN (' + pass + ' checks)' : pass + ' passed, ' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
