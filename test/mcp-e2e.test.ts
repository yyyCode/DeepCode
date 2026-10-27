import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePolicy } from '../src/cli/settings';
import { startMcp } from '../src/cli/mcp-runtime';
import { createMcpPlugin } from '../src/cli/mcp-plugin';
import { createEngine } from '../src/core/create';
import { listTools } from '../src/core/tool-list';
import { confirmPlugin } from '../src/builtins/confirm';
import { CORE_ORIGIN } from '../src/contract/next';
import type { ModelProvider } from '../src/contract/model-provider';

/**
 * 端到端：一份真的用户级 `settings.json` → 真的 spawn 一个 stdio server →
 * 工具进清单 → `tool.check` 答 ask → `tool.call` 拿到文本 → `/mcp` 报 connected。
 *
 * 这一条不碰 CLI 的 main()（那要一个终端），但把中间每一段都换成真的：
 * 设置解析、连接握手、工具注册、权限链。唯一假的是模型 provider。
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const provider: ModelProvider = {
  name: 'stub',
  async *stream() {
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
};

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MCP 端到端', () => {
  it('用户级配置里的 server 一路变成可调用工具，坏的那台只影响自己', async () => {
    const home = await tempDir('deepcode-mcp-home-');
    const root = await tempDir('deepcode-mcp-root-');
    await mkdir(join(home, '.deepcode'), { recursive: true });
    await writeFile(
      join(home, '.deepcode', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [FIXTURE],
            env: { FAKE_MCP_MODE: 'normal' },
            timeoutMs: 10_000,
          },
          broken: { command: 'definitely-not-a-real-command-xyz' },
        },
      }),
      'utf8',
    );

    const warnings: string[] = [];
    const policy = await resolvePolicy({ home, root, env: process.env, warn: (line) => warnings.push(line) });
    expect(policy.mcpServers.map((server) => server.name)).toEqual(['fake', 'broken']);

    const runtime = await startMcp({
      home,
      root,
      env: process.env,
      userServers: policy.mcpServers,
      warn: (line) => warnings.push(line),
    });

    try {
      expect(runtime.states.find((state) => state.name === 'fake')?.status.kind).toBe('connected');
      expect(runtime.states.find((state) => state.name === 'broken')?.status.kind).toBe('failed');
      // 一台起不来不该让会话起不来 —— 它只留下一条点名警告。
      expect(warnings.some((line) => line.includes('broken') && line.includes('连接失败'))).toBe(true);

      const prints: string[] = [];
      const { $, dispatch } = await createEngine({
        plugins: [createMcpPlugin(runtime), confirmPlugin],
        provider,
        ui: {
          print: (line) => prints.push(line),
          notice: () => {},
          ask: async () => 'y',
        },
        sessionInfo: { id: 'e2e', cwd: root, root },
        env: {},
        signal: () => new AbortController().signal,
      });

      const listing = await listTools({ $, dispatch });
      expect(listing.specs.map((spec) => spec.name)).toContain('mcp__fake__echo');

      const verdict = await dispatch(
        'tool.check',
        { tool: 'mcp__fake__echo', input: {}, toolUseId: 't1' },
        CORE_ORIGIN,
      );
      expect(verdict.decision).toBe('ask');

      const result = await dispatch(
        'tool.call',
        { tool: 'mcp__fake__echo', input: { text: 'hi' }, toolUseId: 't1' },
        CORE_ORIGIN,
      );
      expect(result).toEqual({ value: 'echo:{"text":"hi"}' });

      await dispatch('command.run', { name: 'mcp', args: [] }, CORE_ORIGIN);
      const shown = prints.join('\n');
      expect(shown).toContain('fake');
      expect(shown).toContain('connected  9 tools');
      expect(shown).toContain('mcp__fake__echo');
      expect(shown).toContain('broken');
      expect(shown).toContain('failed');
    } finally {
      await runtime.close();
    }
  }, 20_000);
});
