import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// node:sqlite 是 Node 22 才有的内建模块；CI 矩阵里还有 20。
// 这里动态 import，让 20 上整组跳过而不是在加载测试文件时就炸掉。
const supported = Number(process.versions.node.split('.')[0] ?? 0) >= 22;

describe.skipIf(!supported)('陪伴端 SQLite', () => {
  it('初始化幂等：重开还是三个预置角色', async () => {
    const { openCompanionDb, LOCAL_USER_ID } = await import('@deepcode/companion/db');
    const base = mkdtempSync(join(tmpdir(), 'deepcode-companion-'));
    const file = join(base, 'companion.db');
    try {
      const first = openCompanionDb(file);
      expect(first.listOwned(LOCAL_USER_ID)).toHaveLength(3);
      first.close();

      const second = openCompanionDb(file);
      expect(second.listOwned(LOCAL_USER_ID).map((character) => character.name)).toEqual([
        '小柔',
        '阿岚',
        '星野',
      ]);
      second.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('删人物会把会话与消息一起带走', async () => {
    const { openCompanionDb, LOCAL_USER_ID } = await import('@deepcode/companion/db');
    const store = openCompanionDb(':memory:');
    try {
      const character = store.createCharacter(LOCAL_USER_ID, {
        name: '测试',
        personality: '安静',
        greeting: '',
        avatar: 'girl-1',
      });
      const conversation = store.getOrCreateConversation(LOCAL_USER_ID, character.id);
      if (conversation === undefined) throw new Error('应当创建会话');

      store.appendMessage(conversation.id, 'user', '在吗');
      store.appendMessage(conversation.id, 'assistant', '在。');
      expect(store.messagesOf(conversation.id).map((message) => message.content)).toEqual([
        '在吗',
        '在。',
      ]);

      expect(store.deleteCharacter(character.id, LOCAL_USER_ID)).toBe(true);
      expect(store.getConversation(conversation.id)).toBeUndefined();
      expect(store.messagesOf(conversation.id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('人物不存在时不造会话', async () => {
    const { openCompanionDb, LOCAL_USER_ID } = await import('@deepcode/companion/db');
    const store = openCompanionDb(':memory:');
    try {
      expect(store.createConversation(LOCAL_USER_ID, 'missing')).toBeUndefined();
      expect(store.getOrCreateConversation(LOCAL_USER_ID, 'missing')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('额度与用户消息在同一个事务里：超限不再落库', async () => {
    const { openCompanionDb, utcDay } = await import('@deepcode/companion/db');
    const store = openCompanionDb(':memory:');
    try {
      const user = store.createUser({
        email: 'quota@example.com',
        passwordHash: '!',
        displayName: '额度',
      });
      const character = store.createCharacter(user.id, {
        name: '测试',
        personality: '',
        greeting: '',
        avatar: 'girl-1',
      });
      const conversation = store.getOrCreateConversation(user.id, character.id);
      if (conversation === undefined) throw new Error('应当创建会话');

      const day = utcDay();
      expect(store.reserveChat(conversation.id, user.id, '第一条', day, 1)).toEqual({
        ok: true,
        remaining: 0,
      });
      expect(store.reserveChat(conversation.id, user.id, '第二条', day, 1)).toEqual({
        ok: false,
        used: 1,
        limit: 1,
      });
      expect(store.messagesOf(conversation.id).map((message) => message.content)).toEqual(['第一条']);
    } finally {
      store.close();
    }
  });

  it('v1 数据库迁移后，旧角色与会话归到 local 用户', async () => {
    const { openCompanionDb, LOCAL_USER_ID } = await import('@deepcode/companion/db');
    const base = mkdtempSync(join(tmpdir(), 'deepcode-companion-v1-'));
    const file = join(base, 'companion.db');
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
        DatabaseSync: new (path: string) => {
          exec(sql: string): void;
          close(): void;
        };
      };
      const legacy = new DatabaseSync(file);
      legacy.exec(`
        CREATE TABLE characters (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, personality TEXT NOT NULL DEFAULT '',
          greeting TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT 'girl-1',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO characters (id, name, personality, greeting, avatar, created_at, updated_at)
          VALUES ('old-char', '旧角色', '旧性格', '', 'girl-1', '2026-01-01', '2026-01-01');
        INSERT INTO conversations (id, character_id, created_at, updated_at)
          VALUES ('old-conv', 'old-char', '2026-01-01', '2026-01-01');
        INSERT INTO messages (conversation_id, role, content, created_at)
          VALUES ('old-conv', 'user', '旧消息', '2026-01-01');
        PRAGMA user_version = 1;
      `);
      legacy.close();

      const store = openCompanionDb({ file, mode: 'local' });
      try {
        expect(store.listOwned(LOCAL_USER_ID).map((character) => character.name)).toEqual(['旧角色']);
        expect(store.getConversation('old-conv')?.userId).toBe(LOCAL_USER_ID);
        expect(store.messagesOf('old-conv').map((message) => message.content)).toEqual(['旧消息']);
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
