import { join } from 'node:path';
import type { Plugin } from '../contract/plugin';

/**
 * 项目指令文件的装载：`AGENTS.md` / `CLAUDE.md` / `~/.deepcode/AGENTS.md`。
 *
 * P4d 之前这段硬编码在 `main.ts` 的 `loadInstructions` 里。搬进事件只有一个目的：
 * **摘掉这个插件的注册，指令就真的不再进系统提示** —— 一条能被测试钉住的因果关系，
 * 而不是一处谁都能绕过的字符串拼接。
 *
 * 读盘走 `$.fs` 而不是 `node:fs`：插件只碰 `$` 是这套架构里承重的那条线。
 * 只有 `ENOENT` 当"这个文件没有"；别的读不动**照旧抛出去** ——
 * `$.fs.exists` 把什么错都咽成 `false`，那会让一个权限错误变成一个安静的失效，
 * 而安静的失效正是这个项目最想防的失败形状。
 */
export type InstructionsDeps = { readonly root: string; readonly home: string };

export function createInstructionsPlugin(deps: InstructionsDeps): Plugin {
  const files = [
    join(deps.root, 'AGENTS.md'),
    join(deps.root, 'CLAUDE.md'),
    join(deps.home, '.deepcode', 'AGENTS.md'),
  ];

  return {
    name: 'instructions',
    uses: ['prompt.section', 'fs'],

    register(on) {
      on('prompt.section', async ($) => {
        const parts: string[] = [];
        for (const file of files) {
          let text: string;
          try {
            text = await $.fs.read(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          parts.push(`Contents of ${file}:\n\n${text}`);
        }
        return parts.length === 0
          ? { sections: [] }
          : { sections: [{ name: 'instructions', text: parts.join('\n\n') }] };
      });
    },
  };
}
