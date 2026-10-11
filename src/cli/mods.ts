import type { ModDeps, ModOutcome, ModReport, ModSpec } from '../contract/mod';
import type { Plugin } from '../contract/plugin';
import { spec as agentsMd } from '../../mods/agents-md/index';
import { diffSpec, type PaneRenderer } from '../../mods/diff/index';
import { spec as secDefault } from '../../mods/sec-default/index';
import { spec as telemetry } from '../../mods/telemetry/index';

/**
 * 内建 mod 的装载器。
 *
 * ⚠️ **它自己不 import 任何一个 mod** —— 清单从参数进来（`builtinMods()` 那个清单
 * 是这个文件里唯一 import mod 的地方，且它只是拼一张表）。于是"探针失败会怎样"
 * 能用一个夹具 mod 测出来，而不是靠读代码相信。
 *
 * 两条分寸（P5 设计 §3.3）：
 * 1. **探针失败 → 降级**：不装这个 mod，CLI 照跑 —— 这是出口标准
 *    "可选依赖缺失时主流程无损"，不是优化。
 * 2. **`create` 抛 → 也降级，但必须吼**：那是我们的 bug，不是这台机器的环境问题，
 *    两者在报告里必须分得开（见 `ModOutcome` 的四态）。
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 探针的三种结局：过、说没有、自己坏了。 */
async function probeOf(
  mod: ModSpec,
  deps: ModDeps,
): Promise<{ status: 'ok' } | { status: 'missing'; dep: string } | { status: 'probe-failed'; dep: string; error: string }> {
  for (const dep of mod.optionalDeps ?? []) {
    try {
      if (!(await dep.probe(deps))) return { status: 'missing', dep: dep.name };
    } catch (error) {
      // 探针自己抛 —— 与"这台机器上没有"**不是一回事**，不能混。
      return { status: 'probe-failed', dep: dep.name, error: messageOf(error) };
    }
  }
  return { status: 'ok' };
}

export async function loadMods(
  deps: ModDeps,
  mods: readonly ModSpec[],
): Promise<{ plugins: readonly Plugin[]; report: ModReport }> {
  const outcomes: ModOutcome[] = [];
  const plugins: Plugin[] = [];

  for (const mod of mods) {
    const probed = await probeOf(mod, deps);
    if (probed.status === 'missing') {
      outcomes.push({ name: mod.name, status: 'missing', dep: probed.dep });
      continue;
    }
    if (probed.status === 'probe-failed') {
      outcomes.push({
        name: mod.name,
        status: 'probe-failed',
        dep: probed.dep,
        error: probed.error,
      });
      continue;
    }

    try {
      plugins.push(...mod.create(deps));
      outcomes.push({ name: mod.name, status: 'loaded' });
    } catch (error) {
      // 装载期的失败**不传染**：一个 mod 的 bug 不该让 CLI 起不来。
      outcomes.push({ name: mod.name, status: 'broken', error: messageOf(error) });
    }
  }

  return { plugins, report: { outcomes } };
}

/**
 * 给**人**的报告：只对非 `loaded` 的说话，一行一个。
 *
 * 全都装上了就返回空数组 —— 正常路径上一个字节的额外输出都不许有
 * （与遥测"关着的时候零输出"同一条口径）。
 */
export function describeMods(report: ModReport): readonly string[] {
  const lines: string[] = [];
  for (const outcome of report.outcomes) {
    switch (outcome.status) {
      case 'loaded':
        break;
      case 'missing':
        lines.push(`内建 mod ${outcome.name} 没装：这台机器上没有 ${outcome.dep}。`);
        break;
      case 'probe-failed':
        lines.push(
          `内建 mod ${outcome.name} 没装：它检查 ${outcome.dep} 的那段自己坏了（${outcome.error}）—— 这是 DeepCode 的 bug，不是你的环境问题。`,
        );
        break;
      case 'broken':
        lines.push(
          `内建 mod ${outcome.name} 装配失败（${outcome.error}）—— 这是 DeepCode 的 bug，与它相关的能力本次不可用。`,
        );
        break;
    }
  }
  return lines;
}

/**
 * 清单。顺序是契约：
 * 1. `sec-default` 在前 —— 它坐 `prepend`，要与 `plugin-guard` 挨着（见 `cli/plugins.ts`）；
 * 2. `agents-md` 必须整片排在 `coreTools` **之前** —— 它的嵌套 hook 要等 `next(e)`
 *    回来拿到 `Read` 的结果才能追加（同 tier 内先装载者在外层）。
 *
 * 这两条都由 `cliPlugins` 的拼接顺序保证，不靠这张表碰巧排对 —— 表里的顺序只在
 * 同 tier 内部起作用。
 *
 * `diff` 排最后（P5c）：它**不裁决任何动作**，只贡献 `/diff` 那一条命令的应答者，
 * 与谁在外面无关。它要一个渲染器（`Palette` 归 CLI），所以这个表是个**函数**而不是
 * 一个常量 —— 别的三个 mod 都还是常量。
 */
export function builtinMods(render: PaneRenderer): readonly ModSpec[] {
  return [secDefault, agentsMd, telemetry, diffSpec(render)];
}

/**
 * `/diff` 的"工作区未提交"那一块看不成了时要说的话；装上了返回 `undefined`。
 *
 * P5c 的 §5.3 判据一（"把 git 从 PATH 里拿掉 → `/diff` 降级、其余一切照常"）要的就是
 * 这一句。做法上刻意**不硬编码"缺 git"**：从报告里读，于是换一个可选依赖、
 * 或者以后多一个 mod，这句话自动是对的。
 *
 * 四态的判词与 `describeMods` 同一口径 —— 两处说法漂开的话，
 * 启动时说的和 `/diff` 时说的会不一样，而那是同一件事。
 */
export function paneUnavailable(report: ModReport): string | undefined {
  const outcome = report.outcomes.find((o) => o.name === 'diff');
  if (outcome === undefined || outcome.status === 'loaded') return undefined;
  switch (outcome.status) {
    case 'missing':
      return `工作区那一块看不成了：这台机器上没有 ${outcome.dep}（会话改动照常）。`;
    case 'probe-failed':
      return `工作区那一块看不成了：检查 ${outcome.dep} 的那段自己坏了（${outcome.error}）—— 这是 DeepCode 的 bug。`;
    case 'broken':
      return `工作区那一块看不成了：diff 装配失败（${outcome.error}）—— 这是 DeepCode 的 bug。`;
  }
}
