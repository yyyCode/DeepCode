import type { Palette } from './ansi';
import type { Plugin } from '../contract/plugin';
import { fullyDeniedTools, type Rule } from '../contract/policy';
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
 */
export type PermissionsCommandDeps = {
  readonly policy: ResolvedPolicy;
  readonly palette: Palette;
};

export function createPermissionsCommand(deps: PermissionsCommandDeps): Plugin {
  return {
    name: 'permissions-command',
    uses: ['command.run', 'ui'],

    register(on) {
      on('command.run', { name: 'permissions' }, ($) => {
        $.ui.log(renderPermissions(deps.policy, deps.palette));
        return { handled: true };
      });
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

export function renderPermissions(policy: ResolvedPolicy, palette: Palette): string {
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
