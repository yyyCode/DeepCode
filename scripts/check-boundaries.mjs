#!/usr/bin/env node
// 依赖边界检查。规则见设计文档 §2.1。
// 不用 ESLint：flat config 下 import/no-restricted-paths 支持不稳定，而这里要的只是"某目录不许 import"。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = 'src';

// 每个目录允许 import 的 src 顶层目录白名单（'*' 表示不限）
const RULES = {
  contract: [],
  core: ['contract'],
  providers: ['contract'],
  builtins: ['contract'],
  cli: ['contract', 'core', 'providers', 'builtins'],
};

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function topAreaOf(file) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  return rel.split('/')[0];
}

const problems = [];

// src/ 在 Task 1 结束时还不存在（git 不跟踪空目录，所以新克隆里没有它）。
// 不守这一下，脚本会以 ENOENT 崩掉，而不是"检查通过"。
if (!existsSync(SRC)) {
  console.log('依赖边界检查通过（src/ 尚未创建）');
  process.exit(0);
}

for (const file of walk(SRC)) {
  const area = topAreaOf(file);
  const allowed = RULES[area];
  if (!allowed) continue;

  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 只查相对导入
    const target = join(file, '..', spec);
    const rel = relative(SRC, target).replace(/\\/g, '/');
    if (rel.startsWith('..')) continue; // 指向 src 之外，不管
    const targetArea = rel.split('/')[0];
    if (targetArea === area) continue; // 同目录内部不算越界
    if (!allowed.includes(targetArea)) {
      problems.push(`${relative(ROOT, file)}: 不允许 import ${targetArea}/（只允许 ${allowed.join(', ') || '无'}）`);
    }
  }
}

if (problems.length > 0) {
  console.error('依赖边界违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('依赖边界检查通过');
