import { dirname, join } from 'node:path';
import type { EngineInterface } from '../contract/engine';
import type { Plugin } from '../contract/plugin';

/**
 * 计划模式（P14）。
 *
 * 复刻对象的 Plan Mode 不是引擎里的一个 `if (planMode)` 分支，而是两个**普通工具**：
 * `EnterPlanMode` / `ExitPlanMode`。这一份实现遵守同一条口径 —— 引擎循环一个字没改，
 * 计划模式全部落在这个插件里：
 *
 * - `tool.describe`：计划模式下把非只读工具从模型可见清单里藏起来；
 * - `tool.check`：藏起来只是"看不见"，真被点名调用时在准入链上拒绝（fail-closed）；
 * - `prompt.section`：告诉模型为什么工具少了、计划文件在哪、完成时该调 ExitPlanMode；
 * - `turn.start`：数轮次，每 5 轮夹一句提醒（长对话里模型会"手痒"）。
 *
 * ⚠️ 计划模式是**权限收窄**，不是提示词约定。真正拦住 Write / Edit / Bash 的是
 * `tool.check`；系统提示那一节只是让模型少浪费几次被拒的调用。
 *
 * ⚠️ 今天没有 Shift+Tab，手动入口是 `/plan`；计划文件落在 `.deepcode/plans/`
 * （项目自己的目录），不是复刻对象的 `.claude/plans/`。这两条都写进设计文档的偏差清单。
 */

/** 计划模式里允许的只读工具。`Skill` 只把一段正文加载进上下文，不碰磁盘。 */
const PLAN_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill']);

/** 两个模式工具。进入时可见；退出时可见 —— 反过来各自隐藏。 */
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode']);

/** 计划模式下真正会被 `tool.check` 放行的全部名字。 */
const PLAN_ALLOWED = new Set([...PLAN_READ_TOOLS, ...PLAN_TOOLS]);

/** 每几轮提醒一次。数取 5 是照抄复刻对象的节奏，不是测出来的最优值。 */
const REMIND_EVERY = 5;

/** 一个稳定的计划文件名：会话 id 里可能有路径分隔符，先洗掉。 */
function safeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' ? 'session' : cleaned;
}

/**
 * 计划模式的纯状态。插件自己持一个；测试与 benchmark 也可以单独拿它看状态，
 * 不必经过模型。
 */
export type PlanMode = {
  active(): boolean;
  path(): string | undefined;
  /** 计划模式已经过了几轮（`turn.start` 计数）。 */
  turns(): number;
  /** 进入。已经在里面时返回一条状态说明，不重复建文件。 */
  enter($: Pick<EngineInterface, 'session' | 'clock'>): string;
  /** 直接退出（`/plan off`）。已提交的计划文件不动。 */
  leave(): void;
  /** `turn.start` 调一次。 */
  tick(): void;
  /** 当前该注入系统提示的那一节；不在计划模式时 `undefined`。 */
  prompt(): string | undefined;
  /** `/plan` 没带参数时给人看的状态。 */
  status(): string;
};

export function createPlanMode(options: { readonly now?: () => number } = {}): PlanMode {
  let active = false;
  let planPath: string | undefined;
  let turns = 0;

  const status = (): string => {
    if (!active) return '当前不在计划模式。输入 /plan 进入。';
    const where = planPath === undefined ? '' : `计划文件：${planPath}。`;
    return `已经在计划模式（已探索 ${turns} 轮）。${where}用 ExitPlanMode 提交计划，或 /plan off 退出。`;
  };

  return {
    active: () => active,
    path: () => planPath,
    turns: () => turns,
    enter($) {
      if (active) return status();
      const id = safeSessionId($.session.id());
      const now = options.now ?? (() => $.clock.now());
      planPath = join($.session.root(), '.deepcode', 'plans', `plan-${id}-${now()}.md`);
      active = true;
      turns = 0;
      return (
        `已进入计划模式（只读）。计划文件：${planPath}\n` +
        '先用 Read / Glob / Grep 看清现状，把方案写成完整计划，再调用 ExitPlanMode 交给用户批准。'
      );
    },
    leave() {
      active = false;
      planPath = undefined;
      turns = 0;
    },
    tick() {
      if (active) turns += 1;
    },
    prompt() {
      if (!active || planPath === undefined) return undefined;
      // 提示是在 `turn.start` **之前**拼的（REPL 先 build 再 runTurn），所以 `turns`
      // 是已完成的轮数，当前这一轮还没数进去。提醒按"当前是第几轮"算，补上 1 ——
      // 不补的话第 5 轮的提醒会拖到第 6 轮。
      return planModePrompt({ path: planPath, turns: turns + 1 });
    },
    status,
  };
}

/**
 * 计划模式注入系统提示的那一节。纯函数：benchmark 与测试都直接用它。
 *
 * `turns` 是**当前是第几轮**（从 1 开始），第一次提醒落在第 5 轮 —— 与复刻对象的节奏一致。
 * `PlanMode.prompt()` 负责把已完成轮数补成当前轮数。
 */
export function planModePrompt(input: { readonly path: string; readonly turns: number }): string {
  const lines = [
    '计划模式（只读）：',
    '- 你现在只能探索：Read / Glob / Grep / Skill。Write / Edit / Bash / Task 等不在工具清单里。',
    '- 先读现状再下结论，不要猜文件内容；不要尝试改文件。',
    '- 完成探索后调用 ExitPlanMode，把完整计划放进 plan 参数：目标、涉及文件、步骤、验证方式、风险。',
    `- 计划文件：${input.path}`,
  ];
  if (input.turns > 0 && input.turns % REMIND_EVERY === 0) {
    lines.push('- 提醒：你还在计划模式，不要手痒改代码；探索够了就调用 ExitPlanMode。');
  }
  return lines.join('\n');
}

const ENTER_DESCRIPTION =
  '进入计划模式：只能读代码、不能改文件，先探索并把方案整理成计划，再用 ExitPlanMode 交给用户批准。' +
  '适合多文件、方向不确定、需要先比较取舍的任务；改 typo、加日志这类简单任务不要用。';

const EXIT_DESCRIPTION =
  '结束计划模式：把完整计划交给用户批准。plan 必须是完整 markdown（目标、涉及文件、步骤、验证方式、风险）。' +
  '用户批准后恢复读写；不批准则继续留在计划模式。';

const EXIT_SCHEMA = {
  type: 'object',
  properties: {
    plan: { type: 'string', description: '完整的计划 markdown' },
  },
  required: ['plan'],
};

export function createPlanModePlugin(mode: PlanMode = createPlanMode()): Plugin {
  return {
    name: 'plan-mode',
    uses: [
      'tool.call',
      'tool.describe',
      'tool.check',
      'prompt.section',
      'turn.start',
      'command.run',
      'command.describe',
      'fs',
      'ui',
    ],

    register(on) {
      // ── 工具面 ──────────────────────────────────────────────────────────
      // 宽 hook 注册在最前：同插件内先注册者在最外层，于是它在任何工具的
      // describe 之前决定"这一轮看不看得见"，`next(e)` 才落到真正的描述上。
      on('tool.describe', async (_$, e, next) => {
        if (!mode.active()) {
          // 没进计划模式时 ExitPlanMode 是隐身的 —— 模型不该看见一个用不了的出口。
          return e.tool === 'ExitPlanMode' ? ({ hidden: true } as const) : next(e);
        }
        // 计划模式里 EnterPlanMode 也隐身：已经进来了，再进一次没有意义。
        if (e.tool === 'EnterPlanMode') return { hidden: true } as const;
        return PLAN_ALLOWED.has(e.tool) ? next(e) : ({ hidden: true } as const);
      });

      on('tool.describe', { tool: 'EnterPlanMode' }, () => ({
        description: ENTER_DESCRIPTION,
        inputSchema: { type: 'object', properties: {} },
      }));

      on('tool.describe', { tool: 'ExitPlanMode' }, () => ({
        description: EXIT_DESCRIPTION,
        inputSchema: EXIT_SCHEMA,
      }));

      // 准入：可见性是第一道，这里是第二道。藏起来不等于够不着 ——
      // 模型可以点名一个它没见过的工具，插件也可以替你应答它（P3 的 todo 插件踩过）。
      on('tool.check', (_$, e, next) => {
        if (!mode.active()) return next(e);
        if (PLAN_ALLOWED.has(e.tool)) return next(e);
        return {
          decision: 'deny',
          rule: `计划模式只读：${e.tool} 不在可用工具里（先 ExitPlanMode 并取得批准）`,
        } as const;
      });

      on('tool.call', { tool: 'EnterPlanMode' }, async ($) => ({ value: mode.enter($) }));

      on('tool.call', { tool: 'ExitPlanMode' }, async ($, e) => {
        if (!mode.active()) {
          return { value: 'ERROR: 当前不在计划模式，没有计划可以批准。' };
        }
        const input = (e.input ?? {}) as Record<string, unknown>;
        const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
        if (plan === '') {
          return {
            value: 'ERROR: 计划是空的。请把完整计划放进 plan 参数（目标、涉及文件、步骤、验证方式、风险）。',
          };
        }
        const path = mode.path();
        if (path === undefined) {
          return { value: 'ERROR: 计划模式状态里没有计划文件路径，无法保存。' };
        }

        try {
          await $.fs.mkdir(dirname(path));
          await $.fs.write(path, `${plan}\n`);
        } catch (error) {
          return { value: `ERROR: 写计划文件失败：${String(error)}` };
        }

        const answer = await $.ui.ask(`批准计划并开始执行？计划文件：${path}`, {
          choices: [
            { value: 'y', label: '批准，开始执行' },
            { value: 'n', label: '继续规划' },
          ],
          // 读不到答案 = 没同意（非交互、EOF、Ctrl-C 都走这条）。
          fallback: 'n',
        });
        const said = answer.trim().toLowerCase();
        if (said !== 'y' && said !== 'yes') {
          return { value: `用户没有批准计划（仍留在计划模式）。计划文件：${path}` };
        }

        mode.leave();
        $.ui.notice('计划已批准，恢复读写权限。');
        return { value: `计划已批准（${path}）。按计划执行；改动前先看现状。` };
      });

      // ── 提示面 ──────────────────────────────────────────────────────────
      on('prompt.section', async (_$, e, next) => {
        const inner = await next(e);
        const text = mode.prompt();
        return text === undefined
          ? inner
          : { sections: [...inner.sections, { name: 'plan-mode', text }] };
      });

      on('turn.start', (_$, e, next) => {
        mode.tick();
        return next(e);
      });

      // ── 手动入口 ────────────────────────────────────────────────────────
      on('command.run', { name: 'plan' }, async ($, e) => {
        const action = (e.args[0] ?? '').trim().toLowerCase();
        if (action === 'off' || action === 'exit' || action === 'stop') {
          if (!mode.active()) {
            $.ui.log('当前不在计划模式。');
            return { handled: true };
          }
          mode.leave();
          $.ui.log('已退出计划模式（计划没有执行）。');
          return { handled: true };
        }
        if (action !== '' && action !== 'on' && action !== 'enter') {
          $.ui.log('用法：/plan 进入计划模式；/plan off 退出。');
          return { handled: true };
        }
        $.ui.log(mode.active() ? mode.status() : mode.enter($));
        return { handled: true };
      });

      on('command.describe', { name: 'plan' }, () => ({
        description: '进入只读计划模式（/plan off 退出）',
        usage: '/plan ｜ /plan off',
      }));
    },
  };
}
