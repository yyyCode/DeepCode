import { spawn } from 'node:child_process';
import type { ProcessNoun } from '@deepcode/contract/engine';
import type { SandboxConfig } from '@deepcode/contract/sandbox';
import { checkSandbox } from './sandbox';

export type ProcessDeps = {
  /**
   * 沙箱。**省略 = 没有闸**（既有测试与一次性使用的桩都是这个分支），
   * 生产里由 `cli/main.ts` 从五层设置里透传进来。
   */
  readonly sandbox?: { readonly config: SandboxConfig; readonly home: string };
};

export function createProcessNoun(deps: ProcessDeps = {}): ProcessNoun {
  return {
    run(command, { cwd, timeoutMs, signal }) {
      // 本 turn 已经中断了就别起进程：用户刚按完 Ctrl-C，命令还照跑完，
      // 等于把那次中断当没看见。这是确认路径上的 fail-open，宁可当作已被掐断。
      if (signal.aborted) {
        return Promise.resolve({ stdout: '', stderr: '[用户中断]', exitCode: -1 });
      }

      // ⚠️ 沙箱判定在**这一层**，位于整条权限链的**下游**：任何 `allow` 规则（用户的、将来插件的）
      // 最多只能把调用送到这儿，送不到闸门外面去。这是"个人规则掀不翻托管策略"从政策层面
      // 升级成结构层面的那一步 —— 不靠自觉，靠位置。
      //
      // 它**不是事件、不是 hook**，这是有意的：谁都能挂 hook 的东西做不了闸，
      // 一个坐在 prepend 上的第三方插件随手就能把它换掉。
      if (deps.sandbox !== undefined) {
        const verdict = checkSandbox(command, { cwd, home: deps.sandbox.home }, deps.sandbox.config);
        if (!verdict.ok) {
          // 复用名词**已有的**"没真跑成"形状（abort 与超时就是这么返回的），
          // 于是它在 bash.ts 那边**自动**变成带 `ERROR:` 前缀的工具错误给模型看 ——
          // 一行都不用改 bash.ts。
          return Promise.resolve({ stdout: '', stderr: `[沙箱拒绝] ${verdict.reason}`, exitCode: -1 });
        }
      }

      return new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (exitCode: number, extra?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr: extra ? `${stderr}\n${extra}` : stderr, exitCode });
        };

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(-1, `[命令超时 ${timeoutMs}ms 已终止]`);
        }, timeoutMs);

        const onAbort = () => {
          child.kill('SIGKILL');
          finish(-1, '[用户中断]');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // addEventListener 不会为"已经 abort 过的 signal"补发事件。上面那个入口检查
        // 到这一行之间还夹着 spawn —— 挤进这个窗口的 Ctrl-C 会就此丢失，命令照跑完。
        if (signal.aborted) onAbort();

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => finish(-1, String(err)));
        child.on('close', (code) => finish(code ?? -1));
      });
    },
  };
}
