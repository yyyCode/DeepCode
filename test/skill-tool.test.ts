// test/skill-tool.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ModelProvider, StreamEvent, StreamRequest } from '@deepcode/contract/model-provider';
import type { Plugin } from '@deepcode/contract/plugin';
import { CORE_ORIGIN } from '@deepcode/contract/next';
import { confirmPlugin } from '@deepcode/builtins/confirm';
import { createEngine } from '@deepcode/core/create';
import { runTurn, type LoopContext } from '@deepcode/core/loop';
import { discoverSkills } from '@deepcode/cli/skills';
import { createSubagentsPlugin } from '@deepcode/cli/subagents';
import { renderOffer } from '@deepcode/cli/offer';

let root = '';
let home = '';

const BODY = '正文：这个项目写文档的三条规矩。';

const toolUse = (id: string, name: string, input: unknown = {}): StreamEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const done = (stopReason: string): StreamEvent => ({ type: 'done', stopReason });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deepcode-skilltool-'));
  home = await mkdtemp(join(tmpdir(), 'deepcode-skilltool-home-'));
  const dir = join(root, '.deepcode', 'skills', 'design-notes');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: design-notes\ndescription: 本项目的设计口径\n---\n${BODY}`,
  );
});

async function mount(script: readonly (readonly StreamEvent[])[], extra: readonly Plugin[] = []) {
  const requests: StreamRequest[] = [];
  const describes: string[] = [];
  const asks: string[] = [];
  let index = 0;

  const provider: ModelProvider = {
    name: 'test',
    async *stream(req) {
      requests.push(req);
      const events = script[index++] ?? [{ type: 'done', stopReason: 'end_turn' } as const];
      for (const event of events) yield event;
    },
  };

  const observer: Plugin = {
    name: 'test-observer',
    uses: ['tool.describe'],
    register(on) {
      on('tool.describe', (_$, e, next) => {
        describes.push(String(e.tool));
        return next(e);
      });
    },
  };

  const skills = await discoverSkills({ root, home });
  const engine = await createEngine({
    plugins: [
      confirmPlugin,
      createSubagentsPlugin({ agents: [], skills, baseSystemPrompt: '基础提示' }),
      observer,
      ...extra,
    ],
    seating: { 'test-observer': 'prepend' },
    provider,
    ui: {
      print: () => {},
      notice: () => {},
      ask: async (question) => {
        asks.push(question);
        return 'y';
      },
    },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });

  const messages: Message[] = [{ role: 'user', content: '干活' }];
  const ctx: LoopContext = {
    $: engine.$,
    provider,
    signal: new AbortController().signal,
    dispatch: engine.dispatch,
    systemPrompt: '提示',
    turnIndex: 0,
    // 会话里没有真正的工具，只留 Skill 一个 —— 这几条测的是技能，不是工具。
    tools: new Set(['Skill']),
  };

  return { engine, requests, describes, asks, messages, ctx, skills, run: () => runTurn(ctx, messages) };
}

/**
 * 最后一条**工具结果**消息里的第 n 个内容。
 *
 * ⚠️ **别用 `messages.at(-1)`**：loop 在 `break` 之前还会 push 一条 assistant 消息
 * （没有文本时 `content` 是空数组，见 `core/loop.ts:130-139`），所以 turn 跑完之后
 * 最后一条**往往不是**工具消息。这里要的是"上一轮工具拿回了什么"，得往回找。
 * （这条是 T3 执行时实测出来的，原计划的写法三处用例全挂。）
 */
function resultAt(messages: readonly Message[], index = 0): string {
  const last = [...messages].reverse().find((message) => message.role === 'tool');
  if (last?.role !== 'tool') throw new Error('这一轮没有任何工具结果消息');
  return last.results[index]?.content ?? '';
}

describe('C3-14：名册确实进了 system prompt', () => {
  it('技能的 name 与 description 出现在 agent.offer 渲染出来的那一节里', async () => {
    const m = await mount([]);
    const offer = await m.engine.dispatch('agent.offer', {}, CORE_ORIGIN);
    const rendered = renderOffer(offer);
    expect(rendered).toContain('design-notes');
    expect(rendered).toContain('本项目的设计口径');
    // 印的是 description 那一行，不是正文 —— 正文要等命中才进上下文（三层披露的第二层）。
    expect(rendered).not.toContain(BODY);
  });
});

describe('C3-15：Skill 工具', () => {
  it('拿回正文，并带上技能自己的目录（第三层靠它）', async () => {
    const m = await mount([
      [toolUse('u1', 'Skill', { name: 'design-notes' }), done('tool_use')],
      [{ type: 'text', text: '好' }, done('end_turn')],
    ]);
    await m.run();

    const content = resultAt(m.messages);
    expect(content).toContain(BODY);
    expect(content).toContain(join('.deepcode', 'skills', 'design-notes'));
  });

  it('点名不存在的技能 → deny，并把可用的列出来', async () => {
    const m = await mount([]);
    const result = await m.engine.dispatch(
      'tool.call',
      { tool: 'Skill', input: { name: '不存在' }, toolUseId: 'u1' },
      CORE_ORIGIN,
    );
    expect(result).toEqual({
      deny: '没有叫 不存在 的技能。可选的：design-notes',
    });
  });
});

describe('C3-16：skill.prompt 是变换缝', () => {
  it('没人应答时是原文 —— 缝尾不是闸', async () => {
    const m = await mount([]);
    const loaded = await m.engine.$.skill.load({ name: 'design-notes', text: BODY });
    expect(loaded.text).toBe(BODY);
  });

  it('有插件应答时用改写后的正文', async () => {
    // 一个"往里加一句话"的应答者，坐在 prepend（外层），改完交给下面。
    const annotator: Plugin = {
      name: 'test-annotator',
      uses: ['skill.prompt'],
      register(on) {
        on('skill.prompt', (_$, e, next) =>
          next({ name: e.name, text: `${e.text}\n（本轮附加：注意口径）` }),
        );
      },
    };
    const m = await mount(
      [
        [toolUse('u1', 'Skill', { name: 'design-notes' }), done('tool_use')],
        [{ type: 'text', text: '好' }, done('end_turn')],
      ],
      [annotator],
    );
    await m.run();

    const content = resultAt(m.messages);
    expect(content).toContain('（本轮附加：注意口径）');
  });
});
