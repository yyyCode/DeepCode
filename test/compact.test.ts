import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamRequest } from '../src/contract/model-provider';
import type { DispatchFn } from '../src/core/dispatch';
import { createPersister, createTranscript } from '../src/cli/transcript';
import { SUMMARIZE_PROMPT, createCompactor, splitAt } from '../src/cli/compact';
import type { CompactConfig } from '../src/cli/settings';
import type { Persister } from '../src/cli/transcript';

const CONFIG: CompactConfig = { auto: false, atTokens: 100_000, keepTurns: 2 };

/**
 * 一轮 = 一条 user 消息及其之后的一切。造 n 轮。
 *
 * 内容**刻意写得长**（`FILLER`）：真实会话每轮几百字，而且只有原文足够长，
 * "一条摘要 + 最近 N 轮"才可能真的比原文短 —— 用 `问题1` / `回答1` 这种三四字的
 * 假消息时，压完反而更长（12 条 36 字 → 5 条 46 字），`C2-12c` 那条守卫会挡下它，
 * 于是一条与压缩无关的假绿/假红就出现了。
 */
const FILLER = '细节'.repeat(20);
function turns(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: 'user', content: `问题${i}：${FILLER}` });
    out.push({ role: 'assistant', content: [{ type: 'text', text: `回答${i}：${FILLER}` }] });
  }
  return out;
}

/** 会记账的摘要 provider。 */
function summaryProvider(behavior: { text?: string; throw?: Error } = {}) {
  const requests: StreamRequest[] = [];
  const provider: ModelProvider = {
    name: 'stub',
    async *stream(req) {
      requests.push(req);
      if (behavior.throw !== undefined) throw behavior.throw;
      yield { type: 'text', text: behavior.text ?? '摘要正文' } as const;
      yield { type: 'done', stopReason: 'end_turn' } as const;
    },
  };
  return { provider, requests };
}

function setup(
  over: { provider?: ModelProvider; config?: CompactConfig; messages?: Message[] } = {},
) {
  const messages: Message[] = over.messages ?? turns(6);
  const seen: unknown[] = [];
  const warnings: string[] = [];
  const seed = over.provider ?? summaryProvider().provider;

  const dispatch = (async (event: string, args: unknown) => {
    seen.push({ event, args });
    return {};
  }) as unknown as DispatchFn;

  const compact = createCompactor({
    messages,
    provider: seed,
    dispatch,
    persist: Object.assign(async () => {}, { reseed: () => {} }) as Persister,
    config: over.config ?? CONFIG,
    warn: (line) => warnings.push(line),
    signal: () => new AbortController().signal,
  });

  return { compact, messages, seen, warnings };
}

describe('splitAt：轮边界按 role === "user" 数', () => {
  it('保留最近 N 轮，切在倒数第 N 条 user 消息上', () => {
    expect(splitAt(turns(6), 2)).toBe(8); // 6 轮共 12 条，倒数第 2 条 user 在下标 8
  });

  it('历史不够 → undefined（没有可压的）', () => {
    expect(splitAt(turns(2), 2)).toBeUndefined();
  });

  it('切点落在第 0 条 → undefined（压了等于没压）', () => {
    expect(splitAt(turns(3), 3)).toBeUndefined();
  });
});

describe('压缩的形状与失败方向', () => {
  it('C2-10 压完 = 一条摘要 + 最近 N 轮原文', async () => {
    const original = turns(6);
    const { compact, messages } = setup({ messages: [...original] });
    expect(await compact.run('manual')).toBe(true);

    expect(messages.length).toBe(1 + 4); // 1 条摘要 + 2 轮 × 2 条
    expect(messages[0]?.role).toBe('user');
    const summary = messages[0]?.role === 'user' ? messages[0].content : '';
    expect(summary).toContain('摘要正文');
    expect(summary).toContain('8 条消息'); // 被压掉的条数要让模型知道
    // 最近两轮是**原文照搬**，不是重新生成的：拿原始数组的最后四条比。
    // （别拿 `turns(2)` 比 —— 它的编号从 1 起，会比到"回答2"，与"回答6"差着四轮。）
    expect(messages.slice(1)).toEqual(original.slice(-4));
  });

  it('摘要那一轮**绝不带工具**', async () => {
    const stub = summaryProvider();
    const { compact } = setup({ provider: stub.provider });
    await compact.run('manual');
    expect(stub.requests[0]?.tools).toEqual([]);
    expect(stub.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: SUMMARIZE_PROMPT });
  });

  it('C2-12a 摘要调用抛错 → 不压缩、出声、原文一条不动', async () => {
    const before = turns(6);
    const { compact, messages, warnings } = setup({
      messages: [...before],
      provider: summaryProvider({ throw: new Error('网络炸了') }).provider,
    });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('网络炸了');
  });

  it('C2-12b 摘要返回空 → 同上', async () => {
    const before = turns(6);
    const { compact, messages, warnings } = setup({
      messages: [...before],
      provider: summaryProvider({ text: '   ' }).provider,
    });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('没有返回任何文本');
  });

  it('C2-12c 压完反而更长 → 放弃，原文一条不动（这一条最容易漏）', async () => {
    const before: Message[] = [{ role: 'user', content: '一' }, ...turns(4)];
    const { compact, messages, warnings } = setup({
      messages: [...before],
      provider: summaryProvider({ text: '啰'.repeat(5_000) }).provider,
    });
    expect(await compact.run('manual')).toBe(false);
    expect(messages).toEqual(before);
    expect(warnings.join('\n')).toContain('没有比原文短');
  });

  it('C2-13 派了 session.compact，trigger 分得清 manual / auto', async () => {
    const manual = setup();
    await manual.compact.run('manual');
    expect(manual.seen).toEqual([
      { event: 'session.compact', args: { trigger: 'manual', tokensBefore: expect.any(Number) } },
    ]);

    const auto = setup({ config: { ...CONFIG, auto: true } });
    await auto.compact.run('auto');
    expect(auto.seen).toEqual([
      { event: 'session.compact', args: { trigger: 'auto', tokensBefore: expect.any(Number) } },
    ]);
  });
});

describe('阈值与提醒', () => {
  it('没到阈值不出声', async () => {
    const { compact, warnings } = setup();
    compact.note({ inputTokens: 10, estimated: false });
    await compact.afterTurn();
    expect(warnings).toEqual([]);
  });

  it('跨过阈值出声**一次**，不每轮刷屏', async () => {
    const { compact, warnings } = setup({ config: { ...CONFIG, atTokens: 100 } });
    compact.note({ inputTokens: 200, estimated: false });
    await compact.afterTurn();
    await compact.afterTurn();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('/compact');
  });

  it('估出来的数出声时要说明是估的', async () => {
    const { compact, warnings } = setup({ config: { ...CONFIG, atTokens: 100 } });
    compact.note({ inputTokens: 200, estimated: true });
    await compact.afterTurn();
    expect(warnings[0]).toContain('估');
  });

  it('`auto: true` 时顺手压，不再只是提醒', async () => {
    const { compact, messages, warnings } = setup({
      config: { ...CONFIG, auto: true, atTokens: 100 },
    });
    compact.note({ inputTokens: 200, estimated: false });
    await compact.afterTurn();
    expect(messages.length).toBeLessThan(12);
    expect(warnings.join('\n')).toContain('已压缩');
  });
});

describe('P7 干预面：/compact <说明> 进摘要那一轮', () => {
  it('给了说明就拼进去，且摘要要求原样在前面', async () => {
    const stub = summaryProvider();
    await setup({ provider: stub.provider }).compact.run('manual', '保住 API 设计决策');
    const ask = stub.requests[0]?.messages.at(-1);
    const text = ask !== undefined && ask.role === 'user' ? ask.content : '';
    expect(text.startsWith(SUMMARIZE_PROMPT)).toBe(true);
    expect(text).toContain('保住 API 设计决策');
  });

  it('全空白当没给 —— 摘要请求与 P7 之前逐字节相同', async () => {
    const stub = summaryProvider();
    await setup({ provider: stub.provider }).compact.run('manual', '   ');
    expect(stub.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: SUMMARIZE_PROMPT });
  });
});

describe('P7 断电器：连试到上限就停手，不每轮烧钱刷屏', () => {
  /** 每一轮的"仍超阈值"。断电器只管自动压缩，所以这几条都开 `auto`。 */
  const AUTO: CompactConfig = { auto: true, atTokens: 100, keepTurns: 2 };

  it('连续 3 次摘要失败 → 停手：第 4 轮不再调摘要，停手只说一次', async () => {
    const stub = summaryProvider({ text: '   ' }); // 空摘要 = 失败
    const { compact, warnings } = setup({ provider: stub.provider, config: AUTO });
    for (let round = 0; round < 4; round++) {
      compact.note({ inputTokens: 200, estimated: false });
      await compact.afterTurn();
    }
    expect(stub.requests.length).toBe(3); // 第 4 轮已经停手
    const said = warnings.join('\n');
    expect(said).toContain('已停手');
    expect(said).toContain('/compact'); // 报的是**可操作**的错，不是一句"没做成"
  });

  it('停手之后手动 /compact 还能再试一次（并且解停手）', async () => {
    const stub = summaryProvider({ text: '   ' });
    const { compact } = setup({ provider: stub.provider, config: AUTO });
    for (let round = 0; round < 4; round++) {
      compact.note({ inputTokens: 200, estimated: false });
      await compact.afterTurn();
    }
    expect(await compact.run('manual')).toBe(false); // 摘要还是失败，但**真的又试了**
    expect(stub.requests.length).toBe(4);
  });

  it('连压 3 次仍超阈值 → 抖动：第 4 次不再压', async () => {
    const stub = summaryProvider();
    // ⚠️ 这条测试**每轮都要让会话再长一轮**，不能对着同一个数组连压四次。
    // 原因是压缩的形状决定的：压完之后待压的历史只剩**一条摘要**，第二次再压
    // 它并不会更短，`C2-12c`（"压完反而更长就放弃"）先一步把第二次判成"没做成"，
    // 于是走的根本是失败断路器那条路，抖动那条闸永远挨不着。
    // 真实抖动长这样：会话一轮一轮地长、压缩每一次都真成了，可测量出来的用量
    // **始终越线** —— 那说明超长的那部分在 `keepTurns` 保下来的尾巴里，删老消息删不掉它。
    // 用量由 `note` 喂进来，所以这里每轮**照样报 200**就是在模拟"量了还是超"。
    const { compact, messages, warnings } = setup({
      provider: stub.provider,
      config: { auto: true, atTokens: 100, keepTurns: 4 },
      messages: turns(8),
    });
    const grown = (label: string): Message[] => [
      { role: 'user', content: `新问题${label}：${FILLER}` },
      { role: 'assistant', content: [{ type: 'text', text: `新回答${label}：${FILLER}` }] },
    ];

    for (let round = 0; round < 4; round++) {
      messages.push(...grown(`${round}a`), ...grown(`${round}b`), ...grown(`${round}c`));
      compact.note({ inputTokens: 200, estimated: false });
      await compact.afterTurn();
    }

    expect(stub.requests.length).toBe(3); // 前三次真压了，第四次停手
    expect(warnings.join('\n')).toContain('仍然超过阈值');
  });

  it('中途掉回阈值之下 → 计数归零，下一次撞上还能自动压', async () => {
    const stub = summaryProvider();
    const { compact } = setup({ provider: stub.provider, config: AUTO });
    for (let round = 0; round < 2; round++) {
      compact.note({ inputTokens: 200, estimated: false });
      await compact.afterTurn();
    }
    compact.note({ inputTokens: 10, estimated: false }); // 掉下去了
    await compact.afterTurn();
    compact.note({ inputTokens: 200, estimated: false });
    await compact.afterTurn();
    expect(stub.requests.length).toBe(3);
  });
});

describe('C2-11 游标：压缩之后继续落盘，不错位、不重复', () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'deepcode-compact-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('压缩 + 继续说话之后，转录里新增的那一批正好是新的那些', async () => {
    const cwd = join(home, 'proj');
    const original = turns(10); // 20 条，`alreadySaved` 全是 20
    const transcript = await createTranscript({ home, cwd, model: 'm', provider: 'anthropic' });
    const persist = createPersister(transcript, 0);
    await persist(original);
    // 接上旧会话的样子：游标从 20 起
    const resumed = createPersister(transcript, original.length);

    const messages: Message[] = [...original];
    const compact = createCompactor({
      messages,
      provider: summaryProvider({ text: '早前的摘要' }).provider,
      dispatch: (async () => ({})) as unknown as DispatchFn,
      persist: resumed,
      config: CONFIG,
      warn: () => {},
      signal: () => new AbortController().signal,
    });

    expect(await compact.run('manual')).toBe(true);
    expect(messages.length).toBeLessThan(original.length);

    messages.push({ role: 'user', content: '新的问题' });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: '新的回答' }] });
    await resumed(messages);

    // 再长过旧游标，走一遍"错位切片"那条路
    for (let i = 0; i < 15; i++) messages.push({ role: 'user', content: `补${i}` });
    await resumed(messages);

    const onDisk = (await readFile(transcript.path, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; message?: Message })
      .filter((record) => record.type === 'message')
      .map((record) => record.message);

    // 盘上 = **未被改写的原始 20 条** + 压缩之后真正新增的那些（一条不漏、一条不重）。
    // 这三条断言连起来把"错位"那条路径钉死了：没有 `reseed` 时第三条数不对、
    // 第二条取到的是内存里**别的**一批（`补13`、`补14`），两条都会红。
    expect(onDisk.slice(0, original.length)).toEqual(original);
    expect(onDisk.slice(original.length)).toEqual([
      { role: 'user', content: '新的问题' },
      { role: 'assistant', content: [{ type: 'text', text: '新的回答' }] },
      ...Array.from({ length: 15 }, (_, i) => ({ role: 'user' as const, content: `补${i}` })),
    ]);
    expect(onDisk.length).toBe(original.length + 2 + 15);
  });
});
