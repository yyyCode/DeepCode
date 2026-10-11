import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, recordingProvider, scriptedProvider, seat } from './harness';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { createPermissionsPlugin } from '../src/builtins/permissions';
import { runTurn } from '../src/core/loop';
import { CORE_ORIGIN } from '../src/contract/next';
import type { Rule } from '../src/contract/policy';
import type { EngineInterface } from '../src/contract/engine';
import type { Message } from '../src/contract/model-provider';
import type { EventHook } from '../src/contract/plugin';
import type { Tier } from '../src/contract/tier';
import type { Plugin } from '../src/contract/plugin';
import { createFsNoun } from '../src/core/nouns/fs';
import { createProcessNoun } from '../src/core/nouns/process';
import { createStoreNoun } from '../src/core/nouns/store';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-e2e-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function buildWorld(
  answers: string[],
  extra: readonly { plugin: Plugin; tier: Tier }[] = [],
) {
  const asked: string[] = [];
  const engine = {
    session: { id: () => 'e2e', cwd: () => root, root: () => root, signal: () => new AbortController().signal },
    fs: createFsNoun(),
    process: createProcessNoun(),
    store: createStoreNoun(),
    ui: {
      log: () => {},
      notice: () => {},
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? 'n';
      },
    },
    logger: { debug: () => {}, warn: () => {} },
    // 真实内核的 $.tool.list() 是注册面上 `tool.call` 的 matcher 取值（见 nouns/index.ts）。
    // 桩这里不能写成 coreTools.map(p => p.name) —— 那是插件名（'tool-read'），
    // 不是工具名（'Read'）。写错的话 describeTools 会拿插件名去查 tool.describe，
    // 六个工具全部落到 catch 分支被静默略去，E2E 表面上照样绿。
    tool: { list: () => ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch'] },
    command: { list: () => [] },
    model: { stream: async function* () {} },
  } as unknown as EngineInterface;

  // engine 必须传进去：createHarness 漏了它会退回空对象，
  // 工具 hook 里的 `$.fs` 就是 undefined，整个 E2E 会以假乱真地失败。
  const h = createHarness({
    engine,
    coreImpls: {
      'tool.call': (e) => ({ deny: `unknown tool: ${String(e.tool)}` }),
      'tool.check': () => ({ decision: 'deny', rule: 'fail-closed' }),
      'tool.describe': () => {
        throw new Error('no description');
      },
      // 这两条是 P4d 的两道缝的链尾默认值，必须与 create.ts 里那两条逐字一致 ——
      // 手搭的桩是另一条 dispatcher 的路，链尾兜底够不着它（见 dispatch.test.ts 里
      // 那条"两条路"的用例）。漏了的表现是 loop 走到收手时抛 NotImplementedError，
      // 而不是某条断言红。
      'tool.result': () => ({}) as const,
      'turn.stop': () => ({}) as const,
    },
  });

  const seated: readonly { plugin: Plugin; tier: Tier }[] = [
    ...coreTools.map((plugin) => ({ plugin, tier: 'builtin' as const })),
    { plugin: confirmPlugin, tier: 'builtin' as const },
    ...extra,
  ];
  for (const { plugin, tier } of seated) seat(h, plugin, tier);

  return { h, engine, asked };
}

describe('E2E：脚本化模型的完整 turn', () => {
  it('Read → Edit → 收尾，且 Edit 前问过用户', async () => {
    const target = join(root, 'greet.ts');
    await writeFile(target, 'export const greet = () => "hi";\n', 'utf8');

    const { h, engine, asked } = buildWorld(['y']);

    const provider = scriptedProvider([
      [
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: target } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        {
          type: 'tool_use',
          id: 'u2',
          name: 'Edit',
          input: { file_path: target, old_string: '"hi"', new_string: '"hello"' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', text: '改好了。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const messages: Message[] = [{ role: 'user', content: '把 greet 的返回值改成 hello' }];
    await runTurn(
      {
        $: engine,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(await readFile(target, 'utf8')).toBe('export const greet = () => "hello";\n');
    expect(asked).toHaveLength(1);          // 只有 Edit 问了一次；Read 不问
    expect(asked[0]).toContain('Edit');
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('用户拒绝时工具不执行，且拒绝结果回灌给模型', async () => {
    const target = join(root, 'keep.ts');
    await writeFile(target, 'original\n', 'utf8');

    const { h, engine, asked } = buildWorld(['n']);

    const provider = scriptedProvider([
      [
        { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: target, old_string: 'original', new_string: 'changed' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', text: '好的，不改了。' }, { type: 'done', stopReason: 'end_turn' }],
    ]);

    const messages: Message[] = [{ role: 'user', content: '改一下' }];
    await runTurn(
      {
        $: engine,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: '你是 DeepCode。',
        turnIndex: 0,
      },
      messages,
    );

    expect(asked).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe('original\n');
    const toolMessage = messages.find((m) => m.role === 'tool') as Extract<Message, { role: 'tool' }>;
    expect(toolMessage.results[0]!.isError).toBe(true);
    expect(toolMessage.results[0]!.content).toContain('拒绝');
  });

  it('一轮里模型要两个工具，结果合并成一条 tool 消息', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'AAA\n', 'utf8');
    await writeFile(b, 'BBB\n', 'utf8');

    const { h, engine } = buildWorld([]);
    const provider = scriptedProvider([
      [
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: a } },
        { type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: b } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', text: '都看过了。' }, { type: 'done', stopReason: 'end_turn' }],
    ]);

    const messages: Message[] = [{ role: 'user', content: '两个都读一下' }];
    await runTurn(
      { $: engine, provider, signal: new AbortController().signal, dispatch: h.dispatch, systemPrompt: 'x', turnIndex: 0 },
      messages,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const results = (toolMessages[0] as Extract<Message, { role: 'tool' }>).results;
    expect(results.map((r) => r.toolUseId)).toEqual(['u1', 'u2']);
    expect(results[0]!.content).toContain('AAA');
  });
});

describe('E2E：按权限过滤工具可见性', () => {
  it('整工具 deny 的工具从模型可见清单里消失，参数化 deny 的不消失', async () => {
    const rules: Rule[] = [
      { raw: 'WebSearch', tool: 'WebSearch', decision: 'deny' },
      { raw: 'Bash(git push:*)', tool: 'Bash', content: 'git push:*', decision: 'deny' },
    ];

    const { h, engine } = buildWorld([], [
      { plugin: createPermissionsPlugin({ rules }), tier: 'user' },
    ]);

    // 每个工具都真的给出一份描述。桩里 coreImpls['tool.describe'] 是**故意**抛错的
    // （模拟"这个工具没有描述"），不补这一步的话"被隐藏"与"没描述"在模型眼里
    // 是同一件事——都不在清单里——于是把 hidden 分支删掉测试也照样绿。
    // 这条用例的全部价值就在于把这两件事分开。
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch']) {
      h.on('builtin', `fake-${name}`, 'tool.describe', { tool: name }, (() => ({
        description: `${name} 的描述`,
        inputSchema: {},
      })) as EventHook);
    }

    const { provider, lastTools } = recordingProvider();
    await runTurn(
      {
        $: engine,
        provider,
        signal: new AbortController().signal,
        dispatch: h.dispatch,
        systemPrompt: 'x',
        turnIndex: 0,
      },
      [{ role: 'user', content: '随便说点什么' }],
    );

    // 模型"看得见什么"只能从 provider 收到的 tools 清单里验 —— 别处看不见。
    expect(lastTools()).not.toContain('WebSearch');
    // 为了拦一条命令就把整个 Bash 藏掉是灾难 —— 参数化 deny 绝不隐藏工具。
    expect(lastTools()).toContain('Bash');
  });
});
