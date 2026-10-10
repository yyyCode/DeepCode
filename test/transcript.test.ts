import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPersister,
  createTranscript,
  findTranscript,
  listTranscripts,
  newSessionId,
  projectSlug,
  readTranscript,
  sessionsDir,
} from '../src/cli/transcript';
import type { Message } from '../src/contract/model-provider';

let home: string;

beforeAll(async () => {
  // 临时 home：落盘一律发生在它下面，绝不去碰真实用户目录。
  home = await mkdtemp(join(tmpdir(), 'deepcode-transcript-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function userMessage(content: string): Message {
  return { role: 'user', content };
}

function toolMessage(): Message {
  // 第 3 条要钉住的形态：一轮里多个工具结果合并成一条消息（Task 3，commit 6c1da73）。
  return {
    role: 'tool',
    results: [
      { toolUseId: 'tu_1', content: '第一段\n第二段', isError: false },
      { toolUseId: 'tu_2', content: 'boom', isError: true },
    ],
  };
}

async function seed(cwd: string, messages: readonly Message[], now?: Date) {
  const transcript = await createTranscript({ home, cwd, model: 'deepseek-v4-flash', provider: 'anthropic', now });
  const persist = createPersister(transcript, 0);
  await persist(messages);
  return transcript;
}

describe('transcript', () => {
  it('1. projectSlug 把非字母数字字符换成 -', () => {
    expect(projectSlug('F:\\ts\\DeepCode')).toBe('F--ts-DeepCode');
  });

  it('2. newSessionId 用本地时间，两次调用不相等', () => {
    const id = newSessionId(new Date(2026, 9, 11, 3, 48, 55));
    expect(id.startsWith('20261011-034855-')).toBe(true);
    // 本地时间：月份是 9 → 十月（getMonth 从 0 起）。若误用 toISOString，
    // 凌晨 3 点会写成前一天或差 8 小时，前缀就不是 20261011-034855 了。
    expect(id).not.toBe(newSessionId(new Date(2026, 9, 11, 3, 48, 55)));
  });

  it('3. 往返不丢形状（含 role:tool 带 results 的消息）', async () => {
    const cwd = 'F:\\proj-roundtrip';
    const messages: Message[] = [userMessage('跑一下测试'), toolMessage()];
    const transcript = await seed(cwd, messages);

    const back = await readTranscript(transcript.path);
    expect(back.header?.id).toBe(transcript.id);
    expect(back.header?.cwd).toBe(cwd);
    expect(back.header?.model).toBe('deepseek-v4-flash');
    expect(back.header?.provider).toBe('anthropic');
    expect(back.messages).toEqual(messages);
    expect(back.messages[1]).toEqual(toolMessage());
  });

  it('4. 坏行跳过（最后一行被截断）', async () => {
    const cwd = 'F:\\proj-truncated';
    const transcript = await seed(cwd, [userMessage('第一条'), userMessage('第二条')]);

    // 手动塞半行 JSON，模拟写在中间崩掉。
    await appendFile(transcript.path, '{"type":"message","mess');

    const back = await readTranscript(transcript.path);
    expect(back.messages).toHaveLength(2);
    expect(back.messages[0]).toEqual(userMessage('第一条'));
    expect(back.messages[1]).toEqual(userMessage('第二条'));
  });

  it('5. 只有头、没有消息的空壳不出现在 listTranscripts', async () => {
    const cwd = 'F:\\proj-empty-shell';
    const transcript = await createTranscript({ home, cwd, model: 'm', provider: 'p' });
    // 用另一个带消息的会话占位，确保文件确实存在、只是被跳过。
    await seed(cwd, [userMessage('有内容')]);

    const list = await listTranscripts(home, cwd);
    expect(list.map((t) => t.id)).not.toContain(transcript.id);
  });

  it('6. 撞桶但 cwd 不同的会话被跳过（cwd 比对不能省）', async () => {
    // 两个写法 slug 相同：'F:/a' 与 'F:\a' 都 → 'F--a'，落进同一个桶。
    const seeded = await seed('F:\\a', [userMessage('反斜杠目录的会话')]);
    expect(projectSlug('F:/a')).toBe(projectSlug('F:\\a'));

    // 同一个桶，但当前 cwd 是正斜杠写法：不能把上面那条接上来。
    expect(await listTranscripts(home, 'F:/a')).toEqual([]);

    // 用原字符串 cwd 查才拿得到。
    const list = await listTranscripts(home, 'F:\\a');
    expect(list.map((t) => t.id)).toEqual([seeded.id]);
  });

  it('7. 不带 id 的 findTranscript 拿到最近一次会话', async () => {
    const cwd = 'F:\\proj-recent';
    await seed(cwd, [userMessage('旧会话')], new Date(2026, 9, 11, 3, 48, 55));
    const newer = await seed(cwd, [userMessage('新会话')], new Date(2026, 9, 11, 4, 0, 0));

    const found = await findTranscript({ home, cwd });
    expect(found?.transcript.id).toBe(newer.id);
    expect(found?.messages).toEqual([userMessage('新会话')]);
  });

  it('8. findTranscript 按 id 命中；不存在的 id 返回 undefined', async () => {
    const cwd = 'F:\\proj-find-by-id';
    const a = await seed(cwd, [userMessage('A')], new Date(2026, 9, 11, 3, 48, 55));
    await seed(cwd, [userMessage('B')], new Date(2026, 9, 11, 4, 0, 0));

    const found = await findTranscript({ home, cwd, id: a.id });
    expect(found?.transcript.id).toBe(a.id);
    expect(found?.messages).toEqual([userMessage('A')]);

    expect(await findTranscript({ home, cwd, id: '不存在' })).toBeUndefined();
  });

  it('9. 同一数组喂两次不会写两遍', async () => {
    const cwd = 'F:\\proj-idempotent';
    const transcript = await createTranscript({ home, cwd, model: 'm', provider: 'p' });
    const persist = createPersister(transcript, 0);

    const messages: Message[] = [userMessage('一'), userMessage('二')];
    await persist(messages);
    await persist(messages); // 第二次是同一个数组：没有新增，不该重写

    const back = await readTranscript(transcript.path);
    expect(back.messages).toHaveLength(2);
  });

  it('10. createPersister(undefined, 0) 是 no-op，不抛', async () => {
    const persist = createPersister(undefined, 0);
    await expect(persist([userMessage('无处可写')])).resolves.toBeUndefined();
  });

  it('11. 落盘失败只喊一次 onError', async () => {
    const cwd = 'F:\\proj-write-fail';
    const transcript = await createTranscript({ home, cwd, model: 'm', provider: 'p' });

    // 指向一个父目录不存在的深层路径，且不建目录：appendFile 会以 ENOENT 失败
    // （Windows 上实测确实抛，不是想当然）。
    const broken = { ...transcript, path: join(home, 'no-such-parent', 'deeper', 'x.jsonl') };

    const complaints: string[] = [];
    const persist = createPersister(broken, 0, (line) => complaints.push(line));

    await persist([userMessage('第一批')]);
    await persist([userMessage('第一批'), userMessage('第二批')]); // 第二批也只喊一次

    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain(broken.path);
  });

  it('sessionsDir 位置在 home 下（不写进被测试的项目目录）', () => {
    expect(sessionsDir(home, 'F:\\ts\\DeepCode')).toBe(
      join(home, '.deepcode', 'projects', 'F--ts-DeepCode', 'sessions'),
    );
  });
});
