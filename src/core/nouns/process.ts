import { spawn } from 'node:child_process';
import type { ProcessNoun } from '../../contract/engine';

export function createProcessNoun(): ProcessNoun {
  return {
    run(command, { cwd, timeoutMs, signal }) {
      // 本 turn 已经中断了就别起进程：用户刚按完 Ctrl-C，命令还照跑完，
      // 等于把那次中断当没看见。这是确认路径上的 fail-open，宁可当作已被掐断。
      if (signal.aborted) {
        return Promise.resolve({ stdout: '', stderr: '[用户中断]', exitCode: -1 });
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
