import type { Plugin } from '../contract/plugin';

/** 只读工具，不需要确认。 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 不碰磁盘、不执行命令，但也不是"读一个文件"的那一类：借道放行，不问。
 *
 * - `Skill`：把一段文本加载进上下文 —— 与 `Read` 同类。
 * - `Task` / `Explore`：派一个子代理。**放过它绝不等于免确认**：子代理内部每一次工具调用
 *   都要再走一遍这条链（`core/loop.ts` 是同一个 `runTurn`），它要写文件照样弹 y/N。
 *   在派发工具上再问一次只是让用户多按一次 y，还会误导出"我批准了 Task
 *   就是批准了它接下来做的一切"。
 *   `Explore` 多一层资格：只有声明了 `readOnly: true` 且带 `tools` 的 agent 能被它选中，
 *   内核还会拿实际面逐个核对（`core/nouns/agent.ts`）。**这一道是能力判断，不是权限放宽。**
 * - `EnterPlanMode` / `ExitPlanMode`：计划模式的两个开关。它们自己就是一次权限收窄/恢复，
 *   Exit 还会单独问用户批不批准计划；在本链上再问一次只会问两遍。计划模式真正的
 *   只读判定在 `builtins/plan.ts` 的 `tool.check`，这一条只是"确认器认识它们"。
 *
 * ⚠️ 这几个名字**必须**在这儿，否则它们一出生就是死的：下面那条"不认识的工具 → deny"
 * 会把它们当场拒掉。这是 P3 的 `todo` 插件踩过的同一个坑 ——
 * 它的注释（`plugins/todo/main.mjs`）说得很清楚：插件工具要么自己在 `builtin` 之外
 * 答一次 `tool.check`，要么确认器得认识它。`Task`/`Skill`/计划模式工具是第一方工具，
 * 走第二条。
 */
const PASS_THROUGH_TOOLS = new Set([
  'Skill',
  'Task',
  'Explore',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/** 会改动磁盘或执行命令的工具，需要确认。 */
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'Bash']);

export const confirmPlugin: Plugin = {
  name: 'confirm',
  // ⚠️ 这里**没有 `ui`** 了：确认框那一屏预览（P6c）搬去了 `cli/preview-view.ts`。
  // 边界规则不许 `builtins/` import `Palette`（`builtins` 只许 import `contract`），
  // 而"要上色"是那一屏的要求 —— 于是分工回到它该在的地方：
  // **这个插件决定"要不要问"，长什么样是引擎的事**（与 `mods/diff` 同一条道理）。
  uses: ['tool.check'],

  register(on) {
    on('tool.check', async (_$, e) => {
      const tool = e.tool;

      if (READ_ONLY_TOOLS.has(tool)) return { decision: 'allow' };

      // 借道放行：它们自己不碰磁盘，但经手的事情会在别处再走一遍这条链。
      if (PASS_THROUGH_TOOLS.has(tool)) return { decision: 'allow' };

      if (!MUTATING_TOOLS.has(tool)) {
        // 不认识的工具：拒绝，不是放行。
        return { decision: 'deny', rule: `未知工具 ${tool}，不在确认器的白名单里` };
      }

      // 只给裁决，不问人也不印字 —— loop 拿到 ask 之后统一问，界面在问之前印预览。
      return { decision: 'ask', rule: `最小确认：${tool}` };
    });
  },
};
