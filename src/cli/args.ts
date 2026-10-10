import { readFileSync } from 'node:fs';

/**
 * 认识几个开关，其余的 argv 一律拼成一句提示词 —— 那是这个 CLI 的主要用法：
 * 参数没有别的含义，所以"把没认出来的东西当提示词"本来就是对的，
 * 唯一的问题是 `--help` 这类请求会被当成话发给模型。
 */
export type ResumeTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'id'; readonly id: string };

export type StartupAction =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'prompt'; text: string; resume: ResumeTarget };

/** `-V` 而不是 `-v`：后者在太多工具里是 verbose，别去抢那个字母。 */
const HELP_FLAGS = ['--help', '-h'];
const VERSION_FLAGS = ['--version', '-V'];

/** 只认等号形态，没有 `-r` 短开关（`-v` 的教训：别去抢别处有含义的短字母）。 */
const RESUME = '--resume';

export function parseArgs(argv: readonly string[]): StartupAction {
  // help 优先于 version，两者都优先于 resume 与提示词。
  if (argv.some((arg) => HELP_FLAGS.includes(arg))) return { kind: 'help' };
  if (argv.some((arg) => VERSION_FLAGS.includes(arg))) return { kind: 'version' };

  let resume: ResumeTarget = { kind: 'none' };
  const rest: string[] = [];

  for (const arg of argv) {
    if (arg === RESUME) {
      resume = { kind: 'latest' };
      continue;
    }
    // 只认 `--resume=<id>`。写成"--resume 后面跟一个裸 token"的话，
    // `deepcode --resume 继续修` 里那句话到底是 id 还是提示词，语法上分不开。
    if (arg.startsWith(`${RESUME}=`)) {
      const id = arg.slice(RESUME.length + 1).trim();
      resume = id === '' ? { kind: 'latest' } : { kind: 'id', id };
      continue;
    }
    // 认出来的开关要从提示词里摘掉，否则 "--resume" 会被当成话发给模型。
    rest.push(arg);
  }

  return { kind: 'prompt', text: rest.join(' ').trim(), resume };
}

export function readVersion(): string {
  // 从 package.json 现读，免得版本号在两个地方各写一份、然后慢慢漂移。
  // main.ts 在 src/cli/ 下由 tsx 直接跑，编译出去则在 dist/cli/ 下，两级都能回到包根。
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
}

export const HELP_TEXT = `DeepCode —— 终端里的 agentic 编码助手

用法
  deepcode [一句话]        给一句话，跑完退出
  deepcode                 不带参数进入交互式会话
  deepcode --resume        接上当前目录最近一次会话
  deepcode --resume=<id>   接上指定会话
  deepcode --help          显示这份说明
  deepcode --version       显示版本号

会话里
  /help  列出命令与工具        /exit  退出（Ctrl-D 也行）
  /diff  看本会话改过哪些文件    /clear 清空上下文（磁盘上的转录保留）
  Ctrl-C 掐断当前这一回合，进程不退，可以接着聊

配置（优先级 高 → 低）
  环境变量 > 项目级 <工作目录>/.deepcode/config.json > 用户级 ~/.deepcode/config.json

  ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN   API key
  DEEPCODE_MODEL / ANTHROPIC_MODEL           模型 id（默认 claude-sonnet-5-5）
  ANTHROPIC_BASE_URL                         API 端点（换兼容端点时用）
  DEEPCODE_PROVIDER                          provider：anthropic / openai（默认 anthropic）
  DEEPCODE_DEBUG=1                           打印调试轨迹

会话落盘
  ~/.deepcode/projects/<工作目录>/sessions/<id>.jsonl
  转录里有代码内容，删掉文件就等于删掉那次会话。

安全
  Read / Glob / Grep 只读，不询问。
  Write / Edit / Bash 每次都要你按一行 y —— 非 TTY（管道、CI）下默认拒绝，
  且有意没有自动放行开关。工具能碰到你进程权限内的任何路径，没有围栏。
`;
