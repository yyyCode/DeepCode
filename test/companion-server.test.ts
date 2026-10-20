import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, StreamEvent } from '@deepcode/contract/model-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supported = Number(process.versions.node.split('.')[0] ?? 0) >= 22;

type Reply = {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown> | null;
};

describe.skipIf(!supported)('陪伴端 HTTP', () => {
  let store: import('@deepcode/companion/store').CompanionStore;
  let server: Server;
  let base = '';
  let dir = '';
  let cookieA = '';
  let cookieB = '';
  let userA = '';
  let userB = '';
  let characterA = '';

  const fakeProvider: ModelProvider = {
    name: 'fake',
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: 'text', text: '在。' };
      yield {
        type: 'done',
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    },
  };

  async function call(
    path: string,
    init: RequestInit = {},
    cookie?: string,
  ): Promise<Reply> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (cookie !== undefined) headers.set('Cookie', cookie);
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = null;
    }
    return { status: response.status, text, body };
  }

  function cookieOf(response: Response): string {
    const raw = response.headers.get('set-cookie');
    if (raw === null) throw new Error('注册应当种下 cookie');
    return raw.split(';')[0] ?? '';
  }

  beforeAll(async () => {
    const { openCompanionDb } = await import('@deepcode/companion/db');
    const { createCompanionServer } = await import('@deepcode/companion/server');
    dir = mkdtempSync(join(tmpdir(), 'deepcode-companion-http-'));
    store = openCompanionDb({ file: join(dir, 'cloud.db'), mode: 'cloud' });

    server = createCompanionServer({
      store,
      mode: 'cloud',
      providerFactory: () => fakeProvider,
      resolveSettings: async () => ({
        provider: 'anthropic',
        apiKey: 'test',
        model: 'test',
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('账号隔离：别人的角色、会话和管理接口都碰不到', async () => {
    expect((await call('/api/meta')).body?.user).toBeNull();
    expect((await call('/api/characters')).status).toBe(401);

    const registerA = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'a@example.com',
        password: 'password-a',
        displayName: 'A',
        inviteCode: '',
      }),
    });
    expect(registerA.status).toBe(201);
    cookieA = cookieOf(registerA);
    userA = ((await registerA.json()) as { user: { id: string } }).user.id;

    const registerB = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'b@example.com',
        password: 'password-b',
        displayName: 'B',
        inviteCode: '',
      }),
    });
    expect(registerB.status).toBe(201);
    cookieB = cookieOf(registerB);
    userB = ((await registerB.json()) as { user: { id: string } }).user.id;

    const created = await call(
      '/api/characters',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'A 的角色',
          personality: '只属于 A',
          greeting: '',
          avatar: 'girl-1',
        }),
      },
      cookieA,
    );
    expect(created.status).toBe(201);
    characterA = (created.body?.character as { id: string }).id;

    const bCharacters = await call('/api/characters', {}, cookieB);
    expect(bCharacters.body?.characters).toEqual([]);
    expect(
      (await call(`/api/characters/${characterA}/conversation`, {}, cookieB)).status,
    ).toBe(403);
    expect((await call('/api/admin/users', {}, cookieB)).status).toBe(403);

    const conversation = await call(
      `/api/characters/${characterA}/conversation`,
      {},
      cookieA,
    );
    const conversationId = conversation.body?.conversationId as string;

    const chat = await call(
      '/api/chat',
      {
        method: 'POST',
        body: JSON.stringify({
          characterId: characterA,
          conversationId,
          message: '在吗',
        }),
      },
      cookieA,
    );
    expect(chat.status).toBe(200);
    expect(chat.text).toContain('"type":"delta"');
    expect(chat.text).toContain('"remaining":199');

    store.setUserDailyLimit(userA, 1);
    const overQuota = await call(
      '/api/chat',
      {
        method: 'POST',
        body: JSON.stringify({
          characterId: characterA,
          conversationId,
          message: '再一条',
        }),
      },
      cookieA,
    );
    expect(overQuota.status).toBe(429);
    expect(store.getUsage(userA, new Date().toISOString().slice(0, 10)).messages).toBe(1);
  });

  it('管理员改注册方式、发邀请码；邀请码只能用一次', async () => {
    store.promoteAdmin(userB);

    const settings = await call(
      '/api/admin/settings',
      {
        method: 'PATCH',
        body: JSON.stringify({ registration: 'invite', dailyLimit: 10 }),
      },
      cookieB,
    );
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ registration: 'invite', dailyLimit: 10 });

    const invite = await call(
      '/api/admin/invites',
      { method: 'POST', body: JSON.stringify({ note: '测试' }) },
      cookieB,
    );
    expect(invite.status).toBe(201);
    const code = (invite.body?.invite as { code: string }).code;

    const register = async (email: string, inviteCode: string) =>
      fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: 'password-invite',
          displayName: 'invite',
          inviteCode,
        }),
      });

    const first = await register('invite@example.com', code);
    expect(first.status).toBe(201);
    const firstUser = (await first.json()) as { user: { dailyLimit: number } };
    expect(firstUser.user.dailyLimit).toBe(10);

    expect((await register('again@example.com', code)).status).toBe(400);
    expect(store.findUserByEmail('again@example.com')).toBeUndefined();
  });
});
