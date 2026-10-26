import { describe, expect, it } from 'vitest';
import type { DispatchFn } from '../src/core/dispatch';
import { createPromptBuilder } from '../src/cli/system-prompt';

type Section = { readonly name: string; readonly text: string };

/**
 * 会变的 `prompt.section`：每次调它都重新问一次 `current()` ——
 * 这正是"会话中改了 `AGENTS.md`"的形状（插件每轮重读文件，见 `mods/agents-md`）。
 */
function stubDispatch(current: () => readonly Section[]) {
  const events: string[] = [];
  const dispatch = (async (event: string) => {
    events.push(event);
    if (event === 'prompt.section') return { sections: current() };
    if (event === 'agent.offer') {
      return { agents: [{ name: '审阅者', description: '专挑毛病' }], skills: [] };
    }
    return {};
  }) as unknown as DispatchFn;
  return { dispatch, events };
}

describe('系统提示每轮重算（P7 §3.2）', () => {
  it('同一轮里改动的东西，下一轮就进去了 —— 不用重启', async () => {
    let sections: readonly Section[] = [{ name: 'instructions', text: '规矩：先写测试' }];
    const { dispatch } = stubDispatch(() => sections);
    const builder = createPromptBuilder({ sections: [{ name: 'base', text: '基础提示' }], dispatch });

    const first = await builder.build();
    expect(first.text).toContain('先写测试');
    expect(first.text).not.toContain('别动 main');

    // 会话进行到一半，用户把 AGENTS.md 改了（插件那边就是重新读了一遍盘）。
    sections = [{ name: 'instructions', text: '规矩：别动 main' }];

    const second = await builder.build();
    expect(second.text).toContain('别动 main');
    expect(second.text).not.toContain('先写测试'); // 旧的**不留**：提示不是追加，是重算
  });

  it('分节只算一份：`text` 就是 `pieces` 拼出来的，`/context` 的账才对得上', async () => {
    const { dispatch } = stubDispatch(() => [{ name: 'instructions', text: '规矩：先写测试' }]);
    const builder = createPromptBuilder({ sections: [{ name: 'base', text: '基础提示' }], dispatch });
    const built = await builder.build();

    expect(built.text).toBe(built.pieces.map((piece) => piece.text).join('\n\n'));
    expect(built.pieces.map((piece) => piece.name)).toEqual(['base', 'instructions', 'offer']);
    expect(built.text).toContain('审阅者'); // 清单一节来自 `agent.offer`，也真的进去了
  });

  it('空段不进 `pieces`：拼出来的 `text` 与分节账严格同一批', async () => {
    const { dispatch } = stubDispatch(() => [
      { name: 'instructions', text: '' }, // 空 = 这一层没有文件
      { name: 'local', text: '只在本机生效的约定' },
    ]);
    const builder = createPromptBuilder({ sections: [{ name: 'base', text: '基础提示' }], dispatch });
    const built = await builder.build();

    expect(built.pieces.map((piece) => piece.name)).toEqual(['base', 'local', 'offer']);
    expect(built.text).toBe(['基础提示', '只在本机生效的约定', built.pieces[2]?.text].join('\n\n'));
  });

  it('每轮都真的重问一次引擎（两个事件都派出去）', async () => {
    const { dispatch, events } = stubDispatch(() => []);
    const builder = createPromptBuilder({ sections: [{ name: 'base', text: '基础提示' }], dispatch });
    await builder.build();
    await builder.build();
    expect(events).toEqual(['prompt.section', 'agent.offer', 'prompt.section', 'agent.offer']);
  });

  it('`last()` 之前说没算过，算过之后给的是**最后**那一份', async () => {
    let sections: readonly Section[] = [{ name: 'instructions', text: '第一版' }];
    const { dispatch } = stubDispatch(() => sections);
    const builder = createPromptBuilder({ sections: [{ name: 'base', text: '基础提示' }], dispatch });

    expect(builder.last()).toBeUndefined(); // `/context` 靠这个说"这一轮还没算过"

    await builder.build(); // 第一次 build 的返回值也**不**是同一个对象复用，直接比内容
    sections = [{ name: 'instructions', text: '第二版' }];
    const after = await builder.build();

    expect(builder.last()?.text).toBe(after.text);
    expect(builder.last()?.text).toContain('第二版');
  });
});
