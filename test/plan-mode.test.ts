import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from '../src/core/create';
import { listTools } from '../src/core/tool-list';
import { coreTools } from '../src/builtins/tools';
import { confirmPlugin } from '../src/builtins/confirm';
import { createPlanMode, createPlanModePlugin } from '../src/builtins/plan';
import { CORE_ORIGIN } from '../src/contract/next';
import type { EngineInterface } from '../src/contract/engine';
import type { ModelProvider } from '../src/contract/model-provider';

/**
 * 计划模式（P14）。
 *
 * 这一套只验**权限与形状**，不验模型会不会用：Enter/Exit 是两个普通工具，
 * 计划模式本身是 `tool.check` + `tool.describe` 的一次状态判定。
 */

const provider: ModelProvider = {
  name: 'stub',
  async *stream() {
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
};

type World = {
  readonly root: string;
  readonly mode: ReturnType<typeof createPlanMode>;
  readonly $: EngineInterface;
  readonly dispatch: ReturnType<typeof createEngine> extends Promise<infer T>
    ? T extends { dispatch: infer D }
      ? D
      : never
    : never;
  readonly asks: string[];
  readonly notices: string[];
  close(): Promise<void>;
};

async function setup(answer = 'y'): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'deepcode-plan-'));
  const mode = createPlanMode({ now: () => 123 });
  const asks: string[] = [];
  const notices: string[] = [];
  const { $, dispatch } = await createEngine({
    plugins: [createPlanModePlugin(mode), ...coreTools, confirmPlugin],
    provider,
    ui: {
      print: () => {},
      notice: (line) => notices.push(line),
      ask: async (question) => {
        asks.push(question);
        return answer;
      },
    },
    sessionInfo: { id: 's1', cwd: root, root },
    env: {},
    signal: () => new AbortController().signal,
  });
  return {
    root,
    mode,
    $,
    dispatch,
    asks,
    notices,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

let worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.map((world) => world.close()));
  worlds = [];
});

async function world(answer = 'y'): Promise<World> {
  const made = await setup(answer);
  worlds.push(made);
  return made;
}

async function toolNames(w: World): Promise<string[]> {
  const listing = await listTools({ $: w.$, dispatch: w.dispatch });
  return listing.specs.map((spec) => spec.name);
}

async function enter(w: World): Promise<string> {
  const result = await w.dispatch(
    'tool.call',
    { tool: 'EnterPlanMode', input: {}, toolUseId: 'enter' },
    CORE_ORIGIN,
  );
  return 'value' in result ? String(result.value) : '';
}

async function exit(w: World, plan: string): Promise<string> {
  const result = await w.dispatch(
    'tool.call',
    { tool: 'ExitPlanMode', input: { plan }, toolUseId: 'exit' },
    CORE_ORIGIN,
  );
  return 'value' in result ? String(result.value) : '';
}

describe('进入计划模式', () => {
  it('EnterPlanMode 把状态打开，并在系统提示里加一节', async () => {
    const w = await world();
    const said = await enter(w);

    expect(said).toContain('计划模式');
    expect(w.mode.active()).toBe(true);
    const prompt = await w.dispatch('prompt.section', {}, CORE_ORIGIN);
    expect(prompt.sections.some((section) => section.name === 'plan-mode')).toBe(true);
    expect(prompt.sections.find((section) => section.name === 'plan-mode')?.text).toContain(
      '只读',
    );
  });

  it('计划模式下模型只看得到只读工具与 ExitPlanMode', async () => {
    const w = await world();
    const before = await toolNames(w);
    expect(before).toContain('EnterPlanMode');
    expect(before).not.toContain('ExitPlanMode');

    await enter(w);
    const after = await toolNames(w);
    for (const name of ['Read', 'Glob', 'Grep', 'ExitPlanMode']) {
      expect(after).toContain(name);
    }
    for (const name of ['Write', 'Edit', 'Bash', 'EnterPlanMode']) {
      expect(after).not.toContain(name);
    }
  });

  it('工具清单被藏起来了，直接点名调用仍然会在 tool.check 被拒', async () => {
    const w = await world();
    await enter(w);

    const denied = await w.dispatch(
      'tool.check',
      { tool: 'Write', input: { file_path: join(w.root, 'a.ts') }, toolUseId: 'u1' },
      CORE_ORIGIN,
    );
    expect(denied.decision).toBe('deny');
    expect(denied.rule).toContain('计划模式');

    const allowed = await w.dispatch(
      'tool.check',
      { tool: 'Read', input: { file_path: join(w.root, 'a.ts') }, toolUseId: 'u2' },
      CORE_ORIGIN,
    );
    expect(allowed.decision).toBe('allow');
  });
});

describe('退出计划模式', () => {
  it('空计划不写盘、不退出', async () => {
    const w = await world();
    await enter(w);

    const said = await exit(w, '   ');

    expect(said).toContain('ERROR');
    expect(w.mode.active()).toBe(true);
    expect(w.asks).toHaveLength(0);
  });

  it('批准后写计划文件、恢复写工具', async () => {
    const w = await world('y');
    await enter(w);
    const plan = '# 计划\n\n1. 改 A\n2. 跑测试\n';

    const said = await exit(w, plan);

    expect(said).toContain('已批准');
    expect(w.mode.active()).toBe(false);
    expect(w.asks).toHaveLength(1);
    expect(w.asks[0]).toContain('批准');
    const saved = await readFile(join(w.root, '.deepcode', 'plans', 'plan-s1-123.md'), 'utf8');
    expect(saved).toContain('# 计划');
    expect(await toolNames(w)).toContain('Write');
  });

  it('拒绝后留在计划模式，计划文件仍然保存', async () => {
    const w = await world('n');
    await enter(w);

    const said = await exit(w, '# 再想想\n');

    expect(said).toContain('没有批准');
    expect(w.mode.active()).toBe(true);
    expect(await readFile(join(w.root, '.deepcode', 'plans', 'plan-s1-123.md'), 'utf8')).toContain(
      '# 再想想',
    );
  });
});

describe('计划模式的提醒与手动入口', () => {
  it('每 5 轮在 system prompt 里夹一张小纸条', async () => {
    const w = await world();
    await enter(w);

    // 提示是在 `turn.start` **之前**拼的，所以数完 3 轮、正要进第 4 轮时不该有提醒；
    // 数完 4 轮、正要进第 5 轮时才该有。进入当轮算第 1 轮。
    for (let index = 0; index < 3; index++) {
      await w.dispatch('turn.start', { index }, CORE_ORIGIN);
    }
    const before = await w.dispatch('prompt.section', {}, CORE_ORIGIN);
    const beforeText = before.sections.find((section) => section.name === 'plan-mode')?.text ?? '';
    expect(beforeText).not.toContain('提醒：');

    await w.dispatch('turn.start', { index: 3 }, CORE_ORIGIN);
    const after = await w.dispatch('prompt.section', {}, CORE_ORIGIN);
    const afterText = after.sections.find((section) => section.name === 'plan-mode')?.text ?? '';
    expect(afterText).toContain('提醒：');
  });

  it('/plan 进入，/plan off 退出', async () => {
    const w = await world();

    const entered = await w.dispatch(
      'command.run',
      { name: 'plan', args: [] },
      CORE_ORIGIN,
    );
    expect(entered).toEqual({ handled: true });
    expect(w.mode.active()).toBe(true);

    const left = await w.dispatch(
      'command.run',
      { name: 'plan', args: ['off'] },
      CORE_ORIGIN,
    );
    expect(left).toEqual({ handled: true });
    expect(w.mode.active()).toBe(false);
  });
});
