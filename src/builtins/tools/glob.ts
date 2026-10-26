import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Plugin } from '../../contract/plugin';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_RESULTS = 500;

/** 极简 glob：支持 `**`（任意层）、`*`（单层任意）与字面量。够 MVP 用。 */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`);
}

export const globTool: Plugin = {
  name: 'tool-glob',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Glob' },
      () => ({
        description: '按路径模式查找文件，例如 `src/**/*.ts`。返回相对路径列表。',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，如 `src/**/*.ts`' },
            path: { type: 'string', description: '搜索起点，默认会话根目录' },
          },
          required: ['pattern'],
        },
      }),
    );

    on('tool.call', { tool: 'Glob' }, async ($, e) => {
      const input = e.input as { pattern: string; path?: string };
      if (!input?.pattern) return { value: 'ERROR: 缺少 pattern 参数' };

      const root = input.path ?? $.session.root();
      const matcher = toRegExp(input.pattern);
      const found: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (found.length >= MAX_RESULTS) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (found.length >= MAX_RESULTS) return;
          // 同 grep：曾经把所有 `.` 开头的条目都跳过，于是 `.github/**`、`.gitignore`
          // 这类文件永远找不到，返回的还是"没有匹配"。重目录在 SKIP_DIRS 里。
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

          const full = join(dir, entry.name);
          const rel = relative(root, full).replace(/\\/g, '/');
          if (entry.isDirectory()) await walk(full);
          else if (matcher.test(rel)) found.push(rel);
        }
      }

      await walk(root);
      return {
        value:
          found.length === 0
            ? `没有匹配 ${input.pattern} 的文件`
            : found.join('\n') + (found.length >= MAX_RESULTS ? '\n... 已达上限' : ''),
      };
    });
  },
};
