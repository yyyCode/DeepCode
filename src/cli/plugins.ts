import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import type { Tier } from '../contract/tier';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { createPermissionsPlugin } from '../builtins/permissions';
import { createPluginGuardPlugin, type PluginDenyRule } from '../builtins/plugin-guard';
import { createSecDefaultPlugin } from '../builtins/sec-default';
import { streamPlugin } from './stream';
import { createChangesPlugin, type SessionChanges } from './changes';
import { createSessionCommands } from './commands';
import { createPermissionsCommand } from './permissions-command';
import type { ResolvedPolicy } from './settings';
import type { Renderer } from './render';
import type { Palette } from './ansi';

/** 装配 CLI 全部插件需要的外设：渲染器、会话改动表、REPL 的消息数组、根目录、调色板、设置快照。 */
export type CliPluginDeps = {
  readonly render: Renderer;
  /** 会话改动表。session-changes 插件往它记，/diff 从它读 —— 必须是同一个对象。 */
  readonly changes: SessionChanges;
  /** REPL 正在用的**那个**消息数组。/clear 就地清空它，所以也必须是同一个引用。 */
  readonly messages: Message[];
  readonly root: string;
  readonly palette: Palette;
  /** 已解析好的权限设置快照。/permissions 从它读，两个插件从它分规则。 */
  readonly policy: ResolvedPolicy;
  /** 规则里 `~` 展开用的主目录（在 settings.ts 解析时就用掉了）。 */
  readonly home: string;
  /**
   * 从插件目录里发现并装载好的第三方插件。CLI 把它们**排在最后** ——
   * 座位由引擎强制成 `append`（见 core/third-party.ts），这里的顺序只在同 tier 内的
   * "谁在外层"上起作用，而插件之间按名字字典序（plugin-dir.ts 排好的）。
   */
  readonly discovered?: readonly Plugin[];
  /** 五层合并后的 `plugins.deny`。交给 plugin-guard，CLI 自己不判。 */
  readonly pluginDeny?: readonly PluginDenyRule[];
};

export type CliPluginBundle = {
  readonly plugins: Plugin[];
  /** 插件名 → tier。**由 CLI 钉**，见 core/create.ts 的 CreateEngineDeps.seating。 */
  readonly seating: Record<string, Tier>;
  /** 第三方插件的名字，交给 `createEngine` 的 `thirdParty`。 */
  readonly thirdParty: readonly string[];
};

/**
 * CLI 装载的全部插件，以及它们各自的座位。
 *
 * 抽成函数只为一件事：让测试钉住"模型文本的出口确实在这份清单里"。
 * 原先这张表直接写在 main() 里，而 main() 一 import 就会跑起来，
 * 于是"插件少装了一个"这类错误只能靠人肉端到端发现 —— 事实也已经发生过一次：
 * 清单里没有 turn.step 的应答者，模型说的话一个字都到不了终端，
 * 而 typecheck、lint、C1/C2 全绿。
 *
 * P2 之后它多了一件事：座位不再由引擎默认（`builtin`），而是这里显式钉。
 */
export function cliPlugins(deps: CliPluginDeps): CliPluginBundle {
  // ⚠️ 顺序是契约，不是随手排的（下面每条都承重）：
  // 1. 座位比顺序更重要：prepend 的 plugin-guard 与 sec-default、user 的 permissions
  //    天然在外层，无论它们在数组里排第几。数组顺序只在**同 tier 内**有效。
  // 2. session-changes 必须排在 coreTools **之前**：同 tier 内先装载者在外层，
  //    而它要在 tool-write 自己的 hook 跑之前抢到文件的**原样**。晚一步，
  //    next 回来时文件已经写完了，before 就成了 after 的副本，/diff 永远空白。
  //    （见 cli/changes.ts 里 createChangesPlugin 的顺序约束注释。）
  // 3. 第三方插件排在**最后**：它们坐 append，与这里的第一方同 tier 时后装载者在内层，
  //    于是任何第一方判定都在它们外面 —— 与"只能更严"配着看，这是双保险。
  const firstParty: Plugin[] = [
    // 个人规则：policy 之外的四个来源。
    createPermissionsPlugin({ rules: deps.policy.personalRules }),
    createChangesPlugin(deps.changes),
    ...coreTools,
    confirmPlugin,
    commandsPlugin,
    streamPlugin(deps.render),
    // /diff、/clear 要碰渲染会话语状态，所以住在 cli/ 而不是 builtins/（见 cli/commands.ts）。
    createSessionCommands({
      changes: deps.changes,
      messages: deps.messages,
      root: deps.root,
      palette: deps.palette,
    }),
    // /permissions 同理。
    createPermissionsCommand({ policy: deps.policy, palette: deps.palette }),
  ];

  // 第一方名字**从这份清单推**，不另抄一份名单：抄一份的话，往上面加一个插件
  // 而忘了加到名单里，它的名字就不再享有第一方豁免 —— 而 deny 名单点到它时
  // 它就真的会被拦下（一份禁用名单从而又能拆承重墙了）。
  const names = firstParty.map((plugin) => plugin.name);
  const guard = createPluginGuardPlugin({ deny: deps.pluginDeny ?? [], firstParty: names });
  // 守门器放最前，但它坐在 `prepend` —— 上面那条"座位比顺序更重要"在这里同样成立。
  const discovered = deps.discovered ?? [];

  return {
    plugins: [
      guard,
      // 守门器：只持有托管策略，读个人规则一个字都不读。
      createSecDefaultPlugin({ rules: deps.policy.policyRules }),
      ...firstParty,
      ...discovered,
    ],
    seating: {
      'plugin-guard': 'prepend',
      'sec-default': 'prepend',
      permissions: 'user',
    },
    // 座位不在这里给第三方钉：引擎按 `thirdParty` 名单**强制** append，
    // 连这张表都钉不动它们 —— 见 core/create.ts。
    thirdParty: discovered.map((plugin) => plugin.name),
  };
}
