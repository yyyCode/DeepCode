import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parsePlist } from './managed-plist';
import { parseRegistryQuery } from './managed-registry';
import { defaultTextReader, type TextReader } from './text-reader';

/**
 * 托管策略从哪来（P5d）。
 *
 * P2 把接口留好了：一个 JSON 文件、一个 `DEEPCODE_MANAGED_SETTINGS` 覆盖口子。
 * 这一片把"一个文件"变成**三个真实通道** —— 参考实现（`p2-design.md:441`）那句话
 * 说的就是这件事：「MDM 落地（plist / 注册表 / ADMX）—— 排 P5。本轮只做文件，
 * 路径与 `DEEPCODE_MANAGED_SETTINGS` 已为 P5 留好接口」。
 *
 * | 平台 | 通道 |
 * | --- | --- |
 * | macOS | 托管偏好域 `com.deepcode.settings`（`defaults export` 出来的 XML plist） |
 * | Windows | 注册表 `HKLM\SOFTWARE\DeepCode` |
 * | 其它 | `/etc/deepcode/managed-settings.json` |
 *
 * **不做 ADMX**（P5 总纲决策 9）：它是给组策略编辑器看的描述文件，没有它注册表那条照样生效。
 *
 * ## 归一在**文本**层，不在对象层
 *
 * 三个通道最后都给出**同一段 JSON 文本**，交给 `settings.ts` 那条既有的
 * "读一段文本 → JSON.parse → 解析五层"的路。为什么不直接给对象：那样"三个通道一致"
 * 只能是深比较相等，而给文本之后它是**字面**同一条字符串 —— 判据因此强得多，
 * 而且下游一个字节都不用改。
 *
 * ## 顺序
 *
 * ```
 * DEEPCODE_MANAGED_SETTINGS（环境变量，最高）
 *   → 平台的 MDM 通道（注册表 / 偏好域）
 *     → 平台的默认文件
 * ```
 *
 * 第一个**有内容**的赢。注册表排在默认文件之前：MDM 是正规通道，散落的一个文件不该盖过它。
 * 环境变量仍然是最高 —— 那是 P2 已经给了的、给开发与排查用的口子。
 */

/** 一次成功读取的结果。`where` 是给人看的位置说明（`/permissions` 要显示它）。 */
export type ManagedSource = { readonly where: string; readonly text: string };

/**
 * 托管通道自己的失败 —— 带上"这条内容是从哪条通道来的"。
 *
 * 异常从 `readManagedSettings` 逃出去的时候，`where` 就丢了；而它是"读不动"这句警告
 * 里最有用的一半（`注册表 HKLM\SOFTWARE\DeepCode 读不懂……` vs 指着一个默认文件路径）。
 * 谁接住这个异常（`resolvePolicy`）谁就该把 `where` 一起接住。
 */
export class ManagedError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedError';
  }
}

/**
 * 跑一条外部命令，拿它的 stdout。**失败一律返回 `undefined`，不抛。**
 *
 * 一台没配 MDM 的机器上 `reg query` 以非零码退出是**常态**，不是故障 ——
 * 与 `mods/diff/git.ts` 里"`git status` 非零退出 → 空列表"是同一条口径。
 *
 * 注入是为了让判据能用**夹具**（P5 总纲 §6.1 原话）而不是真机：
 * "这台机器是 macOS 还是 Linux"在测试里只是一个参数。
 */
export type ManagedRun = (file: string, args: readonly string[]) => Promise<string | undefined>;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 5000;

export const defaultRun: ManagedRun = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        // 找不到那个程序（没装 / 不在 PATH）、退出码非零、超时、输出超上限 —— 全是"没有"。
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** 托管策略文件的位置。`env` 与 `platform` 可注入，测试才不必碰系统目录。 */
export function defaultManagedPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    const base = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
    return join(base, 'DeepCode', 'managed-settings.json');
  }
  return '/etc/deepcode/managed-settings.json';
}

/** 环境变量里那个覆盖口子的名字（P2 就有，名字不动）。 */
export const MANAGED_ENV = 'DEEPCODE_MANAGED_SETTINGS';

export const REGISTRY_KEY = 'HKLM\\SOFTWARE\\DeepCode';
export const PLIST_DOMAIN = 'com.deepcode.settings';

export type ManagedDeps = {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: string;
  /** 给定时**只**读这个文件（`ResolvePolicyDeps.managedPath` 从这进），不落到通道表。 */
  readonly path?: string;
  readonly readText?: TextReader;
  readonly run?: ManagedRun;
};

async function fromFile(
  where: string,
  path: string,
  readText: TextReader,
): Promise<ManagedSource | undefined> {
  let text: string | undefined;
  try {
    text = await readText(path);
  } catch (error) {
    // 转手时补上 `where` —— 上面那条注释说的就是这个。
    throw new ManagedError(where, error instanceof Error ? error.message : String(error));
  }
  return text === undefined ? undefined : { where, text };
}

/**
 * 跑一个通道命令 → 解析它的输出 → 归一成 JSON 文本。
 *
 * `undefined` 有**两个**来源，它们都表示"这条通道没有内容"：命令本身没跑成
 * （`run` 给了 `undefined`），或命令跑了但没有可解析的内容（键不存在 / 一个值都没有）。
 *
 * ⚠️ 解析器抛异常时**原样抛出去**，与 `defaultTextReader` 那条"存在但读不了要吼"同一个方向：
 * 一份读得动但读不懂的托管策略，比没有托管策略危险得多，绝不能安静地当它是空的。
 */
async function fromCommand(
  where: string,
  run: ManagedRun,
  file: string,
  args: readonly string[],
  parse: (text: string) => unknown,
): Promise<ManagedSource | undefined> {
  const out = await run(file, args);
  if (out === undefined) return undefined;
  let value: unknown;
  try {
    value = parse(out);
  } catch (error) {
    throw new ManagedError(where, error instanceof Error ? error.message : String(error));
  }
  if (value === undefined) return undefined;
  return { where, text: JSON.stringify(value) };
}

/**
 * 按通道表找到托管策略那一段文本。找不到就是 `undefined`（绝大多数机器）。
 *
 * ⚠️ `path` 给了就**只**读那个文件，不往后退到其它通道。这条语义一个字都没变 ——
 * 既有测试全靠它把托管层指到临时目录。
 */
export async function readManagedSettings(
  deps: ManagedDeps = {},
): Promise<ManagedSource | undefined> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const readText = deps.readText ?? defaultTextReader;
  const run = deps.run ?? defaultRun;

  if (deps.path !== undefined) return fromFile(deps.path, deps.path, readText);

  const override = env[MANAGED_ENV];
  if (override !== undefined && override !== '') {
    const found = await fromFile(`${MANAGED_ENV}（${override}）`, override, readText);
    // 点了名却读不到 → 继续往通道表走。那不是"没有托管策略"，而是"这个口子指错了"；
    // 让正规通道还有机会说话，比整层静默作废强。（读不动但存在的情况在上面已经抛了。）
    if (found !== undefined) return found;
  }

  if (platform === 'win32') {
    const found = await fromCommand(`注册表 ${REGISTRY_KEY}`, run, 'reg', [
      'query',
      REGISTRY_KEY,
      '/s',
    ], parseRegistryQuery);
    if (found !== undefined) return found;
  }

  if (platform === 'darwin') {
    const found = await fromCommand(`托管偏好域 ${PLIST_DOMAIN}`, run, 'defaults', [
      'export',
      PLIST_DOMAIN,
      '-',
    ], parsePlist);
    if (found !== undefined) return found;
  }

  const fallback = defaultManagedPath(env, platform);
  return fromFile(fallback, fallback, readText);
}
