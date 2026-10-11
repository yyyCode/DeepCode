import {
  isPluginName,
  isSafeRelativePath,
  validatePlugin,
  type PluginManifest,
  type PluginReader,
  type Problem,
} from './plugin-manifest';

/**
 * marketplace 索引（`<根>/.deepcode-plugin/marketplace.json`）的校验。
 *
 * **与 `plugin-manifest.ts` 同形**：纯逻辑，读取一律注入 —— 于是它能在没有文件系统的地方跑，
 * 也能被 `plugin add` 与将来的消费者**共用同一份实现**。
 *
 * 注入形状是被依赖边界逼出来的：`scripts/check-boundaries.mjs` 里 `contract: []`，
 * 这份文件不许 import `src/` 下任何顶层目录。而「把某个 source 打开成一个插件目录」要用
 * `cli/plugin-dir.ts` 的 `dirReader` —— 所以只能收一个工厂，不能自己拼路径。
 *
 * 判据两级，与清单校验同一种分法：`M` 是错误（这份索引不可用），`W` 是警告（可用，但说出来）。
 * 第六七条（`M6`）不另写规则，直接吃 `validatePlugin` 的结论 —— 「共用同一份实现」就是这意思。
 * 顺带一个收益：「source 指向的目录不存在」不需要单独的规则，那份校验器的 `E2` 已经覆盖了，
 * 而且措辞在那个场景下恰好是对的。
 */

export type MarketplaceDeps = {
  /** 读索引本身。**读不到返回 undefined**（不存在是常态，不是错）。 */
  readonly readIndex: () => Promise<string | undefined>;
  /** 把某个 source 打开成一个插件目录读取面，交给 `validatePlugin` 用。 */
  readonly openPlugin: (source: string) => PluginReader;
};

export type MarketplaceEntry = {
  readonly name: string;
  readonly description: string | undefined;
  /** 通过 `isSafeRelativePath` 的原始写法，如 `./plugins/todo`。 */
  readonly source: string;
  /** 那份清单**归一之后**的形状 —— `plugin add` 要拿它打报告，不必再校验一次。 */
  readonly manifest: PluginManifest;
};

export type ValidatedMarketplace = {
  readonly problems: readonly Problem[];
  /** 有没有 E 级问题。false = 这份索引不可用。 */
  readonly ok: boolean;
  /** 全绿时的条目表（名字已与清单核对过）。有 E 时是 undefined。 */
  readonly entries: readonly MarketplaceEntry[] | undefined;
};

const KNOWN_TOP: ReadonlySet<string> = new Set(['name', 'description', 'plugins']);
const KNOWN_ENTRY: ReadonlySet<string> = new Set(['name', 'description', 'source']);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `root` 只用来组给人看的标签，**不用于拼路径** —— 拼路径是注入方的活。
 * 路径那一半写在这儿是要紧的：`plugin add --from=<目录>` 的索引就在那个位置，
 * 而报错里不写全路径，人就不知道自己刚才指了哪儿。
 */
export async function validateMarketplace(
  root: string,
  deps: MarketplaceDeps,
): Promise<ValidatedMarketplace> {
  const at = `${root} 下的 .deepcode-plugin/marketplace.json`;
  const problems: Problem[] = [];
  const err = (code: string, text: string): void => {
    problems.push({ level: 'error', code, message: text });
  };
  const warn = (code: string, text: string): void => {
    problems.push({ level: 'warn', code, message: text });
  };
  const giveUp = (): ValidatedMarketplace => ({ problems, ok: false, entries: undefined });

  // ── M1 读得到、是好 JSON、顶层是对象 ──
  let text: string | undefined;
  try {
    text = await deps.readIndex();
  } catch (error) {
    err('M1', `${at} 读不了：${message(error)}`);
    return giveUp();
  }
  if (text === undefined) {
    err('M1', `${at} 不存在`);
    return giveUp();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    err('M1', `${at} 不是合法 JSON：${message(error)}`);
    return giveUp();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('M1', `${at} 的顶层不是一个对象`);
    return giveUp();
  }
  const record = raw as Record<string, unknown>;

  // ── M2 name ──
  const rawName = record.name;
  if (typeof rawName !== 'string') {
    err('M2', `${at} 缺少 name（必填，字符串）`);
  } else if (!isPluginName(rawName)) {
    err('M2', `${at} 的 name ${JSON.stringify(rawName)} 不是 kebab-case`);
  }

  // ── M7 description（顶层） ──
  if (record.description !== undefined && typeof record.description !== 'string') {
    err('M7', `${at} 的 description 必须是字符串`);
  }

  // ── W1 未知顶层字段 ──
  const unknownTop = Object.keys(record).filter((key) => !KNOWN_TOP.has(key));
  if (unknownTop.length > 0) {
    warn('W1', `${at} 有未识别的顶层字段：${unknownTop.join('、')}（本版本忽略）`);
  }

  // ── M3 plugins ──
  const list = record.plugins;
  if (!Array.isArray(list)) {
    err('M3', `${at} 的 plugins 必须是数组`);
    return giveUp();
  }
  if (list.length === 0) {
    err('M3', `${at} 的 plugins 是空的 —— 一份没有条目的索引没有意义`);
    return giveUp();
  }

  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();

  for (const [index, item] of list.entries()) {
    const where = `plugins[${index}]`;

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      err('M4', `${at} 的 ${where} 不是一个对象`);
      continue;
    }
    const entry = item as Record<string, unknown>;

    // ── M4 name ──
    const rawEntryName = entry.name;
    let name: string | undefined;
    if (typeof rawEntryName !== 'string') {
      err('M4', `${at} 的 ${where} 缺少 name（必填，字符串）`);
    } else if (!isPluginName(rawEntryName)) {
      err('M4', `${at} 的 ${where}.name ${JSON.stringify(rawEntryName)} 不是 kebab-case`);
    } else if (seen.has(rawEntryName)) {
      err('M4', `${at} 的 ${where}.name ${JSON.stringify(rawEntryName)} 与前面某一条重名 —— 一个索引里名字必须唯一`);
    } else {
      name = rawEntryName;
      seen.add(rawEntryName);
    }

    // ── M7 description（条目） ──
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      err('M7', `${at} 的 ${where}.description 必须是字符串`);
    }

    // ── W1 未知条目字段 ──
    const unknownEntry = Object.keys(entry).filter((key) => !KNOWN_ENTRY.has(key));
    if (unknownEntry.length > 0) {
      warn('W1', `${at} 的 ${where} 有未识别的字段：${unknownEntry.join('、')}（本版本忽略）`);
    }

    // ── M5 source ──
    // 与清单校验用**同一条** `isSafeRelativePath`：读索引不该另立一套。
    const source = entry.source;
    if (typeof source !== 'string' || !isSafeRelativePath(source)) {
      err(
        'M5',
        `${at} 的 ${where}.source 必须是相对的、以 ./ 开头、不含 .. 与反斜杠，实际是 ${JSON.stringify(source)}`,
      );
      continue;
    }

    // ── M6 直接调既有的 validatePlugin ──
    // 挂上标签是因为 E 编号属于那份清单，而报错得让人知道是哪一条索引条目里的事。
    const validated = await validatePlugin(`${where}（${source}）`, deps.openPlugin(source));
    for (const problem of validated.problems) {
      problems.push({
        level: problem.level,
        code: problem.code,
        message: `${where}（${source}）里的清单：${problem.message}`,
      });
    }

    if (!validated.ok || validated.manifest === undefined) continue;
    const manifest = validated.manifest;
    if (name === undefined) continue;

    // ── M8 索引名字与清单名字必须一致 ──
    // 不一致是**静默**的：你照着 `plugin list` 打印的名字写 plugins.enable，
    // 然后插件不生效，没有一条报错解释为什么。
    if (manifest.name !== name) {
      err(
        'M8',
        `${at} 的 ${where}.name 是 ${JSON.stringify(name)}，而 ${source} 里那份清单的 name 是 ` +
          `${JSON.stringify(manifest.name)} —— 两者必须一致，否则照 list 写 plugins.enable 会静默不生效`,
      );
      continue;
    }

    entries.push({
      name,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      source,
      manifest,
    });
  }

  const ok = !problems.some((problem) => problem.level === 'error');
  // 有 E 就一个条目都不给：半个可用清单比没有更危险。
  return { problems, ok, entries: ok ? entries : undefined };
}
