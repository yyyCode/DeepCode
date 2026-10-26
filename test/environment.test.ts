import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isGitRepo, platformLabel, shellName, todayLabel } from '../src/cli/environment';

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deepcode-env-'));
  made.push(dir);
  return dir;
}

describe('环境注入（P13）', () => {
  it('从子目录向上找到仓库根的 .git', async () => {
    const root = await temp();
    await mkdir(join(root, '.git'));
    const nested = join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    expect(await isGitRepo(nested)).toBe(true);
    expect(await isGitRepo(root)).toBe(true);
  });

  it('没有 .git 就是 false —— 不猜、不抛', async () => {
    const root = await temp();
    expect(await isGitRepo(root)).toBe(false);
  });

  it('Shell 取 SHELL，其次 ComSpec，最后按平台给默认值', () => {
    expect(shellName({ SHELL: '/usr/bin/zsh' }, 'linux')).toBe('zsh');
    expect(shellName({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toBe('cmd.exe');
    expect(shellName({}, 'win32')).toBe('cmd.exe');
    expect(shellName({}, 'linux')).toBe('sh');
  });

  it('平台名说人话；未知平台原样透出', () => {
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('aix')).toBe('aix');
  });

  it('日期用本地日期，不用 UTC —— 晚上十一点不该被写成第二天', () => {
    const local = new Date(2026, 9, 26, 23, 30, 0);
    expect(todayLabel(local)).toBe('2026-10-26');
  });
});
