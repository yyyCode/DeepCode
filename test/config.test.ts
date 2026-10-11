import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeConfig,
  loadConfig,
  maskSecret,
  resolveSettings,
  setConfigValue,
} from '../src/cli/config';

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
      provider: 'anthropic',
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
      provider: 'anthropic',
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
      provider: 'anthropic',
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

describe('provider：取值校验（配置文件与合流出口）', () => {
  it('配置文件里的 provider: "openai" 被采纳', async () => {
    const { run } = load({ [USER_PATH]: JSON.stringify({ provider: 'openai' }) });

    // 解析那一刻就该认，不要拖到合流出口才认。
    expect((await run()).provider).toBe('openai');
    expect(resolveSettings({}, { provider: 'openai' }).provider).toBe('openai');
  });

  it('配置文件里的 provider 拼错时抛，错误里带上两个合法值', async () => {
    const { run } = load({ [USER_PATH]: JSON.stringify({ provider: 'oepnai' }) });

    // 写错的那一刻就报，带上文件路径，别等到合流出口才发现。
    await expect(run()).rejects.toThrow(/oepnai/);
    await expect(run()).rejects.toThrow(/anthropic/);
    await expect(run()).rejects.toThrow(/openai/);
  });

  it('DEEPCODE_PROVIDER 覆盖配置文件里的 provider，并走既有的覆盖告警那条路', () => {
    const warnings: string[] = [];
    const settings = resolveSettings(
      { DEEPCODE_PROVIDER: 'openai' },
      { provider: 'anthropic' },
      (line) => warnings.push(line),
    );

    expect(settings.provider).toBe('openai');
    expect(warnings.join('\n')).toContain('DEEPCODE_PROVIDER');
    expect(warnings.join('\n')).toContain('provider');
    expect(warnings.join('\n')).toContain('被忽略');
  });

  it('DEEPCODE_PROVIDER 取值非法时抛，错误里带上两个合法值', () => {
    // 静默退回 anthropic 最坏：用户拿着 openai 的端点发 anthropic 的请求，
    // 然后收到一个完全看不懂的 404。
    expect(() => resolveSettings({ DEEPCODE_PROVIDER: 'foo' }, {})).toThrow(/anthropic/);
    expect(() => resolveSettings({ DEEPCODE_PROVIDER: 'foo' }, {})).toThrow(/openai/);
  });

  it('哪里都没给 provider 时默认是 anthropic', () => {
    expect(resolveSettings({}, {}).provider).toBe('anthropic');
  });
});

describe('model id：启动期只查形状', () => {
  it('model 里有空白字符时抛，错误里点出空白字符', () => {
    // 存在性查不了（那只有端点知道），但"看着就不像 model id"的能拦下。
    expect(() => resolveSettings({}, { model: 'claude sonnet' })).toThrow(/空白字符/);
  });

  it('model 是空串时抛，提示去查配置文件或环境变量', () => {
    expect(() => resolveSettings({}, { model: '' })).toThrow(/模型 id 是空的/);
  });
});

describe('resolveSettings：顶掉配置文件时必须出声', () => {
  function withWarn(env: Record<string, string | undefined>, config: Parameters<typeof resolveSettings>[1]) {
    const warnings: string[] = [];
    const settings = resolveSettings(env, config, (line) => warnings.push(line));
    return { settings, warnings: warnings.join('\n') };
  }

  it('环境变量与配置文件不同值时告警，并点名是哪个变量顶掉了哪个字段', () => {
    const { settings, warnings } = withWarn(
      { ANTHROPIC_BASE_URL: 'https://relay.example' },
      { baseUrl: 'https://api.deepseek.com/anthropic' },
    );

    // 这正是排查了半天才找出来的那类故障：请求被发去了别处，用户只看到 401，
    // 完全不知道配置文件压根没生效。
    expect(settings.baseUrl).toBe('https://relay.example');
    expect(warnings).toContain('ANTHROPIC_BASE_URL');
    expect(warnings).toContain('baseUrl');
    expect(warnings).toContain('https://relay.example');
    expect(warnings).toContain('被忽略');
  });

  it('两边值相同时不吭声（不然每次启动都吼，用户就学会无视它了）', () => {
    const { warnings } = withWarn(
      { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', DEEPCODE_MODEL: '同一个' },
      { baseUrl: 'https://api.deepseek.com/anthropic', model: '同一个' },
    );
    expect(warnings).toBe('');
  });

  it('apiKey 被顶掉时告警里不许出现任何一把 key', () => {
    const envKey = 'sk-环境的这一把';
    const configKey = 'sk-配置文件那把';
    const { warnings } = withWarn({ ANTHROPIC_API_KEY: envKey }, { apiKey: configKey });

    expect(warnings).toContain('apiKey');
    expect(warnings).not.toContain(envKey);
    expect(warnings).not.toContain(configKey);
  });

  it('环境变量指了但配置文件里没有这一项时，不算"顶掉"，不告警', () => {
    const { settings, warnings } = withWarn({ DEEPCODE_MODEL: '只有环境有' }, {});
    expect(settings.model).toBe('只有环境有');
    expect(warnings).toBe('');
  });

  it('空字符串当作没给：setx VAR "" 不该顶掉配置文件', () => {
    // setx "VAR" "" 留下的是空值而不是删除。若照收，它会静默顶掉配置文件里的值，
    // 而且比现在这版还难查 —— 配置看着好好的，请求却发去了空端点。
    const { settings, warnings } = withWarn(
      { ANTHROPIC_BASE_URL: '', DEEPCODE_MODEL: '' },
      { baseUrl: 'https://api.deepseek.com/anthropic', model: '配置文件里的模型' },
    );
    expect(settings.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(settings.model).toBe('配置文件里的模型');
    expect(warnings).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `config.describe` / `config.set` 的底座（P4c-2）。上面那几组管"启动时读什么"，
// 下面这几组管"摊开给人看"与"由命令去改"—— 后者是唯一一个**写**配置文件的入口，
// 所以它的拒绝面比它的成功面更值得钉。
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'sk-ant-api03-abcdefghijklmn';

/**
 * 真正会出现在返回值里的那个路径。上面 `HOME`/`ROOT` 写的是 POSIX 形状、只用来当假磁盘的键
 * （`fakeDisk` 会把反斜杠规范掉），而 `setConfigValue` 返回的是 `join` 的真结果 ——
 * 在 Windows 上是反斜杠。这两件事别混。
 */
const USER_FILE = join(HOME, '.deepcode', 'config.json');

describe('describeConfig：生效清单带来源', () => {
  const show = (files: Record<string, string>, env: Record<string, string | undefined> = {}) =>
    describeConfig({ env, home: HOME, root: ROOT, readText: fakeDisk(files) });

  const entryOf = async (
    files: Record<string, string>,
    key: string,
    env: Record<string, string | undefined> = {},
  ) => {
    const found = (await show(files, env)).find((e) => e.key === key);
    if (found === undefined) throw new Error(`清单里没有 ${key}`);
    return found;
  };

  it('只有用户级文件时来源是 user；环境变量给了就报 env，而且只报一条', async () => {
    const files = { [USER_PATH]: JSON.stringify({ model: '用户模型' }) };

    // 一个键只有一条记录 —— 不是"环境一条、文件一条"各报一遍。
    expect((await show(files)).filter((e) => e.key === 'model')).toEqual([
      { key: 'model', value: '用户模型', source: 'user', writable: true },
    ]);

    expect(await entryOf(files, 'model', { DEEPCODE_MODEL: '环境模型' })).toEqual({
      key: 'model',
      value: '环境模型',
      source: 'env',
      writable: true,
    });
  });

  it('项目级盖用户级 —— 覆盖面与 loadConfig 同一个方向', async () => {
    const files = {
      [USER_PATH]: JSON.stringify({ baseUrl: 'https://用户级.example' }),
      [PROJECT_PATH]: JSON.stringify({ baseUrl: 'https://项目级.example' }),
    };
    expect(await entryOf(files, 'baseUrl')).toMatchObject({
      value: 'https://项目级.example',
      source: 'project',
    });
  });

  it('apiKey 打了码，且与「没配」看得出区别', async () => {
    const set = await entryOf({ [USER_PATH]: JSON.stringify({ apiKey: KEY }) }, 'apiKey');
    expect(set.value.startsWith('sk-ant')).toBe(true);
    expect(set.value).toContain(`共 ${KEY.length} 位`);
    expect(set.value).not.toContain('abcdefghijklmn');
    expect(set.source).toBe('user');

    const unset = await entryOf({}, 'apiKey');
    expect(unset).toEqual({ key: 'apiKey', value: '（没配）', source: 'default', writable: false });
    expect(set.value).not.toBe(unset.value);
  });

  it('短值不给头部 —— slice(0, 6) 对一把 4 位的 key 等于原样打出来', async () => {
    expect(maskSecret('abcd')).toBe('（共 4 位）');
    expect(maskSecret(undefined)).toBe('（没配）');
    expect(maskSecret('')).toBe('（没配）');
    // 长度刚好 6 也不给：那一位不差地就是整把 key。
    expect(maskSecret('abcdef')).toBe('（共 6 位）');
  });

  it('生效值与 resolveSettings 一致（两条路不许各走各的）', async () => {
    const files = {
      [USER_PATH]: JSON.stringify({ model: '用户模型', baseUrl: 'https://user.example' }),
      [PROJECT_PATH]: JSON.stringify({ provider: 'openai' }),
    };
    const env = { DEEPCODE_MODEL: '环境模型' };

    const merged = await loadConfig({ home: HOME, root: ROOT, readText: fakeDisk(files) });
    const resolved = resolveSettings(env, merged, () => {});
    const shown = new Map((await show(files, env)).map((e) => [e.key, e.value]));

    // 五个字段逐个对：模型、端点、provider、debug 都比字符串，apiKey 走打码那一支。
    expect(shown.get('model')).toBe(resolved.model);
    expect(shown.get('baseUrl')).toBe(resolved.baseUrl);
    expect(shown.get('provider')).toBe(resolved.provider);
    expect(shown.get('debug')).toBe(String(resolved.debug));
    expect(shown.get('apiKey')).toBe(maskSecret(resolved.apiKey));
    expect(resolved.model).toBe('环境模型'); // 上面那条真在测"环境盖文件"，不是在比两个默认值

    // debug 是唯一不进 ENV_NAMES 的字段，两处各写一遍 Boolean(...) 就会在这里走岔。
    const loudEnv = { DEEPCODE_DEBUG: '1' };
    const quietEnv = { DEEPCODE_DEBUG: '' }; // 空串当没给（与上面那条同一条规则）
    for (const env2 of [loudEnv, quietEnv]) {
      expect((await entryOf(files, 'debug', env2)).value).toBe(
        String(resolveSettings(env2, merged, () => {}).debug),
      );
    }
    expect((await entryOf(files, 'debug', loudEnv)).source).toBe('env');
  });

  it('坏文件照样抛，不在这里假装没看见', async () => {
    // 吞掉解析失败，`deepcode config list` 就会打出一份看着正常、实际不是生效值的清单。
    await expect(show({ [USER_PATH]: '{ 不是 JSON' })).rejects.toThrow(/不是合法 JSON/);
  });
});

describe('setConfigValue：只写用户级，而且只写 model', () => {
  /** 记下"到底写没写盘"。拒绝必须**在写之前**发生，不然那不叫拒绝。 */
  function recorder() {
    const written: string[] = [];
    return {
      written,
      write: async (_path: string, json: string) => {
        written.push(json);
      },
      refuseToWrite: async () => {
        throw new Error('不该写盘');
      },
    };
  }

  it('改 model：其它键原样留着（读-改-写）', async () => {
    const disk = recorder();
    const result = await setConfigValue({
      home: HOME,
      key: 'model',
      value: 'claude-opus-5-5',
      readText: fakeDisk({
        [USER_PATH]: JSON.stringify({ apiKey: KEY, model: '旧的', 不认识的键: 1 }),
      }),
      writeJson: disk.write,
    });

    expect(result).toEqual({ ok: true, path: USER_FILE });
    expect(disk.written).toHaveLength(1);
    const back = JSON.parse(disk.written[0] ?? 'null') as Record<string, unknown>;
    expect(back.model).toBe('claude-opus-5-5');
    // 只写了 model、把 apiKey 抹掉的实现会在这两行红。
    expect(back.apiKey).toBe(KEY);
    expect(back.不认识的键).toBe(1);
  });

  it('文件不存在时建一个，且只往用户级写', async () => {
    const written: string[] = [];
    const asked: string[] = [];
    const result = await setConfigValue({
      home: HOME,
      key: 'model',
      value: 'claude-opus-5-5',
      readText: async (path) => {
        asked.push(path);
        return undefined;
      },
      writeJson: async (path, json) => {
        asked.push(path);
        written.push(json);
      },
    });

    expect(result).toEqual({ ok: true, path: USER_FILE });
    // 问的与写的都是用户级那个路径 —— 项目级那个文件是仓库的，
    // 写它正是"key 跟着仓库走"那条路。
    expect(asked).toEqual([USER_FILE, USER_FILE]);
    expect(JSON.parse(written[0] ?? 'null')).toEqual({ model: 'claude-opus-5-5' });
  });

  it('设置类的键一律拒，拒的理由是"这是设置"', async () => {
    const disk = recorder();
    for (const key of ['permissions', 'permissions.allow', 'sandbox.allow', 'plugins.enable']) {
      const result = await setConfigValue({
        home: HOME,
        key,
        value: 'x',
        readText: fakeDisk({}),
        writeJson: disk.refuseToWrite,
      });
      expect(result.ok, key).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error, key).toContain(key);
      // 答的必须是"它属于设置"，不是"不在可写清单里" —— 两句话答的不是同一个问题。
      expect(result.error, key).toContain('设置');
    }
    expect(disk.written).toEqual([]);
  });

  it('凭据与端点拒得掉，点得出那个键', async () => {
    const disk = recorder();
    for (const key of ['apiKey', 'baseUrl', 'debug']) {
      const result = await setConfigValue({
        home: HOME,
        key,
        value: 'sk-ant-x',
        readText: fakeDisk({}),
        writeJson: disk.refuseToWrite,
      });
      expect(result.ok, key).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error, key).toContain(key);
      expect(result.error, key).toContain('可写清单');
    }
    expect(disk.written).toEqual([]);
  });

  it('model 是空的 / 全是空白 / 带空格都拒', async () => {
    const disk = recorder();
    for (const value of ['', '   ', 'claude sonnet']) {
      const result = await setConfigValue({
        home: HOME,
        key: 'model',
        value,
        readText: fakeDisk({}),
        writeJson: disk.refuseToWrite,
      });
      expect(result.ok, JSON.stringify(value)).toBe(false);
    }
    expect(disk.written).toEqual([]);
  });

  it('现有文件是坏的 JSON / 顶层不是对象 → 先让用户去修它，不要覆盖', async () => {
    const disk = recorder();
    // 覆盖掉等于把用户正在手改的那个文件吃掉 —— 静默毁掉别的键是最坏的一种。
    for (const text of ['{ 半个 JSON', '[1, 2]', '"字符串"']) {
      const result = await setConfigValue({
        home: HOME,
        key: 'model',
        value: 'claude-opus-5-5',
        readText: fakeDisk({ [USER_PATH]: text }),
        writeJson: disk.refuseToWrite,
      });
      expect(result.ok, text).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error, text).toContain('先修它');
    }
    expect(disk.written).toEqual([]);
  });

  it('默认写入器：真落盘、目录不存在就建、不留下临时文件', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepcode-config-'));
    try {
      const result = await setConfigValue({ home, key: 'model', value: 'claude-opus-5-5' });
      expect(result.ok).toBe(true);

      const dir = join(home, '.deepcode');
      expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({
        model: 'claude-opus-5-5',
      });
      // rename 之后临时文件不该留下 —— 留着说明写的是"复制"而不是"换名"，
      // 而下次解析一个半截的 .tmp 也会被当成坏文件。
      expect(await readdir(dir)).toEqual(['config.json']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
