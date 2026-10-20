import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Mode } from './types';
import { CompanionStore } from './store';

// `node:sqlite` 是 Node 22 的实验性内建，Vite 5 的内建模块表里还没有它：
// 静态 import 会被 vitest 当成普通包去解析。运行时用 require 取，类型照常写。
export type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export { AVATARS, CONTEXT_MESSAGES, DEFAULT_DAILY_LIMIT, HISTORY_MESSAGES, MAX_GREETING, MAX_MESSAGE, MAX_NAME, MAX_PERSONALITY } from './types';
export type {
  AvatarKey,
  Character,
  CharacterInput,
  Conversation,
  Invite,
  Mode,
  RegistrationMode,
  StoredMessage,
  UsageSummary,
  User,
  UserRecord,
  UserRole,
} from './types';
export { CompanionStore, utcDay } from './store';

const SCHEMA_VERSION = 2;

const USER_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled            INTEGER NOT NULL DEFAULT 0,
  daily_message_limit INTEGER,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  messages   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS characters (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT,
  name        TEXT NOT NULL,
  personality TEXT NOT NULL DEFAULT '',
  greeting    TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT 'girl-1',
  is_public   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_by_owner ON characters(owner_id);
CREATE INDEX IF NOT EXISTS characters_public ON characters(is_public);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_by_user
  ON conversations(user_id, character_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation
  ON messages(conversation_id, id);

${USER_TABLES}
`;

const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled            INTEGER NOT NULL DEFAULT 0,
  daily_message_limit INTEGER,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  messages   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE characters ADD COLUMN owner_id TEXT;
ALTER TABLE characters ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS characters_by_owner ON characters(owner_id);
CREATE INDEX IF NOT EXISTS characters_public ON characters(is_public);

ALTER TABLE conversations ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS conversations_by_user
  ON conversations(user_id, character_id, updated_at DESC);
`;

/** 预置角色。本地版归 local 用户，云端版进角色广场。 */
const PRESETS = [
  {
    id: 'preset-gentle',
    name: '小柔',
    personality: '温柔、耐心、愿意倾听。说话轻一点，先接住对方的情绪，再给建议；不急着讲道理。',
    greeting: '嗨，我在这儿。今天过得怎么样？',
    avatar: 'girl-1',
  },
  {
    id: 'preset-sharp',
    name: '阿岚',
    personality:
      '嘴有点毒，但心里站在对方这边。会用调侃拆穿自我欺骗，说完一定给一个能落地的建议。',
    greeting: '哟，来了。说吧，今天又想逃避什么？',
    avatar: 'girl-2',
  },
  {
    id: 'preset-genki',
    name: '星野',
    personality:
      '元气、话多、好奇心重。喜欢用短句和语气词，会主动追问细节，把普通话题聊得很有趣。',
    greeting: '哇，你来啦！快跟我讲讲今天发生了什么！',
    avatar: 'girl-3',
  },
] as const;

export const LOCAL_USER_ID = 'local';

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return env.DEEPCODE_COMPANION_DB ?? join(home, '.deepcode', 'companion.db');
}

function ensureLocalUser(db: DatabaseSync): void {
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, email, password_hash, display_name, role, disabled, daily_message_limit, created_at)
     VALUES (?, ?, '!', '本地用户', 'admin', 0, NULL, ?)`,
  ).run(LOCAL_USER_ID, 'local@deepcode.invalid', new Date().toISOString());
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = Number(row.user_version ?? 0);
  if (version >= SCHEMA_VERSION) return;

  if (version === 0) {
    db.exec(SCHEMA_V2);
  } else {
    // v1 是单用户结构：现有角色/会话都属于本机的 local 用户。
    db.exec(MIGRATION_V2);
    ensureLocalUser(db);
    db.prepare("UPDATE characters SET owner_id = ? WHERE owner_id IS NULL").run(LOCAL_USER_ID);
    db.prepare("UPDATE conversations SET user_id = ? WHERE user_id IS NULL").run(LOCAL_USER_ID);
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function seed(db: DatabaseSync, mode: Mode): void {
  if (mode === 'local') ensureLocalUser(db);

  const row = db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number };
  if (Number(row.n) > 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO characters
       (id, owner_id, name, personality, greeting, avatar, is_public, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const preset of PRESETS) {
    insert.run(
      preset.id,
      mode === 'local' ? LOCAL_USER_ID : null,
      preset.name,
      preset.personality,
      preset.greeting,
      preset.avatar,
      mode === 'local' ? 0 : 1,
      now,
      now,
    );
  }
}

export type OpenOptions = {
  readonly file?: string;
  readonly mode?: Mode;
};

/** 打开（必要时创建）数据库，建表/迁移、写版本、补预置角色。 */
export function openCompanionDb(
  fileOrOptions: string | OpenOptions = {},
): CompanionStore {
  const options: OpenOptions =
    typeof fileOrOptions === 'string' ? { file: fileOrOptions } : fileOrOptions;
  const file = options.file ?? defaultDbPath();
  const mode = options.mode ?? 'local';

  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 3000');
  migrate(db);
  seed(db, mode);
  return new CompanionStore(db);
}
