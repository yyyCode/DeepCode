import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Plugin } from '../../contract/plugin';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;

export const grepTool: Plugin = {
  name: 'tool-grep',
  uses: ['tool.call', 'tool.describe', 'fs'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Grep' },
      () => ({
        description: '在文件内容里做正则搜索。返回 `相对路径:行号: 该行内容`。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式' },
            path: { type: 'string', description: '搜索起点，默认会话根目录' },
            glob: { type: 'string', description: '只看匹配该 glob 的文件，如 `**/*.ts`' },
          },
          required: ['pattern'],
        },
      }),
    );

    on('tool.call', { tool: 'Grep' }, async ($, e) => {
      const input = e.input as { pattern: string; path?: string; glob?: string };
      if (!input?.pattern) return { value: 'ERROR: 缺少 pattern 参数' };

      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern);
      } catch (error) {
        return { value: `ERROR: 正则非法: ${String(error)}` };
      }

      const root = input.path ?? $.session.root();
      const fileFilter = input.glob ? new RegExp(globToRegexSource(input.glob)) : undefined;
      const matches: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (matches.length >= MAX_MATCHES) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= MAX_MATCHES) return;
          if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
          if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

          const full = join(dir, entry.name);
          const rel = relative(root, full).replace(/\\/g, '/');

          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (fileFilter && !fileFilter.test(rel)) continue;

          let fileStat;
          try {
            fileStat = await stat(full);
          } catch {
            continue;
          }
          if (fileStat.size > MAX_FILE_BYTES) continue;

          let text: string;
          try {
            text = await readFile(full, 'utf8');
          } catch {
            continue;
          }

          for (const [index, line] of text.split('\n').entries()) {
            if (matches.length >= MAX_MATCHES) return;
            if (regex.test(line)) matches.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`);
          }
        }
      }

      await walk(root);
      return {
        value:
          matches.length === 0
            ? `没有匹配 ${input.pattern} 的内容`
            : matches.join('\n') + (matches.length >= MAX_MATCHES ? '\n... 已达上限' : ''),
      };
    });
  },
};

function globToRegexSource(pattern: string): string {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return `^${escaped}$`;
}
