import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args';

describe('deepcode web 的参数', () => {
  it('光一个 web 进网页模式，默认随机端口、自动开浏览器', () => {
    expect(parseArgs(['web'])).toEqual({ kind: 'web', port: undefined, open: true });
  });

  it('--port=<n> 与 --no-open', () => {
    expect(parseArgs(['web', '--port=3080', '--no-open'])).toEqual({
      kind: 'web',
      port: 3080,
      open: false,
    });
  });

  it('端口不合法 → 回落到提示词（不是死胡同）', () => {
    expect(parseArgs(['web', '--port=abc']).kind).toBe('prompt');
    expect(parseArgs(['web', '--port=0']).kind).toBe('prompt');
    expect(parseArgs(['web', '--port=65536']).kind).toBe('prompt');
    expect(parseArgs(['web', '--port']).kind).toBe('prompt');
  });

  it('web 后面还有别的话 → 整句是提示词', () => {
    expect(parseArgs(['web', '前端怎么写']).kind).toBe('prompt');
  });

  it('web 前面还有别的开关 → 不认（那还是句提示词）', () => {
    const action = parseArgs(['--resume', 'web']);
    expect(action.kind).toBe('prompt');
  });
});
