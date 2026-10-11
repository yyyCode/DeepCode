import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../src/contract/model-provider';
import type { Plugin } from '../src/contract/plugin';
import { CORE_ORIGIN } from '../src/contract/next';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { createEngine } from '../src/core/create';
import { listTools, type ToolListing } from '../src/core/tool-list';
import { createSessionChanges } from '../src/cli/changes';
import { createSessionCommands } from '../src/cli/commands';
import { createPalette } from '../src/cli/ansi';

/**
 * `/tools` 与 `/help` 的工具那一行（P9 §3.3）。
 *
 * ⚠️ 这一套**搭真引擎**，不像 `/help` 那套用桩 —— 因为本阶段要钉的正是"接线"：
 * `toolListing` 少一根线，`/tools` 就只剩「未知命令」（P7 的 `/context` 栽过一次，
 * `test/cli.test.ts` 里那条端到端用例就是为那根线写的）。桩引擎测不出这个。
 */

const NO_MODEL: ModelProvider = {
  name: 'none',
  // 这一套里不真的发请求：/tools 与 /help 只派发 describe。真流一个的话，
  // 失败会以"provider 坏了"的形状出现，掩盖真因。
  async *stream() {
    throw new Error('这一套里不该发请求');
  },
};

/** 一个插件给两个工具：正常的，与**只注册了 call** 的（"故障"那一类）。 */
const fixture: Plugin = {
  name: 'fixture-plugin',
  uses: ['tool.describe', 'tool.call'],
  register(on) {
    on('tool.describe', { tool: 'Probe' }, () => ({ description: '探针工具。', inputSchema: {} }));
    on('tool.call', { tool: 'Probe' }, () => ({ value: 'ok' }));
    on('tool.call', { tool: 'Ghost' }, () => ({ value: 'ok' }));
  },
};

const LONG_DESCRIPTION = '长'.repeat(100);
const LONG_FIRST_LINE = `${'长'.repeat(80)}…`;
/** 描述超过 80 字的那一个。只在需要测截断的用例里装。 */
const verbosePlugin: Plugin = {
  name: 'verbose-plugin',
  uses: ['tool.describe', 'tool.call'],
  register(on) {
    on('tool.describe', { tool: 'Verbose' }, () => ({
      description: LONG_DESCRIPTION,
      inputSchema: {},
    }));
    on('tool.call', { tool: 'Verbose' }, () => ({ value: 'ok' }));
  },
};

async function mount(options: { withListing?: boolean; extra?: readonly Plugin[] } = {}) {
  const logs: string[] = [];
  const notices: string[] = [];
  // 延迟取：`listTools` 要 `createEngine` 的返回值，而这条命令得在那之前注册。
  // 生产里是同一个形状（`cli/main.ts` 的 `toolListing` 闭包）。
  let listing: () => Promise<ToolListing> = async () => await listTools(engine);

  const sessionPlugin: Plugin = createSessionCommands({
    changes: createSessionChanges(),
    messages: [],
    root: process.cwd(),
    palette: createPalette(false),
    paneLoaded: false,
    ...(options.withListing === false ? {} : { toolListing: () => listing() }),
  });

  const created = await createEngine({
    plugins: [confirmPlugin, sessionPlugin, ...coreTools, fixture, ...(options.extra ?? [])],
    provider: NO_MODEL,
    // `$.ui.log` 落在这个 `print` 上（`core/nouns/ui.ts:11`）—— 写成空函数的话，
    // 这一套会全部以"输出里什么都没有"的形状失败，看着像命令没注册。
    ui: { print: (line) => logs.push(line), notice: (line) => notices.push(line), ask: async () => 'n' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });
  const engine = created;
  listing = async () => await listTools(engine);

  /** 跑一条命令，只回这一次新打出来的那几行。 */
  const run = async (name: string): Promise<string> => {
    const at = logs.length;
    await created.dispatch('command.run', { name, args: [] }, CORE_ORIGIN);
    return logs.slice(at).join('\n');
  };
  return { ...created, logs, notices, run };
}

describe('C3-1：/tools 一屏说清"能用什么、谁给的、什么没进来"', () => {
  it('可见的逐个列，来源取自注册面；没注册描述的那一个独立一段', async () => {
    const out = await (await mount()).run('tools');

    // 六个内建 + Probe = 7 个可见。
    expect(out).toContain('模型这一轮能用的工具（7 个）：');
    // 内建工具的来源是它的**插件名**（'tool-read'），不是工具名 —— 写反了六个会一起错。
    expect(out).toContain('Read　来自 tool-read');
    expect(out).toContain('Probe　来自 fixture-plugin');
    // 模型看不见的那一个：**原因原样带出来**，措辞与另外两类不同（隐身 vs 故障）。
    expect(out).toContain('不进模型可见清单的（1 个）：');
    expect(out).toContain('Ghost　没有注册描述（tool.describe 无人应答 —— 这是故障）');
    // 短描述不截断，也就不打那句脚注 —— 没发生的事不许写在屏幕上。
    expect(out).not.toContain('截断');
  });
});

describe('C3-2：描述在本屏截断，且说清模型拿到的是完整的', () => {
  it('超长描述截到 80 字，并打那句脚注', async () => {
    const out = await (await mount({ extra: [verbosePlugin] })).run('tools');

    expect(out).toContain(`Verbose　来自 verbose-plugin　${LONG_FIRST_LINE}`);
    expect(out).not.toContain(LONG_DESCRIPTION);
    // 不写这一句，读的人会把屏幕上的省略号当成模型也只拿到这么点（P6 同一条先例）。
    expect(out).toContain('（描述只取第一行、超过 80 字截断；模型拿到的是完整的。）');
  });
});

describe('C3-3：/help 与 /tools 是同一份', () => {
  it('/help 不再列模型看不见的工具，并把"另有几个"说出来', async () => {
    const out = await (await mount()).run('help');

    expect(out).toContain('可用工具：Read  Write  Edit  Bash  Glob  Grep  Probe');
    expect(out).toContain('（/tools 看每个工具是干什么的）');
    // 以前的形状：`Ghost` 也躺在那一行里，而模型永远不可能调用它（P9 §2.1 探针 2）。
    expect(out).not.toContain('Ghost');
    expect(out).toContain('另有 1 个不在模型可见清单里（/tools 有原因）');
  });

  it('两边数出来的是同一份：可见个数 + 不进清单个数 = 注册面', async () => {
    const m = await mount();
    const tools = await m.run('tools');
    const visible = Number(tools.match(/能用的工具（(\d+) 个）/)?.[1]);
    const skipped = Number(tools.match(/不进模型可见清单的（(\d+) 个）/)?.[1]);

    expect(visible).toBe(7);
    expect(skipped).toBe(1);
    // 注册面 = 可见 + 不进清单，一个不多一个不少（"在列表里 ≠ 能跑"的算术版）。
    expect(m.$.tool.list()).toHaveLength(visible + skipped);
  });
});

describe('C3-4：没有 toolListing 就不装这条命令（不装半条）', () => {
  it('/tools 不存在，/help 退回注册面并当场说明这是没过滤的', async () => {
    const m = await mount({ withListing: false });

    expect(m.$.command.list()).not.toContain('tools');
    // 注册面上没有它 → 链尾兜底的 `{ handled: false }`，不是"命令在、点了没反应"。
    // 结果里那两格就是链尾兜底的原样（`core/create.ts:70`）。
    expect(await m.dispatch('command.run', { name: 'tools', args: [] }, CORE_ORIGIN)).toEqual({
      handled: false,
      name: 'tools',
    });

    const out = await m.run('help');
    expect(out).toContain('可用工具：');
    // 回退方向是"多列"不是"少列" —— 所以不会静默少一块；但两种含义不同，必须说出来。
    expect(out).toContain('Ghost');
    expect(out).toContain('（未过滤：这一份是注册面，不是模型可见面）');
    expect(out).not.toContain('另有');
  });
});
