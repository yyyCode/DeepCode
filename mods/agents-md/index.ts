import type { ModSpec } from '@deepcode/contract/mod';
import { createInstructionsPlugin } from './instructions';
import { createAgentsMdPlugin } from './nested';

/**
 * 指令文件与惰性嵌套 —— 一个 mod 贡献**两个**插件。
 *
 * ⚠️ 顺序是契约：嵌套那个必须在 `coreTools` 之前（同 tier 内先装载者在外层，
 * 它要等 `next(e)` 回来拿到 `Read` 的结果才能追加）。保证那条的是
 * `cli/plugins.ts` —— 它把 mods 整片排在 firstParty 前面。见 `nested.ts` 顶部。
 */
export const spec: ModSpec = {
  name: 'agents-md',
  summary: 'AGENTS.md / CLAUDE.md：指令文件装载 + 嵌套目录约定',
  create: (deps) => [
    createInstructionsPlugin({
      root: deps.root,
      home: deps.home,
      managed: deps.managedInstructions,
    }),
    createAgentsMdPlugin({ root: deps.root }),
  ],
};
