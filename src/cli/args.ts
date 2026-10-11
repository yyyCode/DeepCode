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
  | { kind: 'plugin'; sub: 'help' }
  | { kind: 'plugin'; sub: 'list' }
  | { kind: 'plugin'; sub: 'validate'; dir: string }
  | { kind: 'plugin'; sub: 'add'; name: string; from: string }
  | { kind: 'plugin'; sub: 'remove'; name: string }
  | { kind: 'prompt'; text: string; resume: ResumeTarget; settings: string | undefined };

/** `-V` 而不是 `-v`：后者在太多工具里是 verbose，别去抢那个字母。 */
const HELP_FLAGS = ['--help', '-h'];
const VERSION_FLAGS = ['--version', '-V'];

/** 只认等号形态，没有 `-r` 短开关（`-v` 的教训：别去抢别处有含义的短字母）。 */
const RESUME = '--resume';

/** 同样只认等号形态：它指向一个文件路径，裸写没法跟提示词区分开。 */
const SETTINGS = '--settings';

/** 与 `--settings=` 同一条理由：它指向一个目录，裸写没法跟位置参数区分开。 */
const FROM = '--from';

export function parseArgs(argv: readonly string[]): StartupAction {
  // help 优先于 version，两者都优先于 resume 与提示词。
  if (argv.some((arg) => HELP_FLAGS.includes(arg))) return { kind: 'help' };
  if (argv.some((arg) => VERSION_FLAGS.includes(arg))) return { kind: 'version' };

  // 子命令：**第一个非开关 token 恰好是 `plugin`，且第二个是 validate/list** 才进子命令模式。
  // 其余一律照旧当提示词 —— `deepcode plugin 系统怎么写` 是句正经提问，
  // 把"plugin"抢成保留字会让它变成一条报错。
  const plugin = parsePluginCommand(argv);
  if (plugin !== undefined) return plugin;

  let resume: ResumeTarget = { kind: 'none' };
  let settings: string | undefined;
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
    // `--settings=<路径>`：沿用 `--resume=<id>` 的先例，**只认等号形式**。
    // 裸 `--settings` 仍是被拼进提示词的普通文本 —— 它没有"默认值"可言，
    // 与 `--resume`（裸写 = 最近一次）不一样。
    if (arg.startsWith(`${SETTINGS}=`)) {
      const value = arg.slice(SETTINGS.length + 1).trim();
      settings = value === '' ? undefined : value;
      continue;
    }
    // 认出来的开关要从提示词里摘掉，否则 "--resume" 会被当成话发给模型。
    rest.push(arg);
  }

  return { kind: 'prompt', text: rest.join(' ').trim(), resume, settings };
}

export function readVersion(): string {
  // 从 package.json 现读，免得版本号在两个地方各写一份、然后慢慢漂移。
  // main.ts 在 src/cli/ 下由 tsx 直接跑，编译出去则在 dist/cli/ 下，两级都能回到包根。
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
}

/**
 * 认出 `plugin list` / `plugin validate <目录>` / 光一个 `plugin`。
 *
 * 只在**第一个非开关 token** 上认它，且后面必须跟 validate/list：`--resume plugin list`
 * 里那个 plugin 是 token 流里的第一个非开关词，照样进子命令；而
 * `deepcode plugin 系统怎么写` 的第二个词不是子命令名，整个回落到提示词。
 */
function parsePluginCommand(argv: readonly string[]): StartupAction | undefined {
  const first = argv.findIndex((arg) => !arg.startsWith('-'));
  if (first === -1 || argv[first] !== 'plugin') return undefined;

  const sub = argv[first + 1];
  if (sub === undefined) return { kind: 'plugin', sub: 'help' };
  if (sub === 'list') return { kind: 'plugin', sub: 'list' };
  if (sub === 'validate') {
    const dir = argv[first + 2];
    return dir === undefined ? { kind: 'plugin', sub: 'help' } : { kind: 'plugin', sub: 'validate', dir };
  }
  if (sub === 'add') {
    // `--from` 只认等号形态（`--from=<目录>`），先例是 `--resume=` 与 `--settings=`。
    // 它**可以出现在任意位置**：`from` 整条 argv 里找，名字则取子命令之后**第一个非开关 token**
    // —— 这一步不能写成 `argv[first + 2]`：`--from=…` 以 `-` 开头，它排在名字前面时
    // 会把那个位置占了，于是名字被读成 `--from=…` 而被判非法。
    const name = argv.slice(first + 2).find((arg) => !arg.startsWith('-'));
    const from = argv.find((arg) => arg.startsWith(`${FROM}=`))?.slice(FROM.length + 1).trim();
    if (name === undefined || from === undefined || from === '') {
      // 少了名字或 `--from` 就打说明 —— 与 `validate` 少了目录同一种处置。
      // 说明里写着这两个参数怎么写，所以这不是一条死胡同。
      return { kind: 'plugin', sub: 'help' };
    }
    return { kind: 'plugin', sub: 'add', name, from };
  }
  if (sub === 'remove') {
    const name = argv[first + 2];
    if (name === undefined || name.startsWith('-')) return { kind: 'plugin', sub: 'help' };
    return { kind: 'plugin', sub: 'remove', name };
  }
  return undefined;
}

export const HELP_TEXT = `DeepCode —— 终端里的 agentic 编码助手

用法
  deepcode [一句话]        给一句话，跑完退出
  deepcode                 不带参数进入交互式会话
  deepcode --resume        接上当前目录最近一次会话
  deepcode --resume=<id>   接上指定会话
  deepcode --settings=<路径>  改用这份权限设置（压不过托管策略）
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

插件
  用户级 ~/.deepcode/plugins/<名字>/plugin.json        自动装载
  项目级 <工作目录>/.deepcode/plugins/<名字>/plugin.json  要在设置里 plugins.enable 之后才装
  deepcode plugin list             列出装上的与跳过的，各带理由
  deepcode plugin validate <目录>  只校验一份清单，不执行任何代码
  deepcode --help                  这份说明
  第三方插件只能拧紧不能拧松：它的判定要么拦下、要么往下交，放行一律忽略。

权限：
  allow / ask / deny 三组规则，写在 .deepcode/settings.json 里，五个来源从低到高：
  ~/.deepcode/settings.json < <项目>/.deepcode/settings.json <
  <项目>/.deepcode/settings.local.json < --settings=<路径> < 托管策略文件
  （Windows 是 %ProgramFiles%\DeepCode\managed-settings.json）。
  规则形如 "Bash"、"Read(~/.ssh/**)"、"Bash(git push:*)"。更严的永远赢。
  会话里用 /permissions 看当前生效的规则。

安全
  Read / Glob / Grep 只读，不询问。
  Write / Edit / Bash 每次都要你按一行 y —— 非 TTY（管道、CI）下默认拒绝，
  且有意没有自动放行开关。工具能碰到你进程权限内的任何路径，没有围栏。
`;
