import type { Palette } from './ansi';
import type { Plugin } from '../contract/plugin';
import { fullyDeniedTools, type Rule } from '../contract/policy';
import type { SessionGrants } from '../builtins/permissions';
import type { ResolvedPolicy, SettingsSource } from './settings';

/**
 * `/permissions`：把当前生效的权限设置摊开给人看。
 *
 * 住 `cli/`（与 `createSessionCommands` 同理）：它要着色、要一份设置快照，
 * 不是内建工具层的事。
 *
 * 它存在的理由不只是方便：整套设计里有**两处**失败方向是"不收紧"（单条规则
 * 解析失败、托管文件坏掉），兜底全靠"吼出来 + 这里看得到"。审计输出是那两处
 * 唯一的补救手段，不是附加功能。
 *
 * ⚠️ **本次会话记住的规则也在这儿**，而且比别处更该在：`a` 是一条**不落盘**的授权，
 * 这份输出是它唯一的账。看不见就等于"我到底放行了什么"只能靠回忆。
 */
export type PermissionsCommandDeps = {
  readonly policy: ResolvedPolicy;
  readonly palette: Palette;
  /** 与 `permissions` 插件**同一个引用**（`cli/plugins.ts` 建的那一份）。 */
  readonly grants: SessionGrants;
};

export function createPermissionsCommand(deps: PermissionsCommandDeps): Plugin {
  return {
    name: 'permissions-command',
    uses: ['command.run', 'command.describe', 'ui'],

    register(on) {
      on('command.run', { name: 'permissions' }, ($, e) => {
        // `/permissions forget`：把本次会话记住的清掉。
        // 没有这一条的话，`a` 就是一道**单向门** —— 按错了只能重启进程。
        if (e.args[0] === 'forget') {
          const before = deps.grants.list().length;
          deps.grants.clear();
          $.ui.log(
            before === 0
              ? '本次会话没有记住任何规则，没什么可忘的。'
              : `忘掉了本次会话记住的 ${before} 条规则，接下来照旧逐条问你。`,
          );
          return { handled: true };
        }

        $.ui.log(renderPermissions(deps.policy, deps.palette, deps.grants));
        return { handled: true };
      });

      on('command.describe', { name: 'permissions' }, () => ({
        description: '看当前生效的权限来源与规则（`/permissions forget` 忘掉本次会话记住的）',
      }));
    },
  };
}

const NAME_WIDTH = 8;

function countsOf(rules: readonly Rule[]): string {
  const allow = rules.filter((r) => r.decision === 'allow').length;
  const ask = rules.filter((r) => r.decision === 'ask').length;
  const deny = rules.filter((r) => r.decision === 'deny').length;
  return `${rules.length} 条（allow ${allow} / ask ${ask} / deny ${deny}）`;
}

export function renderPermissions(
  policy: ResolvedPolicy,
  palette: Palette,
  grants: SessionGrants,
): string {
  const lines: string[] = [];

  lines.push('权限来源（低 → 高）');
  for (const info of policy.sources) {
    const name = info.source.padEnd(NAME_WIDTH);
    const where = info.path ?? '--settings 未给';
    if (info.state === 'broken') {
      lines.push(`  ${name} ${where}`);
      lines.push(`  ${' '.repeat(NAME_WIDTH)} ${palette.red(`坏掉了：${info.error ?? '读不了'}`)}`);
      continue;
    }
    const mark = info.source === 'policy' ? '  ← 托管' : '';
    const state = info.state === 'missing' ? '不存在' : countsOf(info.rules);
    lines.push(`  ${name} ${where}  ${state}${mark}`);
  }

  // 生效规则按 来源顺序（低 → 高）逐条列出，每条带上是哪一层给的 ——
  // 层序本身不参与裁决，它只在这里有用。
  lines.push('');
  lines.push('生效规则');
  const effective = policy.sources.flatMap((info) => info.rules.map((rule) => ({ rule, from: info.source })));
  if (effective.length === 0) {
    lines.push('  （一条都没有：所有动作都按最小确认走）');
  }
  for (const { rule, from } of effective) {
    const behavior = rule.decision.padEnd(6);
    const colored = rule.decision === 'deny' ? palette.red(behavior) : behavior;
    lines.push(`  ${colored} ${rule.raw.padEnd(34)} ${sourceLabel(from)}`);
  }

  // 会话里记住的。**单独一段**而不是并进上面那张表：它们的出处不是任何一个文件，
  // 退出就没了 —— 混进"来源"那张表会让人以为自己也写了什么设置。
  const held = grants.list();
  lines.push('');
  lines.push('本次会话记住的（按 `a` 批准，进程退出即失）');
  if (held.length === 0) {
    lines.push('  （一条都没有：每次写盘 / 跑命令都还是会问你）');
  }
  for (const rule of held) {
    lines.push(`  ${'allow'.padEnd(6)} ${rule.raw.padEnd(34)} [session]`);
  }

  // 插件名单。它与权限规则同源（同一批 settings 文件），所以摊在一起看 ——
  // 一份"我明明禁用了它"的误判，只有在这里看得见。
  const plugins = [
    ...policy.plugins.enable.map((rule) => ({ verb: 'enable', ...rule })),
    ...policy.plugins.deny.map((rule) => ({ verb: 'deny', ...rule })),
  ];
  if (plugins.length > 0) {
    lines.push('');
    lines.push('插件（enable 只认 project / local / flag；deny 五层取并集）');
    for (const plugin of plugins) {
      const verb = plugin.verb === 'deny' ? palette.red(plugin.verb.padEnd(6)) : plugin.verb.padEnd(6);
      lines.push(`  ${verb} ${plugin.name.padEnd(24)} ${sourceLabel(plugin.source)}`);
    }
  }

  const hidden = [
    ...fullyDeniedTools(policy.policyRules),
    ...fullyDeniedTools(policy.personalRules),
  ];
  if (hidden.length > 0) {
    lines.push('');
    lines.push('隐藏的工具（整工具 deny，模型看不见它们）');
    for (const tool of hidden) lines.push(`  ${tool}`);
  }

  const problems = policy.sources.flatMap((info) =>
    info.problems.map((problem) => ({ problem, from: info.source })),
  );
  if (problems.length > 0) {
    lines.push('');
    lines.push(palette.red(`有问题、未生效的规则（${problems.length} 条）`));
    for (const { problem, from } of problems) {
      lines.push(`  ${sourceLabel(from)}  ${problem}`);
    }
  }

  lines.push('');
  lines.push('规则里的路径按绝对路径匹配（~ 会展开成主目录）；相对路径不会命中。');
  lines.push('更严的永远赢：deny > ask > allow，与规则写在哪一层、写成什么顺序无关。');

  return lines.join('\n');
}

function sourceLabel(source: SettingsSource): string {
  return `[${source}]`;
}
