import type { SandboxConfig } from '../../contract/sandbox';
import { candidatePaths } from '../../contract/sandbox';
import { expandHome, matchesRule, slashes } from '../../contract/policy';

/** 放行 / 拒绝 + **理由**。"被拒了但不说为什么"是这一整套东西里最招人恨的一种失败。 */
export type SandboxVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 判一条命令过不过沙箱。**纯函数、零 IO** —— 真正"不起进程"的那一步在 `process.ts` 里。
 *
 * 判定顺序：
 * 1. 没开 → 放行（零开销）。
 * 2. 一个候选都没有 → 放行（`ls`、`git status` 这类不受影响）。
 * 3. 白名单**非空**时，每个候选都得被它接住，否则拒。
 * 4. 每个候选再过一遍 deny，任一条命中就拒。
 * 5. 全过 → 放行。
 *
 * `cwd` 用来解析相对路径，`home` 用来展开 `~` —— 这两步**必须在调用侧做**，
 * 而权限链的调用侧刻意不做，所以这里是唯一一处。
 */
export function checkSandbox(
  command: string,
  opts: { readonly cwd: string; readonly home: string },
  config: SandboxConfig,
): SandboxVerdict {
  if (!config.enabled) return { ok: true };

  const candidates = candidatePaths(command);
  if (candidates.length === 0) return { ok: true };

  for (const token of candidates) {
    const path = absolute(token, opts);
    // 合成一个 `Write` 调用喂给权限链的匹配器：沙箱判的永远是"会不会写到"，不是"读还是写"。
    const call = { tool: 'Write', input: { file_path: path } };

    if (config.allow.length > 0 && !config.allow.some((rule) => matchesRule(rule, call))) {
      return {
        ok: false,
        reason: `路径 ${path} 不在沙箱白名单里（白名单有 ${config.allow.length} 条，只有托管层能设）。`,
      };
    }

    const denied = config.deny.find((rule) => matchesRule(rule, call));
    if (denied !== undefined) {
      return { ok: false, reason: `路径 ${path} 命中沙箱规则 ${denied.raw}` };
    }
  }

  return { ok: true };
}

/**
 * token → 绝对路径。`~` 展开、反斜杠归一、`..` 折掉、连续分隔符折一 ——
 * 后两步与 `matchesPath` 的调用侧是同一条归一。
 */
function absolute(token: string, opts: { readonly cwd: string; readonly home: string }): string {
  const expanded = expandHome(slashes(token), slashes(opts.home));
  const rooted =
    expanded.startsWith('/') || /^[A-Za-z]:\//.test(expanded)
      ? expanded
      : `${slashes(opts.cwd).replace(/\/+$/, '')}/${expanded}`;
  return popDotSegments(rooted).replace(/\/+/g, '/');
}

/**
 * 文本折叠 `..` —— **不看文件系统**。`/x/../etc/passwd` 必须与 `/etc/passwd` 等价，
 * 否则一条 `/etc/**` 的 deny 会被两个点安静地绕过（那是 fail-open）。
 */
function popDotSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}
