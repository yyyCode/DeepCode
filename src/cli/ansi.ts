export type Palette = {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  red(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
};

type ColorStream = { readonly isTTY?: boolean };

/**
 * NO_COLOR 的约定是"设了**且非空**"才关（空串等于没设）；
 * FORCE_COLOR=0 与不设同义 —— 有些 CI 会把它设成 0 而不是删掉。
 */
export function colorEnabled(
  stream: ColorStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.NO_COLOR ?? '') !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

/**
 * 关掉着色的输出必须与"根本没有这个模块"**逐字节相同** ——
 * 现有测试断言的是纯文本，而管道、重定向到文件时带转义序列是明确有害的。
 */
export function createPalette(enabled: boolean = colorEnabled()): Palette {
  const wrap = (code: number, text: string): string =>
    enabled ? `\u001b[${code}m${text}\u001b[0m` : text;

  return {
    enabled,
    bold: (text) => wrap(1, text),
    dim: (text) => wrap(2, text),
    italic: (text) => wrap(3, text),
    red: (text) => wrap(31, text),
    green: (text) => wrap(32, text),
    cyan: (text) => wrap(36, text),
  };
}
