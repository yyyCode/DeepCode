import { describe, expect, it } from 'vitest';

import { CONTEXT_MARKER, withContext } from '@deepcode/contract/prompt-channel';

describe('withContext', () => {
  it('没有上下文时原样返回，不留标记', () => {
    expect(withContext('原文', undefined)).toBe('原文');
    expect(withContext('原文', '')).toBe('原文');
    // 纯空白也算没有：一个只有空白的标记块是纯粹的噪声。
    expect(withContext('原文', '   \n ')).toBe('原文');
  });

  it('有上下文时追加，并带上唯一的那个标记', () => {
    expect(withContext('原文', '  补充  ')).toBe(`原文\n\n${CONTEXT_MARKER}\n补充`);
  });

  it('标记只在一处定义 —— 这个字面量改了就该这里红', () => {
    expect(CONTEXT_MARKER).toBe('[钩子补充的上下文]');
  });
});
