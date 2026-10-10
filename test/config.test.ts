import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/cli/config';

const HOME = '/home/u';
const ROOT = '/work/p';
const USER_PATH = `${HOME}/.deepcode/config.json`;
const PROJECT_PATH = `${ROOT}/.deepcode/config.json`;

/** 假磁盘：键是规范化后的路径，所以顺带断言了"读的到底是哪两个文件"。 */
function fakeDisk(files: Record<string, string>) {
  return async (path: string): Promise<string | undefined> =>
    files[path.replace(/\\/g, '/')];
}

function load(files: Record<string, string>) {
  const warnings: string[] = [];
  return {
    warnings,
    run: () =>
      loadConfig({ home: HOME, root: ROOT, warn: (l) => warnings.push(l), readText: fakeDisk(files) }),
  };
}

describe('配置文件：两层就近覆盖', () => {
  it('两个文件都不存在时返回空配置（这不是错误）', async () => {
    const { warnings, run } = load({});
    expect(await run()).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('用户级打底，项目级覆盖它，未提到的字段保留', async () => {
    const { run } = load({
      [USER_PATH]: JSON.stringify({ model: '用户模型', baseUrl: 'https://user.example' }),
      [PROJECT_PATH]: JSON.stringify({ model: '项目模型' }),
    });

    // baseUrl 来自用户级、model 被项目级盖掉 —— 是合并，不是整体替换。
    expect(await run()).toEqual({ model: '项目模型', baseUrl: 'https://user.example' });
  });

  it('项目级能给出 apiKey，但要警告这个文件容易进仓库', async () => {
    const { warnings, run } = load({ [PROJECT_PATH]: JSON.stringify({ apiKey: 'sk-ant-x' }) });

    expect((await run()).apiKey).toBe('sk-ant-x');
    expect(warnings.join('\n')).toContain('gitignore');
  });

  it('用户级放 apiKey 不警告（它不在任何仓库里）', async () => {
    const { warnings, run } = load({ [USER_PATH]: JSON.stringify({ apiKey: 'sk-ant-x' }) });

    expect((await run()).apiKey).toBe('sk-ant-x');
    expect(warnings).toEqual([]);
  });
});

describe('配置文件：坏输入不许静默失效', () => {
  it('拼错的字段名会被点名，而不是安静地不生效', async () => {
    const { warnings, run } = load({ [USER_PATH]: JSON.stringify({ modle: 'claude-sonnet-5-5' }) });

    // 静默忽略的话，用户会以为配置生效了，实际一直在用默认模型。
    expect((await run()).model).toBeUndefined();
    expect(warnings.join('\n')).toContain('modle');
    expect(warnings.join('\n')).toContain('model');
  });

  it('JSON 语法错误直接抛，并带上路径', async () => {
    const { run } = load({ [USER_PATH]: '{ model: }' });
    await expect(run()).rejects.toThrow(/不是合法 JSON/);
    await expect(run()).rejects.toThrow(/config\.json/);
  });

  it('顶层不是对象时抛', async () => {
    const { run } = load({ [USER_PATH]: '["claude"]' });
    await expect(run()).rejects.toThrow(/顶层必须是一个对象/);
  });

  it('字段类型不对时抛，并说清期望与实际', async () => {
    const { run } = load({ [PROJECT_PATH]: JSON.stringify({ debug: 'yes' }) });
    await expect(run()).rejects.toThrow(/"debug" 应该是 boolean/);
  });
});
