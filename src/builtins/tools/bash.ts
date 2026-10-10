import type { Plugin } from '../../contract/plugin';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 40_000;

export const bashTool: Plugin = {
  name: 'tool-bash',
  uses: ['tool.call', 'tool.describe', 'process'],

  register(on) {
    on(
      'tool.describe',
      { tool: 'Bash' },
      () => ({
        description:
          '在工作目录里执行一条 shell 命令，返回 stdout/stderr 与退出码。用于跑测试、构建、git 等。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            cwd: { type: 'string', description: '工作目录，默认会话根目录' },
            timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}` },
          },
          required: ['command'],
        },
      }),
    );

    on('tool.call', { tool: 'Bash' }, async ($, e) => {
      const input = e.input as { command: string; cwd?: string; timeout_ms?: number };
      if (!input?.command) return { value: 'ERROR: 缺少 command 参数' };
      const cwd = input.cwd ?? $.session.root();

      const result = await $.process.run(input.command, {
        cwd,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: $.session.signal(),
      });

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);

      // 非零退出必须用 ERROR: 开头。loop 只看这个前缀来决定 tool_result 的 is_error，
      // 而 is_error 是模型判断"这一步失败了"的主要依据（设计文档 §4.2 要求如此，
      // 系统提示里也写了失败会以 ERROR: 开头）。原先退出码只是末行 `[退出码 N]`，
      // 前缀判定不成立 —— 模型跑挂了测试，收到的却是一个 is_error:false 的"成功"，
      // 于是很可能回一句"测试都过了"。
      let output =
        result.exitCode === 0
          ? [...parts, '[退出码 0]'].join('\n')
          : [`ERROR: 命令以退出码 ${result.exitCode} 结束`, ...parts].join('\n');
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n... 输出已截断`;
      }

      // 命令失败也是给模型的信息，不是崩溃 —— 所以这里仍然返回 value 而不是抛。
      return { value: output };
    });
  },
};
