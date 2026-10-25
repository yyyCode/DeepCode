import { describe, expect, it } from 'vitest';
import type { ContextLayerConfig } from '../src/contract/context-window';
import type { FsNoun } from '../src/contract/engine';
import type { Message, ModelProvider, StreamRequest } from '../src/contract/model-provider';
import { createContextWindow } from '../src/cli/context-window';
import type { CompactConfig } from '../src/cli/settings';

const FILLER = '细节'.repeat(10);

function toolTurn(index: number, toolName = 'Read', chars = 0): Message[] {
  return [
    { role: 'user', content: `问题${index}：${FILLER}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `回答${index}` },
        { type: 'tool_use', id: `u${index}`, name: toolName, input: { file_path: `f${index}` } },
      ],
    },
    {
      role: 'tool',
      results: [
        {
          toolUseId: `u${index}`,
          content: chars > 0 ? 'x'.repeat(chars) : `结果${index}：${FILLER}`,
          isError: false,
        },
      ],
    },
  ];
}

function turns(count: number, toolName = 'Read', chars = 0): Message[] {
  const out: Message[] = [];
  for (let index = 1; index <= count; index++) out.push(...toolTurn(index, toolName, chars));
  return out;
}

function fakeFs(options: { failWrite?: boolean } = {}): {
  fs: FsNoun;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      async read(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      async write(path, content) {
        if (options.failWrite === true) throw new Error('磁盘满了');
        files.set(path, content);
      },
      async exists(path) {
        return files.has(path);
      },
      async list(dir) {
        return [...files.keys()].filter((path) => path.startsWith(dir));
      },
      async stat(path) {
        return { size: files.get(path)?.length ?? 0, isDirectory: false };
      },
    },
  };
}

const baseConfig: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 6 };

function setup(
  options: {
    layers?: Partial<ContextLayerConfig>;
    reply?: string;
    providerThrows?: boolean;
    emptyReply?: boolean;
    failWrite?: boolean;
    atTokens?: number;
  } = {},
): {
  cw: ReturnType<typeof createContextWindow>;
  files: Map<string, string>;
  calls: StreamRequest[];
  warnings: string[];
} {
  const { fs, files } = fakeFs(options.failWrite === undefined ? {} : { failWrite: options.failWrite });
  const calls: StreamRequest[] = [];
  const warnings: string[] = [];
  const provider: ModelProvider = {
    name: 'fake',
    async *stream(req) {
      calls.push(req);
      if (options.providerThrows === true) throw new Error('上游 500');
      if (options.emptyReply !== true) yield { type: 'text', text: options.reply ?? '摘要正文' };
      yield { type: 'done', stopReason: 'stop' };
    },
  };
  const cw = createContextWindow({
    home: 'C:/home',
    cwd: 'F:/work/demo',
    sessionId: 'session-1',
    fs,
    provider,
    config: {
      ...baseConfig,
      atTokens: options.atTokens ?? baseConfig.atTokens,
      ...(options.layers === undefined ? {} : { layers: options.layers }),
    },
    warn: (line) => warnings.push(line),
  });
  return { cw, files, calls, warnings };
}

const request = (now = 1_000, systemChars = 0, toolChars = 0) => ({
  systemChars,
  toolChars,
  signal: new AbortController().signal,
  now,
});

/** 单独测第 4 层时把第 2、3 层的比例抬到实际到不了的地方。 */
const COLLAPSE_ONLY = { snipAtRatio: 1_000_000, microAtRatio: 1_000_000 } as const;

describe('第 1 层：落盘与预览', () => {
  it('超限结果写进会话目录，消息里只留带路径的预览', async () => {
    const { cw, files } = setup();
    const big = { toolUseId: 'toolu_01/abc', content: 'x'.repeat(60_000), isError: false };

    const out = await cw.absorbToolResults([big], new Map([[big.toolUseId, 'Read']]));

    expect(files.size).toBe(1);
    const [path, content] = [...files.entries()][0]!;
    expect(content).toBe(big.content); // 存的是全文，不是预览
    expect(path).toContain('tool-results');
    expect(path).toContain('session-1');
    expect(path.endsWith('.txt')).toBe(true);

    expect(out).toHaveLength(1);
    expect(out[0]?.toolUseId).toBe(big.toolUseId);
    expect(out[0]?.content).toContain('大工具结果已存盘');
    expect(out[0]?.content).toContain(path);
    expect(out[0]?.content).toContain('offset');
    expect(out[0]?.content.length).toBeLessThan(3_000);
  });

  it('小结果不动，也不写盘', async () => {
    const { cw, files } = setup();
    const out = await cw.absorbToolResults(
      [{ toolUseId: 'u1', content: '短短一行', isError: false }],
      new Map([['u1', 'Read']]),
    );
    expect(files.size).toBe(0);
    expect(out[0]?.content).toBe('短短一行');
  });

  it('写盘失败 → 保留完整内容，只出声一次', async () => {
    const { cw, warnings } = setup({ failWrite: true });
    const big = { toolUseId: 'u1', content: 'x'.repeat(60_000), isError: false };

    const first = await cw.absorbToolResults([big], new Map([['u1', 'Read']]));
    const second = await cw.absorbToolResults([big], new Map([['u1', 'Read']]));

    expect(first[0]?.content).toBe(big.content);
    expect(second[0]?.content).toBe(big.content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('落盘失败');
  });
});

describe('第 2–4 层：阈值阶梯', () => {
  it('远低于阈值：原样返回，一层都不动', async () => {
    const { cw } = setup();
    const messages = turns(10);
    const out = await cw.project(messages, request());

    expect(out.applied).toEqual([]);
    expect(out.messages).toBe(messages);
    expect(out.stats.tokensBefore).toBe(out.stats.tokensAfter);
    expect(cw.last()).toEqual(out.stats);
  });

  it('到线先 snip：砍掉最早几轮，原数组不动', async () => {
    // 只让第 2 层命中：其余两层的比例抬到不可能达到。
    const { cw } = setup({
      layers: { snipAtRatio: 0.001, snipKeepTurns: 2, microAtRatio: 2, collapseAtRatio: 2 },
    });
    const messages = turns(10);
    const before = JSON.stringify(messages);

    const out = await cw.project(messages, request());

    expect(out.applied).toEqual(['snip']);
    expect(out.messages).toHaveLength(6); // 2 轮 × 3 条
    expect(out.stats.snippedMessages).toBe(24);
    expect(out.stats.tokensAfter).toBeLessThan(out.stats.tokensBefore);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('时间衰减也会触发 micro：隔得够久就清老结果', async () => {
    const { cw } = setup({
      layers: {
        snipAtRatio: 2,
        microAtRatio: 2,
        collapseAtRatio: 2,
        microIdleMs: 60_000,
        microKeepRecent: 1,
      },
    });
    const messages = turns(3);

    const first = await cw.project(messages, request(1_000));
    expect(first.applied).toEqual([]); // 还没有「上一次请求」，不算闲置

    const idle = await cw.project(messages, request(61_000));
    expect(idle.applied).toEqual(['micro']);
    expect(idle.stats.clearedResults).toBe(2); // 3 个里保留最近 1 个
    // 配对消息的数量没变，只是内容被清了。
    expect(idle.messages).toHaveLength(messages.length);
  });

  it('第 4 层：够高才折叠，摘要按 head 缓存，只付一次钱', async () => {
    const { cw, calls } = setup({
      atTokens: 100,
      layers: {
        ...COLLAPSE_ONLY,
        collapseAtRatio: 0.5,
        collapseUrgentRatio: 3,
        collapseKeepTurns: 2,
      },
    });
    const messages = turns(10, 'Read', 1_000);

    const out = await cw.project(messages, request());

    expect(out.applied).toEqual(['collapse']);
    expect(calls).toHaveLength(1);
    expect(out.messages[0]?.role).toBe('user');
    const head = out.messages[0]?.role === 'user' ? out.messages[0].content : '';
    expect(head).toContain('投影摘要');
    expect(head).toContain('摘要正文');
    expect(out.stats.collapsedSegments).toBe(1);

    const again = await cw.project(messages, request(2_000));
    expect(again.applied).toEqual(['collapse']);
    expect(calls).toHaveLength(1); // 同一段 head 命中缓存
    expect(again.stats.collapsedSegments).toBe(1); // 累计口径不重复加
  });

  it('摘要失败 → 这一层跳过，保留完整历史，只出声一次', async () => {
    const { cw, warnings } = setup({
      atTokens: 100,
      providerThrows: true,
      layers: { ...COLLAPSE_ONLY, collapseAtRatio: 0.5, collapseUrgentRatio: 3 },
    });
    const messages = turns(10, 'Read', 1_000);

    const first = await cw.project(messages, request());
    const second = await cw.project(messages, request(2_000));

    expect(first.applied).toEqual([]);
    expect(first.messages).toBe(messages);
    expect(second.applied).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('第 4 层折叠跳过');
  });

  it('摘要为空也算失败：不拿一段空话替换历史', async () => {
    const { cw, warnings } = setup({
      atTokens: 100,
      emptyReply: true,
      layers: { ...COLLAPSE_ONLY, collapseAtRatio: 0.5, collapseUrgentRatio: 3 },
    });
    const out = await cw.project(turns(10, 'Read', 1_000), request());
    expect(out.applied).toEqual([]);
    expect(warnings[0]).toContain('没有返回任何文本');
  });

  it('摘要比原文还长时，这一层等于没做', async () => {
    const { cw } = setup({
      atTokens: 100,
      reply: 'x'.repeat(100_000),
      layers: { ...COLLAPSE_ONLY, collapseAtRatio: 0.5, collapseUrgentRatio: 3 },
    });
    const messages = turns(10, 'Read', 1_000);
    const out = await cw.project(messages, request());
    expect(out.applied).toEqual([]);
    expect(out.messages).toBe(messages);
  });

  it('紧急比例用更少的保留轮次', async () => {
    const { cw } = setup({
      atTokens: 100,
      layers: {
        ...COLLAPSE_ONLY,
        collapseAtRatio: 0.4,
        collapseUrgentRatio: 0.5,
        collapseKeepTurns: 8,
        collapseUrgentKeepTurns: 1,
      },
    });
    const out = await cw.project(turns(10, 'Read', 1_000), request());
    // 0.5 × 100 = 50 token，10 轮 × 1000 字符 ≈ 2500 token → 走紧急分支，只留 1 轮。
    expect(out.applied).toEqual(['collapse']);
    expect(out.messages).toHaveLength(3);
  });
});
