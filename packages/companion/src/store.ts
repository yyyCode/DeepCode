import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from './db';
import {
  DEFAULT_DAILY_LIMIT,
  HISTORY_MESSAGES,
  isAvatar,
  type Character,
  type CharacterInput,
  type Conversation,
  type Invite,
  type RegistrationMode,
  type StoredMessage,
  type UsageSummary,
  type User,
  type UserRecord,
  type UserRole,
} from './types';

type CharacterRow = {
  id: string;
  owner_id: string | null;
  name: string;
  personality: string;
  greeting: string;
  avatar: string;
  is_public: number;
  created_at: string;
  updated_at: string;
};

type ConversationRow = {
  id: string;
  user_id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: number;
  role: string;
  content: string;
  created_at: string;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: string;
  disabled: number;
  daily_message_limit: number | null;
  created_at: string;
};

type InviteRow = {
  code: string;
  created_by: string | null;
  used_by: string | null;
  note: string;
  disabled: number;
  created_at: string;
  used_at: string | null;
};

type UsageRow = {
  messages: number;
  tokens_in: number;
  tokens_out: number;
};

const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  'registration.mode': 'open',
  'daily_limit.default': String(DEFAULT_DAILY_LIMIT),
};

const REGISTRATION_MODES: readonly RegistrationMode[] = ['open', 'invite', 'closed'];

function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    personality: row.personality,
    greeting: row.greeting,
    avatar: isAvatar(row.avatar) ? row.avatar : 'girl-1',
    isPublic: row.is_public === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: row.disabled === 1,
    dailyMessageLimit: row.daily_message_limit,
    createdAt: row.created_at,
  };
}

function toUserRecord(row: UserRow): UserRecord {
  return { ...toUser(row), passwordHash: row.password_hash };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: row.created_at,
  };
}

function toInvite(row: InviteRow): Invite {
  return {
    code: row.code,
    note: row.note,
    createdBy: row.created_by,
    usedBy: row.used_by,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    usedAt: row.used_at,
  };
}

export type ReserveResult =
  | { readonly ok: true; readonly remaining: number }
  | { readonly ok: false; readonly used: number; readonly limit: number };

/** 人物、会话、消息、账号、额度、邀请码的存取。 */
export class CompanionStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }

  // ── 设置 ──────────────────────────────────────────────────────────

  getSetting(key: string): string {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? DEFAULT_SETTINGS[key] ?? '';
  }

  setSetting(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getRegistrationMode(): RegistrationMode {
    const value = this.getSetting('registration.mode');
    return REGISTRATION_MODES.includes(value as RegistrationMode)
      ? (value as RegistrationMode)
      : 'open';
  }

  getDailyLimitDefault(): number {
    const parsed = Number.parseInt(this.getSetting('daily_limit.default'), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_LIMIT;
  }

  // ── 账号 ──────────────────────────────────────────────────────────

  findUserByEmail(email: string): UserRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | UserRow
      | undefined;
    return row === undefined ? undefined : toUserRecord(row);
  }

  getUser(id: string): User | undefined {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  createUser(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly displayName: string;
    readonly role?: UserRole;
  }): User {
    const user: User = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      role: input.role ?? 'user',
      disabled: false,
      dailyMessageLimit: null,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO users
           (id, email, password_hash, display_name, role, disabled, daily_message_limit, created_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(user.id, user.email, input.passwordHash, user.displayName, user.role, user.createdAt);
    return user;
  }

  listUsers(search: string, day: string): readonly (User & { readonly usage: UsageSummary })[] {
    const like = `%${search.trim().toLowerCase()}%`;
    const rows = this.#db
      .prepare(
        `SELECT * FROM users
         WHERE ? = '' OR lower(email) LIKE ? OR lower(display_name) LIKE ?
         ORDER BY created_at ASC
         LIMIT 200`,
      )
      .all(search.trim(), like, like) as unknown as UserRow[];
    return rows.map((row) => ({
      ...toUser(row),
      usage: this.getUsage(row.id, day),
    }));
  }

  countUsers(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return Number(row.n);
  }

  setUserDisabled(id: string, disabled: boolean): boolean {
    const result = this.#db
      .prepare('UPDATE users SET disabled = ? WHERE id = ?')
      .run(disabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  setUserDailyLimit(id: string, limit: number | null): boolean {
    const result = this.#db
      .prepare('UPDATE users SET daily_message_limit = ? WHERE id = ?')
      .run(limit, id);
    return Number(result.changes) > 0;
  }

  promoteAdmin(id: string): boolean {
    const result = this.#db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /** 注册中途失败（邀请码被抢）时回滚刚建的账号。 */
  deleteUser(id: string): void {
    this.#db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  // ── 会话 token ────────────────────────────────────────────────────

  createSession(tokenHash: string, userId: string, expiresAt: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, now, now, expiresAt);
  }

  findSession(tokenHash: string): { readonly userId: string; readonly expiresAt: string } | undefined {
    const row = this.#db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: string } | undefined;
    return row === undefined ? undefined : { userId: row.user_id, expiresAt: row.expires_at };
  }

  touchSession(tokenHash: string): void {
    this.#db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(now: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // ── 邀请码 ────────────────────────────────────────────────────────

  createInvite(code: string, note: string, createdBy: string | null): Invite {
    const invite: Invite = {
      code,
      note,
      createdBy,
      usedBy: null,
      disabled: false,
      createdAt: new Date().toISOString(),
      usedAt: null,
    };
    this.#db
      .prepare(
        `INSERT INTO invites (code, created_by, note, disabled, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(code, createdBy, note, invite.createdAt);
    return invite;
  }

  listInvites(limit = 100): readonly Invite[] {
    const rows = this.#db
      .prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as InviteRow[];
    return rows.map(toInvite);
  }

  getInvite(code: string): Invite | undefined {
    const row = this.#db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
      | InviteRow
      | undefined;
    return row === undefined ? undefined : toInvite(row);
  }

  disableInvite(code: string): boolean {
    const result = this.#db.prepare('UPDATE invites SET disabled = 1 WHERE code = ?').run(code);
    return Number(result.changes) > 0;
  }

  /** 一次性核销。并发下只有一次能成功。 */
  redeemInvite(code: string, userId: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE invites SET used_by = ?, used_at = ?
         WHERE code = ? AND used_by IS NULL AND disabled = 0`,
      )
      .run(userId, new Date().toISOString(), code);
    return Number(result.changes) > 0;
  }

  // ── 用量 ──────────────────────────────────────────────────────────

  getUsage(userId: string, day: string): UsageSummary {
    const row = this.#db
      .prepare('SELECT messages, tokens_in, tokens_out FROM usage_daily WHERE user_id = ? AND day = ?')
      .get(userId, day) as UsageRow | undefined;
    return row === undefined
      ? { messages: 0, tokensIn: 0, tokensOut: 0 }
      : { messages: Number(row.messages), tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out) };
  }

  addTokens(userId: string, day: string, tokensIn: number, tokensOut: number): void {
    this.#db
      .prepare(
        `INSERT INTO usage_daily (user_id, day, messages, tokens_in, tokens_out)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(user_id, day) DO UPDATE SET
           tokens_in = tokens_in + excluded.tokens_in,
           tokens_out = tokens_out + excluded.tokens_out`,
      )
      .run(userId, day, tokensIn, tokensOut);
  }

  // ── 人物 ──────────────────────────────────────────────────────────

  listOwned(userId: string): readonly Character[] {
    const rows = this.#db
      .prepare('SELECT * FROM characters WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(userId) as unknown as CharacterRow[];
    return rows.map(toCharacter);
  }

  listPublic(): readonly Character[] {
    const rows = this.#db
      .prepare('SELECT * FROM characters WHERE is_public = 1 ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as CharacterRow[];
    return rows.map(toCharacter);
  }

  getCharacter(id: string): Character | undefined {
    const row = this.#db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as
      | CharacterRow
      | undefined;
    return row === undefined ? undefined : toCharacter(row);
  }

  createCharacter(ownerId: string, input: CharacterInput): Character {
    const now = new Date().toISOString();
    const character: Character = {
      id: randomUUID(),
      ownerId,
      ...input,
      isPublic: false,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO characters
           (id, owner_id, name, personality, greeting, avatar, is_public, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        character.id,
        ownerId,
        character.name,
        character.personality,
        character.greeting,
        character.avatar,
        now,
        now,
      );
    return character;
  }

  updateCharacter(id: string, ownerId: string, input: CharacterInput): Character | undefined {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `UPDATE characters
         SET name = ?, personality = ?, greeting = ?, avatar = ?, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .run(input.name, input.personality, input.greeting, input.avatar, now, id, ownerId);
    if (Number(result.changes) === 0) return undefined;
    return this.getCharacter(id);
  }

  /** 只能删自己的角色；公共角色从广场消失也走这里（所有者是管理员）。 */
  deleteCharacter(id: string, ownerId: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM characters WHERE id = ? AND owner_id = ?')
      .run(id, ownerId);
    return Number(result.changes) > 0;
  }

  cloneCharacter(id: string, ownerId: string): Character | undefined {
    const source = this.getCharacter(id);
    if (source === undefined) return undefined;
    return this.createCharacter(ownerId, {
      name: source.name,
      personality: source.personality,
      greeting: source.greeting,
      avatar: source.avatar,
    });
  }

  publishCharacter(id: string, isPublic: boolean): Character | undefined {
    this.#db
      .prepare('UPDATE characters SET is_public = ?, updated_at = ? WHERE id = ?')
      .run(isPublic ? 1 : 0, new Date().toISOString(), id);
    return this.getCharacter(id);
  }

  // ── 会话与消息 ────────────────────────────────────────────────────

  getOrCreateConversation(userId: string, characterId: string): Conversation | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM conversations
         WHERE user_id = ? AND character_id = ?
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(userId, characterId) as ConversationRow | undefined;
    if (row !== undefined) return toConversation(row);
    return this.createConversation(userId, characterId);
  }

  createConversation(userId: string, characterId: string): Conversation | undefined {
    if (this.getCharacter(characterId) === undefined) return undefined;
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      userId,
      characterId,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO conversations (id, user_id, character_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversation.id, userId, characterId, now, now);
    return conversation;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.#db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    return row === undefined ? undefined : toConversation(row);
  }

  messagesOf(conversationId: string, limit: number = HISTORY_MESSAGES): readonly StoredMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT id, role, content, created_at FROM messages
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  appendMessage(conversationId: string, role: 'user' | 'assistant', content: string): StoredMessage {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(conversationId, role, content, now);
    this.#db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    return { id: Number(result.lastInsertRowid), role, content, createdAt: now };
  }

  /**
   * 额度与用户消息同一个事务：要么这条消息被记下并扣一次额度，
   * 要么额度不动、消息也不落库。同步 SQLite 下用 BEGIN IMMEDIATE 锁住。
   */
  reserveChat(
    conversationId: string,
    userId: string,
    message: string,
    day: string,
    limit: number,
  ): ReserveResult {
    const owns = this.#db
      .prepare('SELECT 1 AS ok FROM conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, userId) as { ok: number } | undefined;
    if (owns === undefined) throw new Error('会话不属于这个用户');

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const used = this.getUsage(userId, day).messages;
      if (used >= limit) {
        this.#db.exec('ROLLBACK');
        return { ok: false, used, limit };
      }

      const now = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO messages (conversation_id, role, content, created_at)
           VALUES (?, 'user', ?, ?)`,
        )
        .run(conversationId, message, now);
      this.#db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(now, conversationId);
      this.#db
        .prepare(
          `INSERT INTO usage_daily (user_id, day, messages)
           VALUES (?, ?, 1)
           ON CONFLICT(user_id, day) DO UPDATE SET messages = messages + 1`,
        )
        .run(userId, day);
      this.#db.exec('COMMIT');
      return { ok: true, remaining: limit - used - 1 };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
