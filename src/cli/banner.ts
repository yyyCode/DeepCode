import type { Palette } from './ansi';

/**
 * 开场那一屏。**只在真终端里画**（`main.ts` 那道 `interactive` 门），
 * 管道与一次性模式下它一个字节都不产出 —— 与活动面同一条纪律
 * （见 `render.ts` 顶部：非 TTY 的输出必须逐字节不变）。
 *
 * 它只回答四个问题，因为这四件事是"刚打开一个陌生工具"时最想知道的：
 * 我是谁（版本）、我在跟谁说话（模型与端点）、我在哪个目录里动手（工作区）、
 * 这次会话能不能接上（会话 id / `--resume`）。
 *
 * **刻意不做的事**：不画边框（那是整屏 TUI 的形态，本阶段明确不做），
 * 不查有没有新版本、不读网络、不显示 API key 的任何一截。
 * 每一行都是纯文本 —— 关掉色时逐字节就是它本来的样子。
 */
export type BannerInfo = {
  readonly version: string;
  readonly model: string;
  readonly provider: string;
  /** 换过兼容端点时写出来。**不是秘密**（真正不能露的是 apiKey，这里一个字都不提）。 */
  readonly baseUrl?: string;
  readonly root: string;
  /** 这次会话的 id。省略 = 这次不落盘（建不了转录文件）。 */
  readonly sessionId?: string;
};

export function banner(info: BannerInfo, palette: Palette): readonly string[] {
  const where = info.baseUrl === undefined ? '' : `  ${palette.dim(info.baseUrl)}`;
  return [
    `${palette.bold('▟▛ DeepCode')} ${palette.dim(`v${info.version}`)}  ${palette.dim('终端里的 agentic 编码助手')}`,
    '',
    // 标签按**显示宽度**对齐到 8 列：`模型` / `会话` 是 4 列，`工作区` 是 6 列。
    `  ${palette.dim('模型    ')} ${info.model}${palette.dim(`（${info.provider}）`)}${where}`,
    `  ${palette.dim('工作区  ')} ${info.root}`,
    info.sessionId === undefined
      ? `  ${palette.dim('会话    ')} ${palette.dim('这次不落盘（建不了转录文件），--resume 接不上')}`
      : `  ${palette.dim('会话    ')} ${info.sessionId}${palette.dim('  —— 退出后 deepcode --resume 能接上')}`,
    '',
    `  ${palette.dim('/help 命令与工具 · /diff 本会话改动 · Ctrl-C 打断当前回合 · Ctrl-D 退出')}`,
  ];
}
