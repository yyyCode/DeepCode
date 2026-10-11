import { createEngine } from '../core/create';
import { CORE_ORIGIN } from '../contract/next';
import type { ModelProvider } from '../contract/model-provider';
import type { StartupAction } from './args';
import { createConfigCommand, renderEntries } from './config-command';

/**
 * `deepcode config list` 与 `deepcode config set <键> <值>`。
 *
 * ⚠️ 这两条**派发事件**，不直接调 `describeConfig` / `setConfigValue`。
 * 直接调的话那两个事件就一个消费者都没有 —— 一个没人用的钩子点与一条摆设断言是
 * 同一个毛病：写在那里，却从不承重，于是下次有人把它改坏也没人知道。
 *
 * 与 `plugin-command.ts` 同一条体例：返回退出码，I/O 由调用方注入（测试才跑得动）。
 */

export type ConfigAction = Extract<StartupAction, { kind: 'config' }>;

export type ConfigCommandDeps = {
  readonly action: ConfigAction;
  readonly home: string;
  readonly root: string;
  /** 生效环境变量的快照 —— 来源判定靠它。 */
  readonly env: Record<string, string | undefined>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

const CONFIG_HELP = `deepcode config —— 看和改连接配置

  deepcode config list              看每个配置项生效的值与它来自哪一层
  deepcode config set model <名字>   改用户级 ~/.deepcode/config.json 里的 model

能改的只有 model。apiKey 是凭据、baseUrl 决定请求发去哪 —— 这两个由一条命令替你写，
是可以安静地把流量端掉的，所以自己开文件看一眼再改。权限（permissions / sandbox /
plugins）属于设置，不在 config 里，也一个字都不许由命令去动。`;

/**
 * 一个**永远不该被调用**的 provider。
 *
 * `config` 只走 `config.describe` / `config.set` 两条链，一条都不碰模型。
 * 但 `createEngine` 要一个 provider，而这里**有意装一台最小引擎**而不是整套 CLI 插件：
 * 装全套会让 `deepcode config list` 在"没有 API key"或"设置文件坏掉"的机器上也起不来，
 * 而"看看配置现在是什么"恰恰是那些情况下最该问得出口的一句话。
 */
const UNUSED: ModelProvider = {
  name: 'unused',
  // 走到这里说明有东西真的在试着说话 —— 那是本模块的 bug，不是用户的输入问题。
  async *stream() {
    throw new Error('config 子命令不该调用模型');
  },
};

export async function runConfigCommand(deps: ConfigCommandDeps): Promise<number> {
  if (deps.action.sub === 'help') {
    deps.out(CONFIG_HELP);
    return 0;
  }

  const plugin = createConfigCommand({
    home: deps.home,
    root: deps.root,
    env: deps.env,
    warn: deps.err,
  });
  const { dispatch } = await createEngine({
    plugins: [plugin],
    provider: UNUSED,
    ui: { print: deps.out, notice: deps.err, ask: async () => '' },
    sessionInfo: { id: 'config-cli', cwd: deps.root, root: deps.root },
    env: deps.env,
    signal: () => new AbortController().signal,
  });

  if (deps.action.sub === 'set') {
    const verdict = await dispatch(
      'config.set',
      { key: deps.action.key, value: deps.action.value },
      CORE_ORIGIN,
    );
    if (verdict.ok) {
      deps.out(`已写入 ${verdict.path}：${deps.action.key} = ${deps.action.value}`);
      return 0;
    }
    deps.err(verdict.error);
    return 1;
  }

  const { entries } = await dispatch('config.describe', {}, CORE_ORIGIN);
  deps.out(renderEntries(entries));
  return 0;
}
