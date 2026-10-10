import { describe, expect, it } from 'vitest';
import { loadConfig, resolveSettings } from '../src/cli/config';

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

describe('resolveSettings：环境变量盖过配置文件', () => {
  it('空环境 + 空配置 = 只剩默认模型，key 缺失由调用方去报', () => {
    expect(resolveSettings({}, {})).toEqual({
      apiKey: undefined,
      model: 'claude-sonnet-5-5',
      baseUrl: undefined,
      debug: false,
    });
  });

  it('配置文件能用，且被环境变量逐字段盖掉', () => {
    const config = {
      apiKey: 'sk-文件',
      model: '文件模型',
      baseUrl: 'https://file.example',
      debug: true,
    };
    // 只给一个环境变量：它盖掉同名字段，其余仍来自配置文件（合并，不是整体替换）。
    expect(resolveSettings({ DEEPCODE_MODEL: '环境模型' }, config)).toEqual({
      apiKey: 'sk-文件',
      model: '环境模型',
      baseUrl: 'https://file.example',
      debug: true,
    });
  });

  it('认 Anthropic 兼容端点那组名字（DeepSeek 等就是配这三个）', () => {
    // 这组名是 Claude Code 留给兼容端点的，用户机器上往往已经 export 了；
    // 只认 DEEPCODE_MODEL 的话，换后端就得再 export 一遍。
    expect(
      resolveSettings(
        {
          ANTHROPIC_AUTH_TOKEN: 'sk-兼容端点',
          ANTHROPIC_MODEL: 'deepseek-v4-flash',
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        },
        {},
      ),
    ).toEqual({
      apiKey: 'sk-兼容端点',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/anthropic',
      debug: false,
    });
  });

  it('两套名字都给了时，官方那套赢', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-官方',
      ANTHROPIC_AUTH_TOKEN: 'sk-兼容',
      DEEPCODE_MODEL: '官方模型',
      ANTHROPIC_MODEL: '兼容模型',
    };
    expect(resolveSettings(env, {})).toMatchObject({ apiKey: 'sk-官方', model: '官方模型' });
  });

  it('debug 是"或"：环境变量关不掉配置文件里的 true', () => {
    // 文档里说的是"环境变量 > 配置文件"，但 debug 只有"给没给"没有"给成 false"，
    // 空字符串同样是 falsy —— 所以这里只能是或。写清楚，免得被当成 bug 改掉。
    expect(resolveSettings({ DEEPCODE_DEBUG: '' }, { debug: true }).debug).toBe(true);
  });
});
