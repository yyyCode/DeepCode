export const MAX_NAME = 24;
export const MAX_PERSONALITY = 4_000;
export const MAX_GREETING = 500;
export const MAX_MESSAGE = 8_000;
/** 语音请求的硬上限。60 秒 opus 通常不到 1 MB；留到 8 MB 是为了容忍 wav。 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const CONTEXT_MESSAGES = 40;
export const HISTORY_MESSAGES = 200;

export const MAX_EMAIL = 254;
export const MAX_DISPLAY_NAME = 24;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;
export const SESSION_DAYS = 30;
export const DEFAULT_DAILY_LIMIT = 200;

export const AVATARS = ['girl-1', 'girl-2', 'girl-3'] as const;
export type AvatarKey = (typeof AVATARS)[number];

export type Mode = 'local' | 'cloud';
export type RegistrationMode = 'open' | 'invite' | 'closed';
export type UserRole = 'user' | 'admin';

export type User = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly disabled: boolean;
  readonly dailyMessageLimit: number | null;
  readonly createdAt: string;
};

/** 只在认证内部用：多带一份密码哈希，不往 API 上送。 */
export type UserRecord = User & { readonly passwordHash: string };

export type Invite = {
  readonly code: string;
  readonly note: string;
  readonly createdBy: string | null;
  readonly usedBy: string | null;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly usedAt: string | null;
};

export type UsageSummary = {
  readonly messages: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
};

export type Character = {
  readonly id: string;
  readonly ownerId: string | null;
  readonly name: string;
  readonly personality: string;
  readonly greeting: string;
  readonly avatar: AvatarKey;
  readonly isPublic: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CharacterInput = {
  readonly name: string;
  readonly personality: string;
  readonly greeting: string;
  readonly avatar: AvatarKey;
};

export type StoredMessage = {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
};

export type Conversation = {
  readonly id: string;
  readonly userId: string;
  readonly characterId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function isAvatar(value: string): value is AvatarKey {
  return (AVATARS as readonly string[]).includes(value);
}
