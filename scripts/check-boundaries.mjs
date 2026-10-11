#!/usr/bin/env node
// 依赖边界检查。规则见设计文档 §2.1 与 P4e 设计 §3。
// 不用 ESLint：flat config 下 import/no-restricted-paths 支持不稳定，而这里要的只是"某目录不许 import"。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 仓库根：默认由脚本自身位置推出（`..` 就是仓库根）。
// 命令行也可以给一个 —— 那一条是为了让它**可被测试**：
// 一个只能对着真仓库跑的检查器，测试里造不出违规样本。
const ROOT_DIR = (process.argv[2] ?? new URL('..', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const SRC = join(ROOT_DIR, 'src');
const PLUGINS = join(ROOT_DIR, 'plugins');

// 每个目录允许 import 的 src 顶层目录白名单（'*' 表示不限）
const RULES = {
  contract: [],
  core: ['contract'],
  providers: ['contract'],
  builtins: ['contract'],
  cli: ['contract', 'core', 'providers', 'builtins'],
};

// `.mjs` / `.js` 也要看：`plugins/` 下的插件是 `.mjs`，在加上这一条之前，
// 它们同时落在 tsc（不开 allowJs，不看 js）与这个脚本（只看 ts）的缝里 ——
// 自家插件的源码，两套检查谁都不管。
const SOURCE_EXT = ['.ts', '.mjs', '.js'];

// `export ... from '...'` 与 `import ... from '...'` 都算。
// 只认 import 的话，一句 `export * from '../core/x'` 能整个溜过去。
const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

// 副作用式导入（`import 'fs-extra'` / `import '../../src/x'`）**没有 `from`**，上面那条认不出来。
// 这不是边角情形：一个插件要把引擎模块整个拉进来，最顺手的写法就是这个。
// （反向验证时先漏了这一条，是"改坏一次看它红不红"把它逼出来的。）
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** 一份源码里所有的导入说明符，两种写法都收。 */
function importsOf(text) {
  return [
    ...[...text.matchAll(IMPORT_FROM_RE)].map((m) => m[1]),
    ...[...text.matchAll(SIDE_EFFECT_RE)].map((m) => m[1]),
  ];
}

/** 相对仓库根、正斜杠的显示名。两端共用，免得两种写法漂开。 */
function shown(file) {
  return relative(ROOT_DIR, file).replace(/\\/g, '/');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SOURCE_EXT.some((ext) => p.endsWith(ext))) out.push(p);
  }
  return out;
}

const problems = [];

// ── src/：按顶层目录定规则 ────────────────────────────────────────────
// `existsSync` 这一守是必要的：git 不跟踪空目录，新克隆里可能没有 src/，
// 不守就会以 ENOENT 崩掉，而不是"检查通过"。
if (existsSync(SRC)) {
  for (const file of walk(SRC)) {
    const area = relative(SRC, file).replace(/\\/g, '/').split('/')[0];
    const allowed = RULES[area];
    if (!allowed) continue;

    const text = readFileSync(file, 'utf8');
    for (const spec of importsOf(text)) {
      if (!spec.startsWith('.')) continue; // 只查相对导入
      const rel = relative(SRC, join(file, '..', spec)).replace(/\\/g, '/');
      if (rel.startsWith('..')) {
        // 相对导入逃出 src/ 几乎总是相对路径层级写错了 —— 比如
        // src/builtins/confirm.ts（比 tools/ 高一层）用了 tools/ 才该用的
        // '../../contract/plugin'，实际解析成 <repo>/contract/plugin。
        problems.push(
          `${shown(file)}: import ${spec} 逃出了 src/（多半是相对路径层级写错）`,
        );
        continue;
      }
      const targetArea = rel.split('/')[0];
      if (targetArea === area) continue; // 同目录内部不算越界
      if (!allowed.includes(targetArea)) {
        problems.push(
          `${shown(file)}: 不允许 import ${targetArea}/（只允许 ${allowed.join(', ') || '无'}）`,
        );
      }
    }
  }
}

// ── plugins/：插件是"陌生人" ─────────────────────────────────────────
// 只许 `node:` 内建，或停在**自己那个插件目录里**的相对路径。
// 裸包名会解析到**宿主的** node_modules —— 那是隐式耦合：今天能跑，
// 只是因为宿主恰好装了那个包；插件要独立分发的那天必炸。
if (existsSync(PLUGINS)) {
  for (const file of walk(PLUGINS)) {
    const owner = relative(PLUGINS, file).replace(/\\/g, '/').split('/')[0];

    const text = readFileSync(file, 'utf8');
    for (const spec of importsOf(text)) {
      if (spec.startsWith('node:')) continue; // 内建，允许
      if (!spec.startsWith('.')) {
        problems.push(`${shown(file)}: 不允许裸包名 ${spec}（插件不该依赖宿主的依赖树）`);
        continue;
      }
      const target = relative(PLUGINS, join(file, '..', spec)).replace(/\\/g, '/');
      if (target.startsWith('..')) {
        problems.push(
          `${shown(file)}: import ${spec} 逃出了 plugins/（插件只通过 hook 契约与引擎说话）`,
        );
        continue;
      }
      const targetOwner = target.split('/')[0];
      if (targetOwner !== owner) {
        problems.push(`${shown(file)}: import ${spec} 跨到了 plugins/${targetOwner}/`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('依赖边界违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
if (!existsSync(SRC) && !existsSync(PLUGINS)) {
  console.log('依赖边界检查通过（src/ 与 plugins/ 都不存在）');
} else {
  console.log('依赖边界检查通过');
}
