import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EngineInterface } from '@deepcode/contract/engine';
import type { Plugin } from '@deepcode/contract/plugin';

/** 认这两个名字，顺序即附加顺序。 */
const FILES = ['AGENTS.md', 'CLAUDE.md'];

export type AgentsMdDeps = { readonly root: string };

/**
 * 嵌套的目录约定：模型读一个文件时，把**它上面每一层目录**的 `AGENTS.md` / `CLAUDE.md`
 * 附在那一次工具结果后面。
 *
 * **为什么挂 `Read` 而不是启动时全树预读**：全树预读会在大仓库上白烧 token，而约定是
 * "读到这一层才需要"的东西 —— 这正是"惰性"二字的意思（设计 §4.1）。
 *
 * ⚠️ **它必须排在 `coreTools` 之前**（同 tier 内先装载者在外层），否则 `next(e)` 回来时
 * `Read` 还没跑，拿到的是链尾的答复。这条顺序约束写在 `cli/plugins.ts` 的装配表里。
 */
export function createAgentsMdPlugin(deps: AgentsMdDeps): Plugin {
  // 同层去重：一个文件一次会话只附一次。
  // "一次会话"以**插件实例**为界 —— `--resume` 起新实例会再附一次，可接受：
  // 重新开一段对话，重新给一遍上下文是对的。
  //
  // ⚠️ **压缩之后要清掉这张表**（P7 §3.4，见下面那条 `session.compact`）：压缩把附在
  // `Read` 结果后面的约定从上下文里拿掉了，而这张表还记着"附过了" —— 于是它**永远不会
  // 再被附上**，模型丢了约定还不知道自己丢了。这就是"记忆越压越糊"的入门形状。
  // 复刻对象的正确姿势写在 `InstructionsLoaded.load_reason` 里：有 `'compact'` 这个取值
  // —— **压缩边界上重新装载文件，而不是把文件压进摘要**（对话有损、文件无损）。
  const attached = new Set<string>();

  return {
    name: 'agents-md',
    uses: ['tool.call', 'fs', 'session', 'session.compact'],

    register(on) {
      // 压缩是**纯通知**（派在改之前），这里只看一眼就把话传下去 —— 不拦、不改。
      on('session.compact', (_$, e, next) => {
        attached.clear();
        return next(e);
      });

      on('tool.call', { tool: 'Read' }, async ($, e, next) => {
        const result = await next(e);

        // 读都没读成，附约定没有意义。
        if ('deny' in result) return result;
        if (typeof result.value !== 'string' || result.value.startsWith('ERROR:')) return result;

        const input = e.input as { file_path?: unknown } | null;
        if (typeof input?.file_path !== 'string') return result;

        // 与 `read.ts` 完全一致地解析：它把 `input.file_path` **原样**交给 `$.fs.read`，
        // 相对路径由 `readFile` 按进程 cwd 解析 —— 而 `$.session.root()` 就是启动时的
        // `resolve(process.cwd())`。这里按同一个起点算，两边的"这个文件在哪"才是一回事。
        const root = resolve($.session.root());
        const file = resolve(root, input.file_path);

        const notes = await collect($, root, dirname(file), attached);
        if (notes.length === 0) return result;

        return { value: `${result.value}\n\n${notes.join('\n\n')}` };
      });
    },
  };
}

/**
 * 从 root **下面**开始，逐层向下收集到 `dir` 为止的约定文件。
 *
 * - **跨层去重**：root 自己那份（以及用户级那份）已经进了 system prompt
 *   （`main.ts` 的 `loadInstructions`），所以回溯从 root 下面开始 ——
 *   否则模型每读一个文件都要重读一遍根约定。
 * - **只对 root 之内的文件触发**：读 `~/.ssh/...`、读另一个仓库，不跨界去拽无关的约定文件。
 */
async function collect(
  $: EngineInterface,
  root: string,
  dir: string,
  attached: Set<string>,
): Promise<string[]> {
  const rel = relative(root, dir);
  // `''` = 目标就在 root 本身；`..` 开头或跨盘符时 `relative` 给出绝对路径 = root 之外。
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];

  const segments = rel.split(/[\\/]/);
  const notes: string[] = [];

  for (let depth = 1; depth <= segments.length; depth++) {
    const where = join(root, ...segments.slice(0, depth));
    for (const name of FILES) {
      const path = join(where, name);
      if (attached.has(path)) continue;

      let content: string;
      try {
        if (!(await $.fs.exists(path))) continue;
        content = await $.fs.read(path);
      } catch {
        // 读不动就跳过：跟着一个文件附带约定是**便利**，不是判定 —— 它要是能拦下这次读取，
        // 就变成了一个没写在文档里、也没人能配的权限层。
        continue;
      }

      attached.add(path);
      notes.push(`以下是 ${where} 的目录约定（${name}）：\n\n${content}`);
    }
  }

  return notes;
}
