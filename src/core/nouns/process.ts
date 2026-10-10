import { spawn } from 'node:child_process';
import type { ProcessNoun } from '../../contract/engine';

export function createProcessNoun(): ProcessNoun {
  return {
    run(command, { cwd, timeoutMs, signal }) {
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
