import type { ModDeps, ModSpec } from '../../src/contract/mod';
import type { Plugin } from '../../src/contract/plugin';
import { backendOf, type Backend, type BackendProbe } from './backend';
import { createGitBackend, gitProbe } from './git';
import { buildPane, type PaneModel } from './pane';

/**
 * `diff` —— 会话改动 + 工作区未提交的 pane。
 *
 * 这个 mod 贡献**一块**：工作区未提交。`/diff` 的另一块（本会话改过什么）是 CLI 自己的
 * 数据，住在 `cli/changes.ts`，由 CLI 侧的渲染器补上来 —— 所有权判定见 P5c 计划 §1.2。
 * 这么分是因为：**只有这一块会在 git 缺席时消失**，而 §5.3 判据一说的正是它。
 *
 * ⚠️ **它 import 不到 `src/cli/` 下的任何东西**（`scripts/check-boundaries.mjs` 强制）。
 * 所以上色不在这里 —— 这个 mod 只产出 `PaneModel`（纯数据），
 * 由 CLI 注入的渲染器 `PaneRenderer` 把它变成带颜色的文本。
 * "把 `ansi.ts` 一起搬进 mod"是绕开规则，不是遵守它（P5 设计 §3.2）。
 */

/**
 * 渲染器。**由 CLI 注入**，mod 不认识 `Palette`。
 *
 * 返回数组或一整段字符串都行 —— 注入方不该被一种形状绑住（CLI 那边按行打给 `$.ui.log`，
 * 而 `ui.log` 一次一行，所以数组更顺手；字符串是给测试与别的宿主留的宽口径）。
 */
export type PaneRenderer = (model: PaneModel) => readonly string[] | string;

/** 这个 mod 认的后端，按优先级。今天只有一个 —— 但这条路是通的，"git 只是默认实现"。 */
const PROBES: readonly BackendProbe[] = [
  { name: 'git', probe: gitProbe, of: (deps) => createGitBackend(deps) },
];

/**
 * 收尾：把渲染器的两种返回形状归一。
 *
 * 空字符串段要丢掉 —— 打一行空行出来，块中间会凭空多一道缝。
 */
function toLines(rendered: readonly string[] | string): readonly string[] {
  const lines = typeof rendered === 'string' ? rendered.split('\n') : [...rendered];
  return lines.filter((line) => line !== '');
}

/**
 * 造这个 mod 的插件。
 *
 * `render` 从外面来（`builtinMods(render)`）。做成参数而不是 `ModDeps` 的一个字段，
 * 是因为 `ModDeps` 是**所有** mod 共用的数据形状，而渲染器只与这一个有关；
 * 且 `ModDeps` 由装载器填，渲染器由 CLI 填 —— 两件事不该挤进同一个口袋。
 */
export function createDiffPanePlugin(deps: ModDeps, render: PaneRenderer): Plugin {
  return {
    name: 'diff-pane',
    uses: ['command.run', 'command.describe', 'ui'],

    register(on) {
      on('command.describe', { name: 'diff' }, () => ({
        description: '看本会话改过什么、工作区还有什么没提交',
      }));

      on('command.run', { name: 'diff' }, async ($) => {
        const backend: Backend | undefined = await backendOf(PROBES, deps);
        // 探针在装载期已经过了一遍，装上了就说明它当时是有的 —— 走到这儿只可能是
        // 这一小会儿里 git 从 PATH 上消失了。说一句人话，不抛。
        if (backend === undefined) {
          $.ui.log('这台机器上没有 git，工作区那一块看不成了。');
          return { handled: true };
        }

        let model: PaneModel;
        try {
          model = await buildPane({ backend });
        } catch (error) {
          // git 抽风（超时、输出超上限）不该让 `/diff` 变成一次崩溃。
          // 与遥测的 `safely` 同一条：有则更好、无则照常的东西，不许把宿主拖下水。
          $.ui.log(
            `读工作区改动失败：${error instanceof Error ? error.message : String(error)}` +
              ' —— 会话改动照常。',
          );
          return { handled: true };
        }

        for (const line of toLines(render(model))) $.ui.log(line);
        // ⚠️ **不调 `next(e)`**：装上了就只由它应答 `/diff`。CLI 那一侧看见
        // `paneLoaded: true` 会**不注册**自己的应答者，两处配合才不至于打两遍。
        return { handled: true };
      });
    },
  };
}

/**
 * 不着色的渲染器。**只给测试用。**
 *
 * 生产路径上这里的渲染器永远是 `main.ts` 注进来的那个（带 `Palette` 的），
 * 因为"模型归 mod、渲染归 cli"是这一片的分界线 —— 而这个函数的存在只是为了
 * 让 `mods/diff` 的插件测试不必把整个 CLI 拉进来。
 */
export const plainRenderer: PaneRenderer = (model) => {
  const lines = [
    `── ${model.headline} · ${model.backend} ──  ${model.files} 个文件  +${model.added} −${model.removed}`,
  ];
  if (model.why !== undefined) lines.push(model.why);
  for (const section of model.sections) {
    lines.push(`[${section.title}]`);
    for (const file of section.files) {
      lines.push(
        file.lines === null
          ? `  ${file.path}（${file.why ?? '没有逐行改动'}）`
          : `  ${file.path}`,
      );
    }
  }
  return lines;
};

/**
 * P5c 的 mod 描述符。
 *
 * `optionalDeps` 里那一条 `git` 是**这个项目里第一个真的可选依赖** ——
 * P5a 把机制立起来了（探针 + 四态报告 + 夹具测试），但当时四个 mod 都不挑环境，
 * 那条机制没有真消费者。§9.3 出口标准第二条（"可选依赖缺失时主流程无损"）到这儿
 * 才有了真实例证：把 git 从 PATH 里拿掉，这件事整个不装，其余一切照常。
 *
 * ⚠️ 它是个**工厂**而不是一个常量：渲染器要 CLI 注入，而 `ModSpec` 是死的。
 * 别的三个 mod 仍然是常量 —— 只有这一个需要外来的东西。
 *
 * `render` **必填、不给默认**：给了默认的话，"忘了把 CLI 那个带调色板的渲染器接进来"
 * 会表现成"`/diff` 从此没有颜色"而三条检查全绿 —— 与 `ModDeps.managedInstructions`
 * 必填的理由是同一个形状（一处静默失效，全套检查照绿）。
 */
export function diffSpec(render: PaneRenderer): ModSpec {
  return {
    name: 'diff',
    summary: '会话改动 + 工作区未提交的 pane',
    optionalDeps: [{ name: 'git', probe: gitProbe }],
    create: (deps) => [createDiffPanePlugin(deps, render)],
  };
}
