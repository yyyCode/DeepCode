import type { Plugin } from '../contract/plugin';
import type { Message } from '../contract/model-provider';
import type { Tier } from '../contract/tier';
import type { AgentSpec, SkillSpec } from '../contract/agent';
import { coreTools } from '../builtins/tools';
import { confirmPlugin } from '../builtins/confirm';
import { commandsPlugin } from '../builtins/commands';
import { createPermissionsPlugin } from '../builtins/permissions';
import { createPluginGuardPlugin, type PluginDenyRule } from '../builtins/plugin-guard';
import { streamPlugin } from './stream';
import { createActivityPlugin } from './activity';
import { createChangesPlugin, type SessionChanges } from './changes';
import { createSessionCommands, type CommandDescription } from './commands';
import { createPermissionsCommand } from './permissions-command';
import { createConfigCommand } from './config-command';
import { createSubagentsPlugin } from './subagents';
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
  /**
   * 生效环境变量的快照（`main.ts` 算好的那一份，与 `createEngine` 收到的是同一个）。
   * `config-command` 靠它报每个配置项的**来源**。
   *
   * 不在这里自己读 `process.env`：那样测试就没法钉"环境变量盖过文件"这条规则，
   * 而且 CI 上残留的一个 `DEEPCODE_MODEL` 会让断言时红时绿。
   */
  readonly env: Record<string, string | undefined>;
  /** 已解析好的权限设置快照。/permissions 从它读，两个插件从它分规则。 */
  readonly policy: ResolvedPolicy;
  /** 规则里 `~` 展开用的主目录（在 settings.ts 解析时就用掉了）。 */
  readonly home: string;
  /** 本次会话的 id。遥测给每一行盖上它，好把同一场会话的行串起来。 */
  readonly sessionId: string;
  /**
   * 一条给人看的警告。遥测的记不进 / 写不进都从这儿出去 ——
   * 与 `main.ts` 里那个 `warnLine` 是同一个。
   *
   * ⚠️ 遥测的告警**只有一个出口**：这条协议里没有任何一条会被静默丢掉
   * （除了"开关关着"，而那不是丢弃，是没在记）。写坏的行会在这里说一声。
   */
  readonly warn: (line: string) => void;
  /** **已解析**的 agent 名册。发现是异步的、在 main.ts 里做完（设计 §4.1）。 */
  readonly agents: readonly AgentSpec[];
  /** **已解析**的技能名册。 */
  readonly skills: readonly SkillSpec[];
  /**
   * 会话那一份**基础** system prompt（`main.ts` 的 `SYSTEM_PROMPT` 常量，不是拼完那份）。
   * agent 正文为空时回落到它。给拼完的那份会递归 —— 拼完的那份里已经含着这儿的清单。
   */
  readonly baseSystemPrompt: string;
  /**
   * 从插件目录里发现并装载好的第三方插件。CLI 把它们**排在最后** ——
   * 座位由引擎强制成 `append`（见 core/third-party.ts），这里的顺序只在同 tier 内的
   * "谁在外层"上起作用，而插件之间按名字字典序（plugin-dir.ts 排好的）。
   */
  readonly discovered?: readonly Plugin[];
  /**
   * 内建 mod 贡献的插件（`loadMods(builtinMods())` 的结果）。
   *
   * ⚠️ **必填**，不给默认 `[]`：给默认值的话，"忘了接线"会表现成"内建 mod 全都不见了"
   * 而三条命令照样全绿 —— 与这个文件顶部记的那次事故（`turn.step` 的应答者没进清单，
   * 而 typecheck / lint / C1 / C2 全绿）同一种形状。
   *
   * 也**必须从这张表进来**，不能在外面拼到 `createEngine` 的 plugins 里：
   * 它们的名字要进 `names` 那份第一方豁免名单，否则一份个人配置里的
   * `plugins.deny: ["sec-default"]` 又能把承重墙拆了（P2 的 C3 实测过）。
   */
  readonly mods: readonly Plugin[];
  /** 五层合并后的 `plugins.deny`。交给 plugin-guard，CLI 自己不判。 */
  readonly pluginDeny?: readonly PluginDenyRule[];
  /**
   * 压缩入口（`/compact` 用）。**延迟取的回调**：压缩器要到 `createEngine` 之后才建得出来
   * （它需要 `dispatch`），而这张表是那之前装的 —— 与 `core/nouns/index.ts` 里那两个
   * `refs` 同一种写法。不给 = 没有 `/compact` 这条命令。
   */
  readonly compact?: () => Promise<void>;
  /**
   * 问一条命令它自己是什么（`/help` 用）。**同样是延迟取的回调** —— 它要派发
   * `command.describe`，而 `dispatch` 要到 `createEngine` 之后才拿得到。
   * 不给 = `/help` 照列名字，只是每行没有那句话。
   */
  readonly describeCommand?: (name: string) => Promise<CommandDescription>;
  /**
   * 内建 mod `diff` 装上了没有（P5c）。`/diff` 的应答者由它与 CLI **二选一** ——
   * 两条都在的话命令会打两遍。必填的理由写在 `cli/commands.ts` 那个字段的注释里。
   */
  readonly paneLoaded: boolean;
  /** `paneLoaded === false` 时 `/diff` 要多说的那一句（`cli/mods.ts` 的 `paneUnavailable`）。 */
  readonly paneUnavailable?: string;
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
    // 活动面（P6a）排在最外：它量的耗时要是**用户实际等的那个时间**，
    // 排在 session-changes 里面的话，快照文件那一段就不算数了。
    createActivityPlugin({ render: deps.render, palette: deps.palette }),
    // 个人规则：policy 之外的四个来源。
    createPermissionsPlugin({ rules: deps.policy.personalRules }),
    createChangesPlugin(deps.changes),
    ...coreTools,
    // 组合面：应答 agent.offer、注册 Task 与 Skill。放在工具这一串里，
    // 名字自动进下面的第一方名单（`names`），于是 deny 名单点它也没用。
    createSubagentsPlugin({
      agents: deps.agents,
      skills: deps.skills,
      baseSystemPrompt: deps.baseSystemPrompt,
    }),
    confirmPlugin,
    commandsPlugin,
    streamPlugin(deps.render),
    // /diff、/clear、/help 要碰渲染、会话状态或 dispatch，所以住在 cli/ 而不是 builtins/
    // （见 cli/commands.ts 顶部那段）。
    createSessionCommands({
      changes: deps.changes,
      messages: deps.messages,
      root: deps.root,
      palette: deps.palette,
      paneLoaded: deps.paneLoaded,
      ...(deps.paneUnavailable === undefined ? {} : { paneUnavailable: deps.paneUnavailable }),
      ...(deps.compact === undefined ? {} : { compact: deps.compact }),
      ...(deps.describeCommand === undefined ? {} : { describeCommand: deps.describeCommand }),
    }),
    // /permissions 同理。
    createPermissionsCommand({ policy: deps.policy, palette: deps.palette }),
    // /config，连带 config.describe / config.set 两个事件的应答者。
    // 座位不用特殊给（默认 builtin 就够）：它不裁决任何动作，只是读/写配置文件。
    createConfigCommand({ home: deps.home, root: deps.root, env: deps.env }),
  ];

  // 第一方名字**从这份清单推**，不另抄一份名单：抄一份的话，往上面加一个插件
  // 而忘了加到名单里，它的名字就不再享有第一方豁免 —— 而 deny 名单点到它时
  // 它就真的会被拦下（一份禁用名单从而又能拆承重墙了）。
  //
  // ⚠️ 内建 mod 的名字**必须一起算进来**。P5a 之前这里只有 `sec-default` 一个特例
  // （它当时不在 `firstParty` 数组里），漏掉它的后果是 C3 变异测试第 2 条实测出来的：
  // settings 里写一句 `plugins.deny: ["sec-default"]`，守门器当场不装 —— 一份**个人**
  // 配置文件就能把整套权限模型的承重墙拆了。P5a 之后四个 mod 都从外面进来，
  // 于是这一行从"一个特例"变成了"一件必须做对的事"：mod 的插件不走这份推演，
  // 就全都暴露在同一个洞上。
  //
  // `plugin-guard` 也列上，但它是**结构上**碰不到的：闸门坐数组第 0 位，内核问
  // "plugin-guard 能不能装"时它自己的 hook 还没注册，于是 deny 名单根本不会被问到。
  // 列上是为了让这条性质不依赖"闸门恰好排第一"这个顺序 —— 一旦它挪位，豁免仍然在。
  const names = [
    'plugin-guard',
    ...deps.mods.map((plugin) => plugin.name),
    ...firstParty.map((plugin) => plugin.name),
  ];
  const guard = createPluginGuardPlugin({ deny: deps.pluginDeny ?? [], firstParty: names });
  // 守门器放最前，但它坐在 `prepend` —— 上面那条"座位比顺序更重要"在这里同样成立。
  const discovered = deps.discovered ?? [];

  return {
    plugins: [
      guard,
      // 内建 mod。**整片排在 firstParty 之前**：`agents-md` 的嵌套 hook 必须在
      // `coreTools` 外层（同 tier 内先装载者在外层），而它就在这一片里 ——
      // 这条约束以前靠数组里那两行挨着保证，现在靠这里的拼接顺序保证。
      // `diff`（P5c）也搭在这一片上：它的 `/diff` 应答者要在 session-commands 之前，
      // 不过那一对今天靠 `paneLoaded` 二选一，不靠先后 —— 顺序是双保险。
      // 座位不在这里给（默认 builtin），只有 `sec-default` 例外，见下面 seating。
      ...deps.mods,
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
