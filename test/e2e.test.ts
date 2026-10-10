import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, recordingProvider, scriptedProvider, seat } from './harness';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { runTurn } from '../src/core/loop';
import { CORE_ORIGIN } from '../src/contract/next';
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
