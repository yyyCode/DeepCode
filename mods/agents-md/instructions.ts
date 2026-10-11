import { join } from 'node:path';
import {
  INSTRUCTION_LAYERS,
  type InstructionLayer,
  type ManagedInstruction,
} from '../../src/contract/instructions';
import type { Plugin } from '../../src/contract/plugin';

/**
 * 指令文件的装载：五层（P5b）。
 *
 * | 层 | 文件 |
 * | --- | --- |
 * | `project` | `<root>/AGENTS.md` · `<root>/CLAUDE.md` |
 * | `local` | `<root>/.deepcode/AGENTS.md` · `<root>/.deepcode/CLAUDE.md` |
 * | `user` | `~/.deepcode/AGENTS.md` |
 * | `managed` | 托管设置里 `instructions` 段点名的那几份（**已读好的数据**，从 deps 进来） |
 *
 * 顺序就是 `INSTRUCTION_LAYERS`：**越贴近这个仓库的越靠前，托管那份压在最末** ——
 * 它是权威，所以它最后说话。（`project` 内部再按目录深度往外排的那一层是嵌套，
 * 见 `nested.ts`：它不进系统提示，挂在 `Read` 的结果上。）
 *
 * `local` 住在 `.deepcode/` 里是因为那个目录在 `.gitignore` 里 ——
 * "本机的东西不进版本库"这句话在那一个目录上已经说过了。
 *
 * P4d 之前这段硬编码在 `main.ts` 的 `loadInstructions` 里。搬进事件只有一个目的：
 * **摘掉这个插件的注册，指令就真的不再进系统提示** —— 一条能被测试钉住的因果关系，
 * 而不是一处谁都能绕过的字符串拼接。
 *
 * 读盘走 `$.fs` 而不是 `node:fs`：插件只碰 `$` 是这套架构里承重的那条线。
 * 只有 `ENOENT` 当"这个文件没有"；别的读不动**照旧抛出去** ——
 * `$.fs.exists` 把什么错都咽成 `false`，那会让一个权限错误变成一个安静的失效，
 * 而安静的失效正是这个项目最想防的失败形状。
 *
 * ⚠️ 托管那几段是**数据**（`cli/settings.ts` 用五层那套读完的），不在这里读文件：
 * mod 只许 import 契约，而"哪几个来源算一层"是 CLI 那一侧的判定。
 */
export type InstructionsDeps = {
  readonly root: string;
  readonly home: string;
  /** 托管层下发的指令段。空数组 = 组织没下发（绝大多数机器）。 */
  readonly managed: readonly ManagedInstruction[];
};

export function createInstructionsPlugin(deps: InstructionsDeps): Plugin {
  // 每层读哪几个文件。（`managed` 不在这张表里：它不是"某个路径"，
  // 是 CLI 那边读好递进来的数据。）
  const pathsOf: Record<Exclude<InstructionLayer, 'managed'>, readonly string[]> = {
    project: [join(deps.root, 'AGENTS.md'), join(deps.root, 'CLAUDE.md')],
    local: [join(deps.root, '.deepcode', 'AGENTS.md'), join(deps.root, '.deepcode', 'CLAUDE.md')],
    user: [join(deps.home, '.deepcode', 'AGENTS.md')],
  };

  // ⚠️ 顺序**从契约那张表推**，不在这里再排一遍：两处各写一份的话，
  // 改了那边忘了这边，提示里的顺序会与文档说的不一样 —— 而顺序本身就是契约。
  const files: { readonly path: string }[] = [];
  for (const layer of INSTRUCTION_LAYERS) {
    if (layer === 'managed') continue;
    for (const path of pathsOf[layer]) files.push({ path });
  }

  return {
    name: 'instructions',
    uses: ['prompt.section', 'fs'],

    register(on) {
      on('prompt.section', async ($) => {
        const parts: string[] = [];
        for (const file of files) {
          let text: string;
          try {
            text = await $.fs.read(file.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          parts.push(`Contents of ${file.path}:\n\n${text}`);
        }

        // 托管那份带上自己的出处：它可能来自一个文件，也可能是托管设置里内嵌的一段 ——
        // 模型得知道每段话是从哪儿来的（与上面那个 `Contents of <路径>:` 同一个道理）。
        for (const item of deps.managed) {
          parts.push(`托管下发的指令（${item.label}）：\n\n${item.text}`);
        }

        return parts.length === 0
          ? { sections: [] }
          : { sections: [{ name: 'instructions', text: parts.join('\n\n') }] };
      });
    },
  };
}
