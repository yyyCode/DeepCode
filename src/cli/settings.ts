import { isAbsolute, join, resolve } from 'node:path';
import type { McpServerConfig } from '../contract/mcp';
import { parseMcpServers } from '../mcp/config';
import {
  defaultManagedPath,
  ManagedError,
  readManagedSettings,
  type ManagedRun,
  type ManagedSource,
} from './managed';
import { defaultTextReader, type TextReader } from './text-reader';
import { isSupported, parseRule, type Behavior, type Rule } from '../contract/policy';
import type { ManagedInstruction } from '../contract/instructions';
import { sandboxRule, type SandboxConfig } from '../contract/sandbox';
import { isPluginName } from '../contract/plugin-manifest';
import { DEFAULT_TELEMETRY, type TelemetryPolicy } from '../contract/telemetry';
import { DEFAULT_CONTEXT_LAYERS, type ContextLayerConfig } from '../contract/context-window';
import { DEFAULT_MEMORY, type MemoryConfig } from '../contract/memory';

/**
 * 权限设置的五个来源，低 → 高。数组顺序就是 `/permissions` 的输出顺序。
 *
 * 这一层**刻意没有环境变量来源**：`config.json` 有，是因为"别把 key 写进文件"
 * 是真需求；权限不一样 —— 一个环境变量就能改掉权限，等于在规则引擎上开了个后门。
 * 托管策略必须来自文件。见设计 §4.4。
 */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const;
export type SettingsSource = (typeof SETTINGS_SOURCES)[number];

/** 一条插件规则：名字 + 它来自哪一层。`/permissions` 要把来源标出来。 */
export type PluginRule = {
  readonly name: string;
  readonly source: SettingsSource;
};

/** 一层设置里收下的插件名字。 */
export type PluginsLayer = {
  readonly enable: readonly string[];
  readonly deny: readonly string[];
};

const EMPTY_PLUGINS: PluginsLayer = { enable: [], deny: [] };

/**
 * `plugins.enable` 认哪几层。
 *
 * 少了 `user`：用户级目录本来就自动装载，写 enable 是没用的。
 * 少了 `policy`：托管策略写 enable 会变成"组织替你打开一个插件" ——
 * 托管策略只该能收紧，不该能替你打开东西（设计 §3）。
 *
 * ⚠️ **落点（`~/.deepcode/installed/`）是唯一的例外**：那一层只认用户层的 enable，
 * 走的是 `ResolvedPolicy.plugins.enableByUser`，不经这个常量（P4c 设计 §0 决策 3）。
 * 所以 user 层的 enable 名字**会被读进来**，只是不进这里合并出的那个名单 ——
 * 看起来像 bug，不是 bug。
 */
export const PLUGIN_ENABLE_SOURCES = ['project', 'local', 'flag'] as const;

/**
 * 压缩偏好。
 *
 * 它**不是权限**，挤进这份快照只是因为 `resolvePolicy` 是唯一走完五层的地方 ——
 * 为它再写一遍五层遍历，就多一处会漂的顺序。
 */
export type CompactConfig = {
  /** 自动压缩。**默认关** —— 阈值是猜的，静默丢细节不能是默认行为。 */
  readonly auto: boolean;
  /** 跨过这个数就出声（`auto: true` 时顺手压）。**这个默认值是猜的**，见 README 的限制。 */
  readonly atTokens: number;
  /** 压缩时保留最近几轮的原文。一轮 = 一条 `role === 'user'` 消息及其之后的一切。 */
  readonly keepTurns: number;
  /**
   * 第 1–4 层的旋钮（P11）。省略 = 全用 `DEFAULT_CONTEXT_LAYERS`。
   * 阈值全部是 `atTokens` 的比例 —— 我们不发明模型窗口。
   */
  readonly layers?: Partial<ContextLayerConfig>;
};

export const DEFAULT_COMPACT: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 6 };

/** 沙箱没开、也没有任何规则。 */
export const EMPTY_SANDBOX: SandboxConfig = { enabled: false, deny: [], allow: [] };

/**
 * 遥测开关。**只有用户层能开、托管层能关**（设计 §6.4）：
 *
 *   enabled = (用户层 === true) && (托管层 !== false)
 *
 * 一个克隆下来的仓库不该悄悄打开你的遥测 —— 与 `plugins.enableByUser` 完全同构。
 * 托管层那句话压过用户层，是"只能更严"在这份设置上的落法：它管不了你开不开，
 * 但能一句话把它关掉。
 *
 * ⚠️ **只有 user 与 policy 两层有话可说**，project / local / flag 写了会被丢弃并出声 ——
 * 与 `plugins.enable` 同一条道理：让别人仓库里的一份文件替你按下开关，
 * 正是"个人配置掀翻托管策略"的入场券。
 */
// 形状搬进了契约（P5a）：`mods/telemetry` 要用它，而 mod 只许 import 契约。
// 这里原样再导出，是为了**不改任何一处既有 import** —— 从 settings 取这个类型/默认值
// 仍然是有效的写法，只是它现在不是定义地了。
export type { TelemetryPolicy } from '../contract/telemetry';
export { DEFAULT_TELEMETRY } from '../contract/telemetry';

/** 一层的 `telemetry` 段：只存这一层**写了**的字段。 */
type TelemetryLayer = { readonly enabled?: boolean };

/** 一层的 `sandbox` 段解析结果。`enabled` 是各层的**或**，所以逐层分开存。 */
type SandboxLayer = {
  readonly enabled: boolean;
  readonly deny: readonly Rule[];
  readonly allow: readonly Rule[];
};
const EMPTY_SANDBOX_LAYER: SandboxLayer = { enabled: false, deny: [], allow: [] };

/** 什么都没钉。绝大多数机器、以及一切非 policy 层。 */
const EMPTY_GATEWAY: GatewayConfig = {};

/**
 * 出网位置（P5d）。**只有托管层能写** —— 与 `sandbox.paths.allow`、`instructions` 同形。
 *
 * 这是"个人规则掀不翻托管策略"在**出网位置**上的落法：组织把所有人指到自己的网关上，
 * 员工绕不过去。它钉的是"发给哪"（端点），不是"发给谁"（凭据）——
 * `apiKey` 仍然按原样解析，托管层钉钥匙既不该做也没有意义。
 */
export type GatewayConfig = {
  readonly baseUrl?: string;
  readonly model?: string;
};

/** 一层的 `compact` 段：只存这一层**写了**的字段。 */
type CompactLayer = Partial<CompactConfig>;

/** 一层的 `memory` 段：只存这一层**写了**的字段。合并规矩同 `compact`。 */
type MemoryLayer = Partial<MemoryConfig>;

/** 认得出来的顶层键。**加一个顶层块就得加一项** —— 漏了就是给用户发一条假警告。 */
const KNOWN_TOP_LEVEL = new Set([
  'permissions',
  'plugins',
  'mcpServers',
  'sandbox',
  'compact',
  'memory',
  'telemetry',
  'instructions',
  'gateway',
]);

export type SourceInfo = {
  readonly source: SettingsSource;
  /** 这一层实际读的路径。`flag` 没给 `--settings=` 时是 undefined。 */
  readonly path: string | undefined;
  readonly state: 'missing' | 'ok' | 'broken';
  /** `state === 'broken'` 时的原因，直接给人看。 */
  readonly error?: string;
  readonly counts: { allow: number; ask: number; deny: number };
  /** 逐条规则的问题（含原文与原因）。有问题不等于整个文件坏掉。 */
  readonly problems: readonly string[];
  /** 这一层真正收下的规则。/permissions 要用它标出每条规则来自哪一层。 */
  readonly rules: readonly Rule[];
  /** 这一层收下的插件名字。`/permissions` 按层标出来。 */
  readonly plugins: PluginsLayer;
};

export type ResolvedPolicy = {
  readonly sources: readonly SourceInfo[];
  /** **只**来自 policy 源。给 sec-default。 */
  readonly policyRules: readonly Rule[];
  /** 其余四源的并集。给 permissions。 */
  readonly personalRules: readonly Rule[];
  /**
   * 五层合并后的插件名单，带来源。
   *
   * `enable` 只来自 project / local / flag；`deny` 来自五层并集 ——
   * 它只能关掉东西，永远不可能放宽，于是"谁写的"对结果毫无影响。
   *
   * `enableByUser` 是**唯一**认用户层的一处，而它只管落点
   * `~/.deepcode/installed/`（设计 §0 决策 3）。这个不对称不是疏漏：
   * 把落点并进上面那个名单，别人仓库里的 settings.json 就能按名字点亮你全局装的东西。
   */
  readonly plugins: {
    readonly enable: readonly PluginRule[];
    readonly enableByUser: readonly string[];
    readonly deny: readonly PluginRule[];
  };
  /**
   * 用户级 `mcpServers` 里能启动的 server（P16）。
   *
   * **只来自 user 层**：项目 / local / flag / 托管层写了会在解析期整块丢弃并出声。
   * 一个 clone 下来的仓库不该因为打开它就跑一个外部进程 —— 与 telemetry
   * （只有用户层能开）、gateway（只有托管层能钉）同一条方向。
   */
  readonly mcpServers: readonly McpServerConfig[];
  /**
   * 沙箱。规则与权限规则**同一套**（`contract/policy.ts`），只是判定落在 `process` 名词里。
   */
  readonly sandbox: SandboxConfig;
  /**
   * 压缩偏好。它不是权限 —— 挤在这份"权限快照"里只因为 `resolvePolicy` 是唯一走完五层的地方。
   */
  readonly compact: CompactConfig;
  /**
   * 记忆系统（P12）。与 `compact` 同一种东西：不是权限，挤进来只因为这里走完了五层。
   */
  readonly memory: MemoryConfig;
  /**
   * 遥测开关。同样是"挤进来"的：只有 user 与 policy 两层能说话，
   * 但判定要用到五层读完之后的结论。
   */
  readonly telemetry: TelemetryPolicy;
  /**
   * 托管层下发的指令段（P5b）。**只有 policy 一层能写** —— 与 `sandbox.paths.allow`、
   * `plugins.enable`（托管层写了会被丢）同一条规矩：让一份克隆下来的仓库文件
   * 往你每一次系统提示里塞一段话，正是"个人配置掀翻托管策略"的入场券。
   *
   * 它不在这里拼进提示：提示是插件的活。这一段作为**数据**进 `ModDeps`
   * 交给 `agents-md` mod（`main.ts` 那一行）。
   */
  readonly instructions: readonly ManagedInstruction[];
  /**
   * 托管层钉死的出网位置（P5d）。默认 `{}`（谁都没钉）。
   *
   * 与 `instructions` 同一条规矩：**只有 policy 一层能写**，别的层写了整项丢弃并出声。
   * 合并不用"后写覆盖先写" —— 那是 compact 的规矩；这里只有一个来源，没有方向问题。
   */
  readonly gateway: GatewayConfig;
};

/**
 * 读一个文本文件。两种失败必须分得开：
 * - 返回 `undefined` = 文件**不存在**（正常，绝大多数机器没有托管文件）
 * - **抛** = 文件存在但读不了（权限、是个目录、编码）—— 这一条是设计里唯一的 fail-open，要吼
 *
 * P5d 起它住在 `text-reader.ts`（托管通道也要读文件，而这里要 import 托管通道 ——
 * 留在原地就成了循环）。**原样再导出**：既有 import 一处都不用改。
 */
export type { TextReader } from './text-reader';
export { defaultTextReader } from './text-reader';

// 托管策略的位置同上：P5d 起住在 `managed.ts`（那里是通道表），这里再导出一次。
export { defaultManagedPath } from './managed';

export type ResolvePolicyDeps = {
  readonly home: string;
  readonly root: string;
  /** `--settings=<路径>` 的取值。相对路径按 cwd 解析，与 `--resume=<id>` 同一个规矩。 */
  readonly settingsPath?: string;
  /** 覆盖托管文件位置（`DEEPCODE_MANAGED_SETTINGS` 从这进）。 */
  readonly managedPath?: string;
  /** 托管通道要看的环境变量与平台（P5d）。都可注入 —— 判据要的是夹具，不是真机。 */
  readonly env?: Record<string, string | undefined>;
  readonly platform?: string;
  /** 托管通道跑外部命令的方式（注册表 / 偏好域 / 默认文件）。 */
  readonly run?: ManagedRun;
  readonly warn?: (line: string) => void;
  readonly readText?: TextReader;
};

const EMPTY_COUNTS = { allow: 0, ask: 0, deny: 0 } as const;

function label(source: SettingsSource): string {
  return source === 'policy' ? '⚠️ 托管策略' : `[权限] ${source} 设置`;
}

type Layer = {
  readonly source: SettingsSource;
  readonly path: string | undefined;
  /**
   * 内容**已经拿到了**（P5d 的托管通道），不走 `readText`。
   *
   * `path` 那时只是"它从哪来"的一句人话（`注册表 HKLM\SOFTWARE\DeepCode` 这种），
   * 给 `/permissions` 显示用 —— 不是一个能 `readFile` 的路径。
   */
  readonly text?: string;
  /**
   * 托管通道读不动（文件存在但读不了 / 解析器撞上读不懂的东西）。
   *
   * 必须走这一格而不是让异常穿出去：托管层是设计里**唯一**的 fail-open ——
   * 吼一声、按空处理、照旧启动。异常穿出去的话，一行配错的托管策略会让 CLI 起不来，
   * 方向正好反过来。
   */
  readonly readError?: string;
};

export async function resolvePolicy(deps: ResolvePolicyDeps): Promise<ResolvedPolicy> {
  const warn = deps.warn ?? (() => {});
  const readText = deps.readText ?? defaultTextReader;

  // 托管层的内容**不一定在文件里**（P5d 三通道）。先把那段文本拿到手，再让 `readLayer`
  // 照旧按"一段文本"处理它 —— 下游一个字节都不用改。
  let managed: ManagedSource | undefined;
  let managedError: string | undefined;
  let managedWhere: string | undefined;
  try {
    managed = await readManagedSettings({
      env: deps.env,
      platform: deps.platform,
      path: deps.managedPath,
      readText,
      ...(deps.run === undefined ? {} : { run: deps.run }),
    });
  } catch (error) {
    // ⚠️ 接住，**不让它穿出去**。托管层是设计里唯一的 fail-open：读得动但读不懂、
    // 或文件存在但读不了，都要"吼一声、按空处理、照旧启动"。异常穿出去的话，
    // 一行配错的托管策略会让 CLI 起不来 —— 方向正好反过来。
    managedError = error instanceof Error ? error.message : String(error);
    // 连"从哪条通道来的"一起接住：不然下面那句警告会指着一个默认文件路径，
    // 而真正出问题的是注册表 —— 让人往错的地方查。
    if (error instanceof ManagedError) managedWhere = error.where;
  }

  const layers: readonly Layer[] = [
    { source: 'user', path: join(deps.home, '.deepcode', 'settings.json') },
    { source: 'project', path: join(deps.root, '.deepcode', 'settings.json') },
    { source: 'local', path: join(deps.root, '.deepcode', 'settings.local.json') },
    {
      source: 'flag',
      path: deps.settingsPath === undefined ? undefined : resolve(deps.settingsPath),
    },
    {
      source: 'policy',
      // 没找着内容时也要报出"本来该看哪儿"（默认路径）。`--settings=` 那种"指了但没读着"
      // 与"根本没配"在 `/permissions` 里必须看得出区别 —— 与 `flag` 那一层同一个道理。
      path:
        deps.managedPath ??
        managed?.where ??
        managedWhere ??
        defaultManagedPath(deps.env, deps.platform),
      ...(managed === undefined ? {} : { text: managed.text }),
      ...(managedError === undefined ? {} : { readError: managedError }),
    },
  ];

  const sources: SourceInfo[] = [];
  const bySource = new Map<SettingsSource, readonly Rule[]>();
  const pluginsBySource = new Map<SettingsSource, PluginsLayer>();
  const sandboxLayers = new Map<SettingsSource, SandboxLayer>();
  const compactLayers = new Map<SettingsSource, CompactLayer>();
  const memoryLayers = new Map<SettingsSource, MemoryLayer>();
  const telemetryLayers = new Map<SettingsSource, TelemetryLayer>();
  const instructionLayers = new Map<SettingsSource, readonly ManagedInstruction[]>();
  const gatewayBySource = new Map<SettingsSource, GatewayConfig>();
  const mcpBySource = new Map<SettingsSource, readonly McpServerConfig[]>();

  for (const layer of layers) {
    const read = await readLayer(layer, deps.home, deps.root, deps.env ?? {}, warn, readText);
    sources.push(read.info);
    bySource.set(layer.source, read.rules);
    pluginsBySource.set(layer.source, read.plugins);
    sandboxLayers.set(layer.source, read.sandbox);
    compactLayers.set(layer.source, read.compact);
    memoryLayers.set(layer.source, read.memory);
    telemetryLayers.set(layer.source, read.telemetry);
    instructionLayers.set(layer.source, read.instructions);
    gatewayBySource.set(layer.source, read.gateway);
    mcpBySource.set(layer.source, read.mcpServers);
  }

  const withSource = (source: SettingsSource, names: readonly string[]): readonly PluginRule[] =>
    names.map((name) => ({ name, source }));

  // ── 沙箱 ──
  // `deny` 各层**取并集**：任何来源都能往这儿加，它只会让闸更严。
  // `allow` **只有托管层能设** —— 与 `plugins.enable` 同一条道理：让个人配置能写白名单，
  // 等于让它一句话掀掉托管策略设的圈。
  // `enabled` 是各层的**或**：开闸只能靠有人明确要开，没有默认值能把它悄悄打开；
  // 而"个人想关掉托管打开的闸"正是"个人掀翻托管"，方向不对。
  const sandbox: SandboxConfig = {
    enabled: SETTINGS_SOURCES.some((source) => sandboxLayers.get(source)?.enabled === true),
    deny: SETTINGS_SOURCES.flatMap((source) => sandboxLayers.get(source)?.deny ?? []),
    allow: sandboxLayers.get('policy')?.allow ?? [],
  };
  for (const source of SETTINGS_SOURCES) {
    if (source === 'policy') continue;
    if ((sandboxLayers.get(source)?.allow.length ?? 0) > 0) {
      warn(`${label(source)} 里写了 sandbox.paths.allow —— 白名单只有托管层能设，这一份已丢弃。`);
    }
  }

  // ── 压缩偏好 ──
  // 后读到的覆盖先读到的（数组顺序就是低 → 高）。它没有"更严/更松"的方向，
  // 硬套权限那一套只会造出一条解释不通的规则。
  //
  // `layers` 要**逐字段**合并，不能用 `Object.assign(compact, layer)`：后者会把高层的
  // `layers` 整个换掉，于是低层设的 `snipAtRatio` 被高层只设 `microKeepRecent` 的一份
  // 配置抹掉 —— 一份只写了一个字段的设置不该把别的字段打回默认。
  const merged = {
    auto: DEFAULT_COMPACT.auto,
    atTokens: DEFAULT_COMPACT.atTokens,
    keepTurns: DEFAULT_COMPACT.keepTurns,
    layers: {} as Partial<ContextLayerConfig>,
  };
  for (const source of SETTINGS_SOURCES) {
    const layer = compactLayers.get(source) ?? {};
    const { layers: layerLayers, ...rest } = layer;
    Object.assign(merged, rest);
    if (layerLayers !== undefined) Object.assign(merged.layers, layerLayers);
  }
  // 没有任何一层写过 `layers` 时不塞一个空对象：`CompactConfig` 里它是可选的，
  // 多出来的 `layers: {}` 会让"没配过"和"配了个空"在深比较与序列化里长得不一样。
  const { layers: mergedLayers, ...compactBase } = merged;
  const compact: CompactConfig =
    Object.keys(mergedLayers).length === 0 ? compactBase : { ...compactBase, layers: mergedLayers };

  // ── 记忆 ──
  // 与 compact 同一套：后读到的覆盖先读到的，逐字段合并。
  // `enabled: false` 在高层生效时**不**把低层也抹成空 —— 整块关掉就够了，
  // 剩下的字段只在重新打开时才有意义。
  let memory: MemoryConfig = { ...DEFAULT_MEMORY };
  for (const source of SETTINGS_SOURCES) {
    // `readMemory` 只放已经认过的键，所以这里整块铺开是安全的。
    memory = { ...memory, ...(memoryLayers.get(source) ?? {}) };
  }

  // ── 遥测 ──
  // ⚠️ **不是**"后读到的覆盖先读到的"（那是 compact 的规矩）。这里只有两个方向：
  // 用户层能把它打开，托管层能把它关掉 —— 个人配置在这件事上**没有**说话的份。
  // project / local / flag 写了会被 `readTelemetry` 丢掉并出声，走不到这儿。
  const telemetry: TelemetryPolicy =
    telemetryLayers.get('user')?.enabled !== true
      ? DEFAULT_TELEMETRY
      : telemetryLayers.get('policy')?.enabled === false
        ? { enabled: false, why: '托管层把它关了（压过用户层）' }
        : { enabled: true, why: '用户层开了' };

  return {
    sources,
    // policy 源 vs. 其余全部 —— 在固定优先级下这是唯一承重的划分（设计 §4.3）。
    policyRules: bySource.get('policy') ?? [],
    personalRules: SETTINGS_SOURCES.filter((s) => s !== 'policy').flatMap((s) => bySource.get(s) ?? []),
    // 只有 user 层收下；其余层的丢弃与警告发生在 readMcpServers 里。
    mcpServers: mcpBySource.get('user') ?? [],
    plugins: {
      enable: dedupe(
        PLUGIN_ENABLE_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.enable ?? []),
        ),
      ),
      // 用户层**不经** PLUGIN_ENABLE_SOURCES，直接取那一层读到的名字。
      // 它只喂落点，不会让 ~/.deepcode/plugins/ 里的东西被启用 —— 上面那个 flatMap
      // 只看 PLUGIN_ENABLE_SOURCES，所以这条路径改不了那里的行为。
      // 去重是因为它是给 discoverPlugins 的 includes 用的：重复项无害，但显示会难看。
      enableByUser: [...new Set(pluginsBySource.get('user')?.enable ?? [])],
      deny: dedupe(
        SETTINGS_SOURCES.flatMap((source) =>
          withSource(source, pluginsBySource.get(source)?.deny ?? []),
        ),
      ),
    },
    sandbox,
    compact,
    memory,
    telemetry,
    // 只有托管层的话能到这儿 —— 别的层写了会在 readInstructions 里被丢掉并出声。
    // 不必像 sandbox 那样再遍历一遍其余四层：丢弃就发生在解析那一层，
    // 这里取 policy 那一份就是全部（不并集，也不覆盖）。
    instructions: instructionLayers.get('policy') ?? [],
    // 同上：只有托管层的话能到这儿 —— 别的层写了会在 readGateway 里被丢掉并出声。
    gateway: gatewayBySource.get('policy') ?? EMPTY_GATEWAY,
  };
}

/** 按名字去重，保留先出现的那个来源。合并语义是并集，留谁都不改行为，只影响 /permissions 的显示。 */
function dedupe(rules: readonly PluginRule[]): readonly PluginRule[] {
  const seen = new Set<string>();
  const out: PluginRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    out.push(rule);
  }
  return out;
}

type LayerRead = {
  readonly info: SourceInfo;
  readonly rules: readonly Rule[];
  readonly plugins: PluginsLayer;
  readonly sandbox: SandboxLayer;
  readonly compact: CompactLayer;
  readonly memory: MemoryLayer;
  readonly telemetry: TelemetryLayer;
  readonly instructions: readonly ManagedInstruction[];
  /**
   * 托管层钉死的出网位置（P5d）。**按层收**，合并时只取 policy 那一份 ——
   * 与 `instructions` 一样：丢弃发生在解析那一层，这里不必再遍历一遍。
   */
  readonly gateway: GatewayConfig;
  /** 这一层收下的 MCP server。只有 user 层可能非空（P16）。 */
  readonly mcpServers: readonly McpServerConfig[];
};

async function readLayer(
  layer: Layer,
  home: string,
  root: string,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
  readText: TextReader,
): Promise<LayerRead> {
  const where = layer.path;
  const preloaded = layer.text;

  if (where === undefined && preloaded === undefined) {
    return {
      info: base(layer, 'missing', undefined, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
      memory: {},
      telemetry: {},
      instructions: [],
      gateway: EMPTY_GATEWAY,
      mcpServers: [],
    };
  }

  const origin = where ?? '（内容由通道给出）';

  const broken = (error: string): LayerRead => {
    warn(`${label(layer.source)} ${origin} ${error} —— 这一层按空处理。`);
    return {
      info: base(layer, 'broken', error, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
      memory: {},
      telemetry: {},
      instructions: [],
      gateway: EMPTY_GATEWAY,
      mcpServers: [],
    };
  };

  // 托管通道抛出来的异常由 `resolvePolicy` 接住、塞进这一格（见那里的注释）。
  // 走 `broken` 而不是原样抛出去：吼一声、记成 `broken`、这一层按空处理、照旧启动。
  if (layer.readError !== undefined) return broken(layer.readError);

  let text: string | undefined;
  try {
    // 托管通道已经把内容读出来了（P5d）—— 那段文本就是 `preloaded`，
    // `where` 这时只是一句"它从哪来"。两条路在这里合流，下游一条都不用改。
    // （上面那个 early return 保证了这两者至少有一个是有的。）
    text = preloaded ?? (where === undefined ? undefined : await readText(where));
  } catch (error) {
    return broken(`读不了（${error instanceof Error ? error.message : String(error)}）`);
  }
  // 不存在 = 静默为空。绝大多数机器没有托管文件，为此吼一声只会训练人无视警告。
  if (text === undefined) {
    return {
      info: base(layer, 'missing', undefined, [], []),
      rules: [],
      plugins: EMPTY_PLUGINS,
      sandbox: EMPTY_SANDBOX_LAYER,
      compact: {},
      memory: {},
      telemetry: {},
      instructions: [],
      gateway: EMPTY_GATEWAY,
      mcpServers: [],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return broken(`JSON 语法错（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return broken('顶层不是一个对象');
  }

  const record = data as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => !KNOWN_TOP_LEVEL.has(key));
  if (unknown.length > 0) {
    // 未知键只警告、不致命：将来加顶层键（hooks、env）时，旧版本读新文件不该整份失效。
    warn(`${label(layer.source)} ${origin} 里有不认识的顶层键：${unknown.join('、')}（已忽略）。`);
  }

  const raw = record.permissions;

  // ⚠️ plugins 必须在 permissions 的早期 return **之前**解析。写成"先 permissions、
  // 没有就 return"的话，一份只有 plugins 段（没有 permissions）的设置会把名单丢掉 ——
  // 而那正是最典型的一份"我只想启个插件"的设置文件。
  const plugins = readPlugins(record.plugins, layer, origin, warn);
  if ('broken' in plugins) return broken(plugins.broken);

  // ⚠️ 与 plugins 同一个道理：这两块必须在 permissions 的早期 return **之前**解析，
  // 否则一份只有 sandbox 段、没有 permissions 段的设置会把闸丢掉。
  const sandbox = readSandbox(record.sandbox, layer, origin, home, warn);
  const compact = readCompact(record.compact, layer, origin, warn);
  const memory = readMemory(record.memory, layer, origin, warn);
  // 同在 permissions 的早期 return 之前 —— 一份只写 telemetry 的设置文件不该被丢掉。
  const telemetry = readTelemetry(record.telemetry, layer, origin, warn);
  // ⚠️ 与 plugins / sandbox / telemetry 同一条：**必须在 permissions 的早期 return
  // 之前**。一份只写了 instructions、没有 permissions 的托管设置不该被丢掉 ——
  // 而"组织只下发了一段话"恰恰是最典型的那一种。这一格踩过同一个坑，别再踩。
  const instructions = await readInstructions(record.instructions, layer, origin, warn, readText);
  // ⚠️ 与 plugins / sandbox / telemetry / instructions 同一条：**必须在 permissions 的
  // 早期 return 之前**。一份只写了 gateway、没有 permissions 的托管设置不该被丢掉。
  const gateway = readGateway(record.gateway, layer, origin, warn);
  // ⚠️ 同一条：必须在 permissions 的早期 return 之前。一份只写 mcpServers、
  // 没有 permissions 的用户级设置，正是最典型的一份「我只想接个 MCP server」。
  const mcpServers = readMcpServers(record.mcpServers, layer, origin, { home, root, env }, warn);

  if (raw === undefined) {
    return {
      info: base(layer, 'ok', undefined, [], [], plugins.value),
      rules: [],
      plugins: plugins.value,
      sandbox,
      compact,
      memory,
      telemetry,
      instructions,
      gateway,
      mcpServers,
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return broken('permissions 不是一个对象');
  }

  const perms = raw as Record<string, unknown>;
  const counts = { allow: 0, ask: 0, deny: 0 };
  const problems: string[] = [];
  const rules: Rule[] = [];

  for (const key of ['allow', 'ask', 'deny'] as const) {
    const value = perms[key];
    if (value === undefined) continue;

    if (!Array.isArray(value)) return broken(`permissions.${key} 不是数组`);

    const bad = value.findIndex((item) => typeof item !== 'string');
    // 整份文件作废，而不是只丢这一条：类型不对说明写的人以为它生效了。
    // 只丢一半的话，他会看到"文件被读进去了"，然后以为没报错的那几行在管事。
    if (bad !== -1) return broken(`permissions.${key}[${bad}] 不是字符串`);

    for (const text_ of value as string[]) {
      const parsed = parseRule(text_, key, home);
      if ('error' in parsed) {
        // 唯一一处"坏了就等于没写"：方向是**不收紧**，所以必须吼，不能安静。
        problems.push(`${key}: ${JSON.stringify(text_)} —— ${parsed.error}`);
        continue;
      }
      if (!isSupported(parsed)) {
        problems.push(
          `${key}: ${JSON.stringify(text_)} —— ${parsed.tool} 的参数匹配不支持，这条永远不会命中`,
        );
        continue;
      }
      rules.push(parsed);
      counts[key] += 1;
    }
  }

  for (const problem of problems) {
    warn(`${label(layer.source)} ${origin} 这条不生效 —— ${problem}`);
  }

  return {
    info: base(layer, 'ok', undefined, problems, rules, plugins.value),
    rules,
    plugins: plugins.value,
    sandbox,
    compact,
    memory,
    telemetry,
    instructions,
    gateway,
    mcpServers,
  };
}

/**
 * 解析一层的 `plugins` 段。
 *
 * 形状错的处置与 `permissions` 完全一致：**整份废掉这一层**，不是丢掉坏的那一项 ——
 * 类型不对说明写的人以为它生效了，只丢一半的话他会看到"文件被读进去了"。
 * 名字格式不对则是单条不生效（方向是不收紧），但必须吼。
 */
function readPlugins(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): { readonly value: PluginsLayer } | { readonly broken: string } {
  if (value === undefined) return { value: EMPTY_PLUGINS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { broken: 'plugins 不是一个对象' };
  }

  const record = value as Record<string, unknown>;
  const out: { enable: string[]; deny: string[] } = { enable: [], deny: [] };

  for (const key of ['enable', 'deny'] as const) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { broken: `plugins.${key} 不是数组` };

    const bad = list.findIndex((item) => typeof item !== 'string');
    if (bad !== -1) return { broken: `plugins.${key}[${bad}] 不是字符串` };

    for (const name of list as string[]) {
      if (!isPluginName(name)) {
        warn(
          `${label(layer.source)} ${where} 这条不生效 —— plugins.${key}: ${JSON.stringify(name)} 不是 kebab-case 的插件名。`,
        );
        continue;
      }
      // ⚠️ 托管层照旧丢掉，user 层**必须收下** —— 两条路从这一轮起不一样了。
      // user 层的 enable 是落点唯一的开关（设计 §0 决策 3），所以这个名字得落到本层的
      // `enable` 里，好让 `enableByUser` 取得到它。它仍然进不了**合并后**的
      // `plugins.enable`：那一步只走 PLUGIN_ENABLE_SOURCES（settings.ts:230-241）。
      // 改之前这里是一句"不认识就 continue"，于是"收下"这件事在代码里根本不存在 ——
      // 直接加 enableByUser 会**静默得到空数组**，而且测试也发现不了。
      if (key === 'enable' && layer.source === 'policy') {
        warn(
          `${label(layer.source)} ${where} 这条不生效 —— plugins.enable 不认托管层（托管策略只该能收紧，不该替你打开一个插件）。`,
        );
        continue;
      }
      if (key === 'enable' && layer.source === 'user') {
        warn(
          `${label(layer.source)} ${where} 的用户级这一条对自动装载目录不生效 —— ` +
            `plugins.enable 不认 user 层的 ~/.deepcode/plugins/（用户级插件本来就自动装载）；` +
            `它唯一管用的是落点 ~/.deepcode/installed/：那里的插件只认这一层。`,
        );
      }
      out[key].push(name);
    }
  }

  const unknown = Object.keys(record).filter((key) => key !== 'enable' && key !== 'deny');
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 plugins 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return { value: out };
}

/**
 * 解析一层的 `sandbox` 段。
 *
 * 形状错的处置**与 `permissions` 不同**：这里只丢掉这一层这一块，不废掉整份文件。
 * 理由：沙箱是"多一道闸"，不是"判定权限"。猜一个更严的会把用户的正常命令全拒掉
 * （比不沙箱更糟），猜松则等于没配 —— **读不懂就不动**，与 `parseRule`
 * 对不认识的规则的处理一致。
 */
function readSandbox(
  value: unknown,
  layer: Layer,
  where: string,
  home: string,
  warn: (line: string) => void,
): SandboxLayer {
  const ignore = (why: string): SandboxLayer => {
    warn(`${label(layer.source)} ${where} 的 sandbox 块整块忽略 —— ${why}`);
    return EMPTY_SANDBOX_LAYER;
  };

  if (value === undefined) return EMPTY_SANDBOX_LAYER;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ignore('不是一个对象');

  const record = value as Record<string, unknown>;

  let enabled = false;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') return ignore('enabled 不是布尔值');
    enabled = record.enabled;
  }

  let deny: readonly Rule[] = [];
  let allow: readonly Rule[] = [];

  const paths = record.paths;
  if (paths !== undefined) {
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
      return ignore('paths 不是一个对象');
    }
    const list = paths as Record<string, unknown>;

    const denyRules = readSandboxList(list.deny, layer, where, home, 'deny', warn);
    if (denyRules === undefined) return ignore('paths.deny 不是字符串数组');
    const allowRules = readSandboxList(list.allow, layer, where, home, 'allow', warn);
    if (allowRules === undefined) return ignore('paths.allow 不是字符串数组');
    deny = denyRules;
    allow = allowRules;

    const unknown = Object.keys(list).filter((key) => key !== 'deny' && key !== 'allow');
    if (unknown.length > 0) {
      warn(`${label(layer.source)} ${where} 的 sandbox.paths 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
    }
  }

  const unknownTop = Object.keys(record).filter((key) => key !== 'enabled' && key !== 'paths');
  if (unknownTop.length > 0) {
    warn(`${label(layer.source)} ${where} 的 sandbox 里有不认识的子键：${unknownTop.join('、')}（已忽略）。`);
  }

  return { enabled, deny, allow };
}

/**
 * 一条沙箱路径列表。形状不对返回 `undefined`（调用方**整块忽略**）；
 * 单条规则坏了只丢那一条（方向是**不收紧**，所以必须出声 —— 与 permissions 同一条）。
 */
function readSandboxList(
  value: unknown,
  layer: Layer,
  where: string,
  home: string,
  key: 'deny' | 'allow',
  warn: (line: string) => void,
): Rule[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;

  const out: Rule[] = [];
  for (const text of value as string[]) {
    const trimmed = text.trim();
    if (trimmed === '') {
      warn(`${label(layer.source)} ${where} 这条不生效 —— sandbox.paths.${key} 里有一条是空的。`);
      continue;
    }
    // 判定的候选**一律**被解析成绝对路径，所以相对路径的规则永远不命中。
    // 静默失效比拒收更坏：写的人会以为自己在防一件其实没防的事。
    if (!isAbsoluteLike(trimmed)) {
      warn(
        `${label(layer.source)} ${where} 这条不生效 —— sandbox.paths.${key} 里的 ${JSON.stringify(text)} 不是绝对路径（\`~\` 可以），相对路径在判定时无从解析。`,
      );
      continue;
    }
    out.push(sandboxRule(text, key, home));
  }
  return out;
}

/** 绝对路径式：`/…`、`~/…`、`C:/…`（反斜杠也认，`sandboxRule` 里会统一）。 */
function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 解析一层的 `gateway` 段（P5d）。**只有托管层收下**，别的层写了就整项丢掉并出声。
 *
 * 方向与 `sandbox.paths.allow`（白名单）、`instructions`（托管指令）完全一样：
 * 出网位置是组织的事，个人配置能改的只有"发给谁"（凭据）。让一份**克隆下来的仓库文件**
 * 把你每一次模型请求改道到一个你没听说过的端点，正是这条规矩要防的那件事 ——
 * 而那正是"个人配置掀翻托管策略"里最锋利的一种：策略还在，只是不再决定你连哪儿。
 *
 * 形状错的处置照 `instructions`：**整项丢弃并出声**，不逐字段降级 ——
 * 一个"半生效"的网关比一个没生效的更坏（请求去了一半的地方，另一半还去了老地方）。
 */
function readGateway(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): GatewayConfig {
  if (value === undefined) return EMPTY_GATEWAY;

  if (layer.source !== 'policy') {
    warn(`${label(layer.source)} 里写了 gateway —— 出网位置只有托管层能钉，这一份已丢弃。`);
    return EMPTY_GATEWAY;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 gateway 块整块忽略 —— 不是一个对象。`);
    return EMPTY_GATEWAY;
  }

  const record = value as Record<string, unknown>;
  const out: { baseUrl?: string; model?: string } = {};
  for (const key of ['baseUrl', 'model'] as const) {
    const item = record[key];
    if (item === undefined) continue;
    // 空串比"没写"更坏：它会让 `applyManagedGateway` 钉一个空端点。当成没写 + 出声。
    if (typeof item !== 'string' || item.trim() === '') {
      warn(`${label(layer.source)} ${where} 的 gateway.${key} 不是非空字符串（已忽略）。`);
      continue;
    }
    out[key] = item.trim();
  }

  const unknown = Object.keys(record).filter((key) => key !== 'baseUrl' && key !== 'model');
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 gateway 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return out;
}

/**
 * 解析一层的 `mcpServers` 段。**只有 user 层收下**（P16 的信任决定）。
 *
 * 别的层写了不是"无效"，是**危险**：`.deepcode/settings.json` 会跟着仓库走，
 * 一份克隆下来的仓库就能让 `git clone && deepcode` 在你的机器上执行任意命令。
 * 这与 gateway 只有托管层能钉是同一条理由，方向更硬 —— gateway 改的是流量，这里改的是进程。
 * 所以别的层一律丢弃并出声，不让它安静地"看起来生效了"。
 *
 * 形状错由 `parseMcpServers` 处置（逐台跳过 + 点名），与这里"整层丢弃"的决定分开：
 * 跨层的信任问题整层作废，单台配置的手误只废那一台。
 */
function readMcpServers(
  value: unknown,
  layer: Layer,
  where: string,
  context: { readonly home: string; readonly root: string; readonly env: Record<string, string | undefined> },
  warn: (line: string) => void,
): readonly McpServerConfig[] {
  if (value === undefined) return [];
  if (layer.source !== 'user') {
    warn(
      `${label(layer.source)} 里写了 mcpServers —— MCP server 只认用户级 ${join(context.home, '.deepcode', 'settings.json')}，这一份已丢弃。`,
    );
    return [];
  }

  return parseMcpServers(value, {
    origin: 'user',
    env: context.env,
    resolvePath: (text) => resolveMcpPath(text, context.home, context.root),
    warn: (line) => warn(`${label(layer.source)} ${where} —— ${line}`),
  });
}

/** `cwd` 的 `~` 展开与相对路径解析。相对路径按会话根目录 —— 与 `--resume` 同一个规矩。 */
function resolveMcpPath(value: string, home: string, root: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  if (isAbsolute(value)) return value;
  return resolve(root, value);
}

/**
 * 解析一层的 `telemetry` 段。**只有 user 与 policy 两层收下**，别的层写了就丢掉并出声。
 *
 * 形状错的处置与 `compact` 一致（字段级降级：`enabled` 不是布尔就按没写处理 + 出声），
 * 不整块废掉这一层 —— 遥测不是权限，猜错方向的代价只是"开关没生效"，
 * 而它**默认就是关的**，所以"读不懂就不动"在这里天然是安全的那一侧。
 */
function readTelemetry(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): TelemetryLayer {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 telemetry 块整块忽略 —— 不是一个对象。`);
    return {};
  }

  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'enabled');
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 telemetry 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  if (record.enabled === undefined) return {};
  if (typeof record.enabled !== 'boolean') {
    warn(`${label(layer.source)} ${where} telemetry.enabled 不是布尔值，按没写处理。`);
    return {};
  }

  // ⚠️ 丢掉个人层的那一句**必须在解析成功之后**说：一份 `enabled: "yes"` 的
  // project 设置该收到的是"类型不对"，不是"你这一层不算数"—— 后者会让人以为
  // 把值写对了就能生效。
  if (layer.source !== 'user' && layer.source !== 'policy') {
    warn(
      `${label(layer.source)} ${where} 里写了 telemetry.enabled —— ` +
        `只有用户层能开遥测（托管层能关），这一份已丢弃：` +
        `别人仓库里的一份文件不该替你按下开关。`,
    );
    return {};
  }

  return { enabled: record.enabled };
}

/**
 * 解析一层的 `instructions` 段（P5b）—— 托管层下发指令内容。
 *
 * 形状：
 *
 *   "instructions": { "text": "一段话", "files": ["/etc/deepcode/policy.md"] }
 *
 * 两个字段都可省；`text` 排在前，`files` 按给的顺序排在后
 * （顺序可预期，才好被钉 —— 与 `INSTRUCTION_LAYERS` 那条同一个道理）。
 *
 * ⚠️ **只有托管层收下**，别的层写了就整项丢掉并出声。方向与 `telemetry`
 * （只有用户层能开）相反，道理是同一条：这一段的用处是"组织往每一次系统提示里放一句话"，
 * 让一份克隆下来的仓库文件也能做到这件事，等于把"个人配置掀不翻托管策略"反过来。
 * 这就是设计 §4.2 那句判据的落法：把托管那份抄进个人规则里想覆盖它 →
 * 被忽略，并且被告知已丢弃。
 *
 * 形状错的处置沿用 `sandbox` 那一档（**块内降级 + 出声**，不废掉整份文件）：
 * 它不裁决任何动作，读不懂就不动，比"整层作废"少一次意外。
 *
 * 唯一格外要吼的是**点名的文件读不动 / 不存在**：那是组织配错了，
 * 而"安静的失效"是这个项目最想防的失败形状（`defaultTextReader` 的注释里
 * 那条 fail-open 在这儿落第二处 —— 吼一声，但照旧返回，一行配置不该让 CLI 起不来）。
 */
async function readInstructions(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
  readText: TextReader,
): Promise<readonly ManagedInstruction[]> {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 instructions 块整块忽略 —— 不是一个对象。`);
    return [];
  }

  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'text' && key !== 'files');
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 instructions 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  if (layer.source !== 'policy') {
    warn(
      `${label(layer.source)} ${where} 里写了 instructions —— 只有托管层能下发指令` +
        `（它是组织放进每一次系统提示的一段话），这一份已丢弃：` +
        `别人仓库里的一份文件不该往你的提示里塞东西。`,
    );
    return [];
  }

  const out: ManagedInstruction[] = [];

  if (record.text !== undefined) {
    if (typeof record.text !== 'string') {
      warn(`${label(layer.source)} ${where} 的 instructions.text 不是字符串，按没写处理。`);
    } else if (record.text.trim() === '') {
      warn(`${label(layer.source)} ${where} 的 instructions.text 是空的，按没写处理。`);
    } else {
      out.push({ label: `${where} 内嵌的 instructions.text`, text: record.text });
    }
  }

  if (record.files !== undefined) {
    if (!Array.isArray(record.files) || record.files.some((item) => typeof item !== 'string')) {
      warn(`${label(layer.source)} ${where} 的 instructions.files 不是字符串数组，整项忽略。`);
      return out;
    }
    for (const path of record.files as string[]) {
      const trimmed = path.trim();
      if (trimmed === '') {
        warn(`${label(layer.source)} ${where} 的 instructions.files 里有一条是空的。`);
        continue;
      }
      let text: string | undefined;
      try {
        text = await readText(trimmed);
      } catch (error) {
        warn(
          `${label(layer.source)} ${where} 点名要的指令文件 ${trimmed} 读不了` +
            `（${error instanceof Error ? error.message : String(error)}）—— 这一段跳过。`,
        );
        continue;
      }
      if (text === undefined) {
        warn(`${label(layer.source)} ${where} 点名要的指令文件 ${trimmed} 不存在 —— 这一段跳过。`);
        continue;
      }
      out.push({ label: trimmed, text });
    }
  }

  return out;
}

/**
 * 解析一层的 `compact` 段。**字段级降级**：只有那一个字段类型不对时用默认值 + 出声，
 * 不整块忽略 —— 它不是权限，没有"猜严/猜松"的方向问题。
 */
function readCompact(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): CompactLayer {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 compact 块整块忽略 —— 不是一个对象。`);
    return {};
  }

  const record = value as Record<string, unknown>;
  const out: { auto?: boolean; atTokens?: number; keepTurns?: number; layers?: Partial<ContextLayerConfig> } = {};

  if (record.auto !== undefined) {
    if (typeof record.auto === 'boolean') out.auto = record.auto;
    else warn(`${label(layer.source)} ${where} compact.auto 不是布尔值，按默认值处理。`);
  }

  for (const key of ['atTokens', 'keepTurns'] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) out[key] = raw;
    else warn(`${label(layer.source)} ${where} compact.${key} 不是正整数，按默认值处理。`);
  }

  const layers = readContextLayers(record.layers, layer, where, warn);
  if (layers !== undefined) out.layers = layers;

  const unknown = Object.keys(record).filter(
    (key) => key !== 'auto' && key !== 'atTokens' && key !== 'keepTurns' && key !== 'layers',
  );
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 compact 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return out;
}

/**
 * 解析一层的 `memory` 段（P12）。形状错的处置与 `compact` 一致：**字段级降级**，
 * 只有那一个字段类型不对时按没写处理 + 出声。它不是权限，没有「猜严/猜松」的方向。
 */
function readMemory(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): MemoryLayer {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 memory 块整块忽略 —— 不是一个对象。`);
    return {};
  }

  const record = value as Record<string, unknown>;
  const out: { enabled?: boolean; maxRecall?: number; recallModel?: string } = {};

  if (record.enabled !== undefined) {
    if (typeof record.enabled === 'boolean') out.enabled = record.enabled;
    else warn(`${label(layer.source)} ${where} memory.enabled 不是布尔值，按默认值处理。`);
  }
  if (record.maxRecall !== undefined) {
    if (typeof record.maxRecall === 'number' && Number.isInteger(record.maxRecall) && record.maxRecall > 0) {
      out.maxRecall = record.maxRecall;
    } else {
      warn(`${label(layer.source)} ${where} memory.maxRecall 不是正整数，按默认值处理。`);
    }
  }
  if (record.recallModel !== undefined) {
    if (typeof record.recallModel === 'string' && record.recallModel.trim() !== '') {
      out.recallModel = record.recallModel.trim();
    } else {
      warn(`${label(layer.source)} ${where} memory.recallModel 不是非空字符串，按没写处理。`);
    }
  }

  const unknown = Object.keys(record).filter(
    (key) => key !== 'enabled' && key !== 'maxRecall' && key !== 'recallModel',
  );
  if (unknown.length > 0) {
    warn(`${label(layer.source)} ${where} 的 memory 里有不认识的子键：${unknown.join('、')}（已忽略）。`);
  }

  return out;
}

/** `compact.layers` 里的正整数旋钮。 */
const LAYER_INT_KEYS = [
  'toolResultMaxChars',
  'toolResultPreviewChars',
  'toolMessageMaxChars',
  'snipKeepTurns',
  'microKeepRecent',
  'microIdleMs',
  'collapseKeepTurns',
  'collapseUrgentKeepTurns',
] as const;

/** `compact.layers` 里的比例旋钮，取值 `(0, 1]`。 */
const LAYER_RATIO_KEYS = [
  'snipAtRatio',
  'microAtRatio',
  'collapseAtRatio',
  'collapseUrgentRatio',
] as const;

/**
 * 解析一层的 `compact.layers`（P11）。
 *
 * 形状错的处置与 `compact` 一致：**字段级降级**。它不是权限，没有「猜严/猜松」的方向；
 * 一个字段写错不该把整份设置废掉。但两类跨字段约束必须管：
 *
 * 1. 预览不能比外置阈值还长（否则「外置」反而让消息变长）；
 * 2. 比例阶梯必须单调（`snip ≤ micro ≤ collapse ≤ urgent`），否则第 2 层会在第 3 层
 *    之后才触发，阶梯就不成其为阶梯。
 *
 * 违反时只说**一个**字段并按默认值处理，不静默修正成另一个值 —— 用户写下的数与实际
 * 生效的数必须对得上，对不上就要有话说。
 */
function readContextLayers(
  value: unknown,
  layer: Layer,
  where: string,
  warn: (line: string) => void,
): Partial<ContextLayerConfig> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(`${label(layer.source)} ${where} 的 compact.layers 整块忽略 —— 不是一个对象。`);
    return undefined;
  }

  const record = value as Record<string, unknown>;
  type MutableLayers = { -readonly [K in keyof ContextLayerConfig]?: ContextLayerConfig[K] };
  const out: MutableLayers = {};
  const set = (key: keyof ContextLayerConfig, value: number): void => {
    (out as Record<string, number>)[key] = value;
  };

  for (const key of LAYER_INT_KEYS) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) set(key, raw);
    else warn(`${label(layer.source)} ${where} compact.layers.${key} 不是正整数，按默认值处理。`);
  }

  for (const key of LAYER_RATIO_KEYS) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) set(key, raw);
    else {
      warn(
        `${label(layer.source)} ${where} compact.layers.${key} 不是 (0, 1] 的比例，按默认值处理。`,
      );
    }
  }

  const known = new Set<string>([...LAYER_INT_KEYS, ...LAYER_RATIO_KEYS]);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    warn(
      `${label(layer.source)} ${where} 的 compact.layers 里有不认识的子键：${unknown.join('、')}（已忽略）。`,
    );
  }

  const preview = out.toolResultPreviewChars ?? DEFAULT_CONTEXT_LAYERS.toolResultPreviewChars;
  const max = out.toolResultMaxChars ?? DEFAULT_CONTEXT_LAYERS.toolResultMaxChars;
  if (preview >= max) {
    warn(
      `${label(layer.source)} ${where} compact.layers.toolResultPreviewChars 必须小于 ` +
        'toolResultMaxChars，这两项按默认值处理。',
    );
    delete out.toolResultPreviewChars;
    delete out.toolResultMaxChars;
  }

  const ratio = (key: (typeof LAYER_RATIO_KEYS)[number]): number =>
    out[key] ?? DEFAULT_CONTEXT_LAYERS[key];
  const ladder = [
    ['snipAtRatio', 'microAtRatio'],
    ['microAtRatio', 'collapseAtRatio'],
    ['collapseAtRatio', 'collapseUrgentRatio'],
  ] as const;
  for (const [lower, upper] of ladder) {
    if (ratio(lower) > ratio(upper)) {
      warn(
        `${label(layer.source)} ${where} compact.layers.${lower} 大于 ${upper} —— ` +
          `比例阶梯必须单调，${lower} 按默认值处理。`,
      );
      delete out[lower];
    }
  }

  return out;
}

function base(
  layer: Layer,
  state: SourceInfo['state'],
  error: string | undefined,
  problems: readonly string[],
  rules: readonly Rule[],
  plugins: PluginsLayer = EMPTY_PLUGINS,
): SourceInfo {
  const counts: Record<Behavior, number> = { ...EMPTY_COUNTS };
  for (const rule of rules) counts[rule.decision] += 1;
  return { source: layer.source, path: layer.path, state, ...(error === undefined ? {} : { error }), counts, problems, rules, plugins };
}
