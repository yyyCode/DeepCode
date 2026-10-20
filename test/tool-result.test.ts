import { describe, expect, it } from 'vitest';
import type { Plugin } from '@deepcode/contract/plugin';
import type { Message, ModelProvider, StreamEvent, ToolResult } from '@deepcode/contract/model-provider';
import type { Args } from '@deepcode/contract/events';
import type { LoopContext } from '@deepcode/core/loop';
import { runTurn } from '@deepcode/core/loop';
import { createEngine } from '@deepcode/core/create';
import { CONTEXT_MARKER } from '@deepcode/contract/prompt-channel';

type Seen = Args<'tool.result'>;

/**
 * `tool.result` 的观测面。用 `createEngine` 而不是 harness：这条要验的是**真实装配**里的
 * 链尾兜底与多种拒绝路径（尤其"没有应答者时 fail-closed 的 tool.check 会拦下一切"）
 * —— harness 手搭的 coreImpls 会把这些绕过去。
 */
function observerPlugin(seen: Seen[], context: string | undefined): Plugin {
  return {
    name: 'test-observer',
    uses: ['tool.result'],
    register(on) {
      on('tool.result', (_$, e) => {
        seen.push(e);
        return context === undefined ? {} : { context };
      });
    },
  };
}

function checkPlugin(decision: 'allow' | 'ask' | 'deny'): Plugin {
  return {
    name: 'test-check',
    uses: ['tool.check'],
    register(on) {
      on('tool.check', () => ({ decision }) as const);
    },
  };
}

function toolPlugin(called: string[], value: string): Plugin {
  return {
    name: 'test-tools',
    uses: ['tool.call', 'tool.describe'],
    register(on) {
      on('tool.describe', { tool: 'Read' }, () => ({ description: '读', inputSchema: {} }));
      on('tool.call', { tool: 'Read' }, () => {
        called.push('Read');
        return { value };
      });
    },
  };
}

function denyPlugin(): Plugin {
  return {
    name: 'test-deny',
    uses: ['tool.call'],
    register(on) {
      on('tool.call', { tool: 'Read' }, () => ({ deny: '沙箱不许' }));
    },
  };
}

type Options = {
  value?: string;
  decision?: 'allow' | 'ask' | 'deny';
  callDeny?: boolean;
  tools?: readonly string[];
  answer?: string;
  context?: string | undefined;
};

async function run(options: Options = {}) {
  const seen: Seen[] = [];
  const called: string[] = [];
  const plugins: Plugin[] = [
    // deny 那个必须排在**工具之前**：同 tier 内先装载者在外层，而工具那个 hook
    // 应答完就不往下走了（它没有 next 可调）—— 排在后面等于永远轮不到。
    ...(options.callDeny === true ? [denyPlugin()] : []),
    toolPlugin(called, options.value ?? 'ok'),
    checkPlugin(options.decision ?? 'allow'),
    observerPlugin(seen, options.context),
  ];

  const provider: ModelProvider = {
    name: 'scripted',
    async *stream(_req): AsyncGenerator<StreamEvent> {
      yield { type: 'tool_use', id: 'u1', name: 'Read', input: { path: 'a' } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };

  const { $, dispatch } = await createEngine({
    plugins,
    provider,
    ui: { print: () => {}, notice: () => {}, ask: async () => options.answer ?? 'y' },
    sessionInfo: { id: 's1', cwd: process.cwd(), root: process.cwd() },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $,
    provider,
    signal: new AbortController().signal,
    dispatch,
    systemPrompt: 's',
    turnIndex: 0,
    // 一次就够：派完 tool.result 之后没人再要工具，loop 自然收手。
    maxHops: 1,
    ...(options.tools === undefined ? {} : { tools: new Set(options.tools) }),
  };

  await runTurn(ctx, messages);
  const tool = messages.find((m) => m.role === 'tool');
  const result: ToolResult | undefined = tool?.role === 'tool' ? tool.results[0] : undefined;
  return { seen, called, result };
}

describe('tool.result —— 派发时机', () => {
  it('工具跑成功了就派，参数是这一次调用的真实样子', async () => {
    const { seen, result } = await run();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tool: 'Read',
      input: { path: 'a' },
      toolUseId: 'u1',
      ok: true,
      output: 'ok',
    });
    expect(result?.content).toBe('ok');
  });

  it('工具自己报了错也派 —— 它**跑过**了，只是返回了一段 ERROR: 正文', async () => {
    const { seen, result } = await run({ value: 'ERROR: 文件不存在' });
    expect(seen[0]?.ok).toBe(false);
    expect(seen[0]?.output).toBe('ERROR: 文件不存在');
    expect(result?.isError).toBe(true);
  });
});

describe('tool.result —— 钩子说的话怎么进对话', () => {
  it('返回的 context 追加在那条工具结果后面，模型下一条消息就读到', async () => {
    const { result } = await run({ context: '这个文件被 .gitignore 盖住了' });
    expect(result?.content).toBe(`ok\n\n${CONTEXT_MARKER}\n这个文件被 .gitignore 盖住了`);
  });

  it('没人应答 = 一个字节都不加（链尾是缝，不是闸）', async () => {
    const { result } = await run();
    expect(result?.content).toBe('ok');
  });
});

describe('tool.result —— 没跑的工具不派', () => {
  it('tool.check 判 deny', async () => {
    const { seen, called } = await run({ decision: 'deny' });
    expect(seen).toHaveLength(0);
    expect(called).toEqual([]);
  });

  it('用户在 ask 上答了 n', async () => {
    const { seen, called } = await run({ decision: 'ask', answer: 'n' });
    expect(seen).toHaveLength(0);
    expect(called).toEqual([]);
  });

  it('tool.call 自己返回 deny（工具压根没执行）', async () => {
    const { seen, called } = await run({ callDeny: true });
    expect(seen).toHaveLength(0);
    expect(called).toEqual([]);
  });

  it('白名单外的工具 —— 连 tool.check 都没走到', async () => {
    const { seen, called } = await run({ tools: [] });
    expect(seen).toHaveLength(0);
    expect(called).toEqual([]);
  });
});
