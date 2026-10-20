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
const PACKAGES = join(ROOT_DIR, 'packages');
const PLUGINS = join(ROOT_DIR, 'plugins');
const MODS = join(ROOT_DIR, 'mods');

// 每个包允许 import 的 @deepcode/* 包。相对路径只许留在自己的 src/ 里。
// 这套规则就是原来"src/ 按顶层目录"那张表的物理版。
const PACKAGE_RULES = {
  '@deepcode/contract': [],
  '@deepcode/core': ['@deepcode/contract'],
  '@deepcode/providers': ['@deepcode/contract'],
  '@deepcode/builtins': ['@deepcode/contract'],
  '@deepcode/mcp': ['@deepcode/contract'],
  '@deepcode/cli': [
    '@deepcode/contract',
    '@deepcode/core',
    '@deepcode/providers',
    '@deepcode/builtins',
    '@deepcode/mcp',
  ],
  // 陪伴端只需要「和模型说话」这一层：不碰 core 的循环，也不依赖 CLI 的渲染。
  '@deepcode/companion': ['@deepcode/contract', '@deepcode/providers'],
};

// `.mjs` / `.js` 也要看：`plugins/` 下的插件是 `.mjs`，在加上这一条之前，
// 它们同时落在 tsc（不开 allowJs，不看 js）与这个脚本（只看 ts）的缝里 ——
// 自家插件的源码，两套检查谁都不管。
const SOURCE_EXT = ['.ts', '.mjs', '.js'];

// `export ... from '...'` 与 `import ... from '...'` 都算。
// 只认 import 的话，一句 `export * from '../core/x'` 能整个溜过去。
const IMPORT_FROM_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;

// 副作用式导入（`import 'fs-extra'` / `import '../../packages/core/x'`）**没有 `from`**，上面那条认不出来。
// 这不是边角情形：一个插件要把引擎模块整个拉进来，最顺手的写法就是这个。
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

/** `@deepcode/core/loop` → `@deepcode/core`；不是这个前缀返回 undefined。 */
function packageOf(spec) {
  const match = /^(@deepcode\/[^/]+)(?:\/|$)/.exec(spec);
  return match?.[1];
}

const problems = [];

// ── packages/：包边界 ───────────────────────────────────────────────
// 包内用相对路径；跨包必须写 `@deepcode/<包>`，且目标包在规则里。
// 相对路径逃出 packages/<自己>/src 是违规 —— 那种写法绕过了包依赖声明。
if (existsSync(PACKAGES)) {
  for (const entry of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, entry, 'src');
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;

    const pkg = `@deepcode/${entry}`;
    const allowed = PACKAGE_RULES[pkg];
    // 没登记的目录不猜 —— 新包要先在这张表里表态。
    if (!allowed) {
      problems.push(`packages/${entry}: 没在 PACKAGE_RULES 里登记依赖规则`);
      continue;
    }
    const ownSrc = `packages/${entry}/src/`;

    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const spec of importsOf(text)) {
        if (spec.startsWith('.')) {
          const target = relative(ROOT_DIR, join(file, '..', spec)).replace(/\\/g, '/');
          if (target === ownSrc.slice(0, -1) || target.startsWith(ownSrc)) continue;

          // 唯一的例外：CLI 负责把内建 mod 装起来。单向依赖 —— 内核与 builtins
          // 不认识 mod（`core/create.ts` 那句"内核没有硬编码的工具表"是同一条）。
          if (pkg === '@deepcode/cli' && (target === 'mods' || target.startsWith('mods/'))) continue;
          if (target === 'mods' || target.startsWith('mods/')) {
            problems.push(
              `${shown(file)}: 只有 @deepcode/cli 可以 import 内建 mod（${target}）—— 内核与 builtins 不认识 mod`,
            );
            continue;
          }

          if (target.startsWith('packages/')) {
            const other = target.split('/')[1];
            const otherPkg = `@deepcode/${other}`;
            problems.push(
              `${shown(file)}: 相对路径跨到了 ${otherPkg}（跨包请用 '${otherPkg}/...'）`,
            );
          } else {
            problems.push(`${shown(file)}: import ${spec} 逃出了 ${ownSrc.slice(0, -1)}`);
          }
          continue;
        }

        const targetPkg = packageOf(spec);
        if (targetPkg === undefined) continue; // node: 与普通依赖不在这张表管
        if (!(targetPkg in PACKAGE_RULES)) {
          problems.push(`${shown(file)}: 未知的包 ${targetPkg}`);
          continue;
        }
        if (targetPkg === pkg) {
          problems.push(`${shown(file)}: 包内请用相对路径，不要写 ${targetPkg}`);
          continue;
        }
        if (!allowed.includes(targetPkg)) {
          problems.push(
            `${shown(file)}: 不允许 import ${targetPkg}（只允许 ${allowed.join(', ') || '无'}）`,
          );
        }
      }
    }
  }
}

// ── plugins/：插件是"陌生人" ─────────────────────────────────────────
// 只许 `node:` 内建，或停在**自己那个插件目录里**的相对路径。
// 裸包名会解析到**宿主的** node_modules —— 那是隐式耦合：今天能跑，
// 只是因为宿主恰好装了那个包；插件要独立分发的那天必炸。
// `@deepcode/*` 同样算裸包名：插件只通过 hook 契约在运行时与引擎说话。
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

// ── mods/：内建 mod ──────────────────────────────────────────────────
// 只许 `node:` 内建、`@deepcode/contract`（契约）、或自己这个 mod 目录里的相对路径。
//
// 这条规则是 README 那句"内建与第三方走同一条接口"从口号变成强制的那一步：
// 一个 mod 拿不到 `@deepcode/core` 的实现细节，也拿不到 `@deepcode/cli` 的渲染器 ——
// 它对引擎的认知**与一个第三方插件一样少**。
//
// ⚠️ 它有个值钱的副作用：diff mod 因此**只能产出数据模型**，上色必须留在 cli 侧
// （把 `ansi.ts` 一起搬进 mod 是绕过规则，不是遵守它）。见 P5 设计 §3.2。
//
// 豁免：`test/` 与 `*.test.ts`。mod 的测试**本来就应该**用真的 `createEngine`
// 与 vitest 去测它（`mods/telemetry/test/plugin.test.ts` 就是这么写的）——
// 把它们关在契约后面只会逼测试去造假引擎，而那正是这仓库反复避开的东西。
if (existsSync(MODS)) {
  for (const file of walk(MODS)) {
    const relMod = relative(MODS, file).replace(/\\/g, '/');
    const owner = relMod.split('/')[0];
    if (relMod.split('/').includes('test') || relMod.endsWith('.test.ts')) continue;

    const text = readFileSync(file, 'utf8');
    for (const spec of importsOf(text)) {
      if (spec.startsWith('node:')) continue;
      if (spec === '@deepcode/contract' || spec.startsWith('@deepcode/contract/')) continue;
      if (spec.startsWith('@deepcode/')) {
        problems.push(`${shown(file)}: mod 只许 import @deepcode/contract（这条指向 ${spec}）`);
        continue;
      }
      if (!spec.startsWith('.')) {
        problems.push(`${shown(file)}: 不允许裸包名 ${spec}（内建 mod 只通过契约与引擎说话）`);
        continue;
      }
      const target = relative(ROOT_DIR, join(file, '..', spec)).replace(/\\/g, '/');
      if (target.startsWith('..')) {
        problems.push(`${shown(file)}: import ${spec} 逃出了仓库`);
        continue;
      }
      if (target === `mods/${owner}` || target.startsWith(`mods/${owner}/`)) continue;
      if (target.startsWith('mods/')) {
        problems.push(`${shown(file)}: import ${spec} 跨到了 mods/${target.split('/')[1]}/`);
        continue;
      }
      problems.push(`${shown(file)}: import ${spec} 不在 mod 允许的范围内`);
    }
  }
}

if (problems.length > 0) {
  console.error('依赖边界违规：\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}
if (!existsSync(PACKAGES) && !existsSync(PLUGINS)) {
  console.log('依赖边界检查通过（packages/ 与 plugins/ 都不存在）');
} else {
  console.log('依赖边界检查通过');
}
