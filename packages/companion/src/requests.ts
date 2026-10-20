import {
  AVATARS,
  isAvatar,
  MAX_DISPLAY_NAME,
  MAX_EMAIL,
  MAX_GREETING,
  MAX_NAME,
  MAX_PASSWORD,
  MAX_PERSONALITY,
  MIN_PASSWORD,
  type CharacterInput,
  type ParseResult,
  type RegistrationMode,
} from './types';

function text(value: unknown, fallback = ''): string | undefined {
  if (value === undefined) return fallback;
  return typeof value === 'string' ? value : undefined;
}

/** 校验人物编辑表单。名字必填，其余字段缺省时给空值。 */
export function parseCharacterInput(raw: unknown): ParseResult<CharacterInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;

  const rawName = text(body.name);
  if (rawName === undefined) return { ok: false, error: 'name 必须是字符串' };
  const name = rawName.replace(/\s+/g, ' ').trim();
  if (name === '') return { ok: false, error: '名字不能为空' };
  if (name.length > MAX_NAME) return { ok: false, error: `名字最多 ${MAX_NAME} 个字` };

  const personality = text(body.personality);
  if (personality === undefined) return { ok: false, error: 'personality 必须是字符串' };
  if (personality.length > MAX_PERSONALITY) {
    return { ok: false, error: `性格描述最多 ${MAX_PERSONALITY} 个字` };
  }

  const greeting = text(body.greeting);
  if (greeting === undefined) return { ok: false, error: 'greeting 必须是字符串' };
  if (greeting.length > MAX_GREETING) {
    return { ok: false, error: `开场白最多 ${MAX_GREETING} 个字` };
  }

  const rawAvatar = body.avatar ?? AVATARS[0];
  if (typeof rawAvatar !== 'string' || !isAvatar(rawAvatar)) {
    return { ok: false, error: `avatar 只能是 ${AVATARS.join(' / ')}` };
  }

  return {
    ok: true,
    value: { name, personality, greeting: greeting.trim(), avatar: rawAvatar },
  };
}

export type RegisterInput = {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly inviteCode: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmail(value: unknown): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'email 必须是字符串' };
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { ok: false, error: '邮箱格式不对' };
  }
  return { ok: true, value: email };
}

export function parseRegisterInput(raw: unknown): ParseResult<RegisterInput> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;

  const email = parseEmail(body.email);
  if (!email.ok) return email;

  const password = body.password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
  }
  if (password.length > MAX_PASSWORD) {
    return { ok: false, error: `密码最多 ${MAX_PASSWORD} 位` };
  }

  const rawName = body.displayName;
  if (typeof rawName !== 'string') return { ok: false, error: 'displayName 必须是字符串' };
  const displayName = rawName.replace(/\s+/g, ' ').trim();
  if (displayName === '') return { ok: false, error: '昵称不能为空' };
  if (displayName.length > MAX_DISPLAY_NAME) {
    return { ok: false, error: `昵称最多 ${MAX_DISPLAY_NAME} 个字` };
  }

  const rawInvite = text(body.inviteCode);
  if (rawInvite === undefined) return { ok: false, error: 'inviteCode 必须是字符串' };
  const inviteCode = rawInvite.trim();
  if (inviteCode.length > 64) return { ok: false, error: '邀请码太长' };

  return { ok: true, value: { email: email.value, password, displayName, inviteCode } };
}

export function parseLoginInput(
  raw: unknown,
): ParseResult<{ readonly email: string; readonly password: string }> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;
  const email = parseEmail(body.email);
  if (!email.ok) return email;
  if (typeof body.password !== 'string' || body.password === '') {
    return { ok: false, error: '密码不能为空' };
  }
  return { ok: true, value: { email: email.value, password: body.password } };
}

export type AdminUserPatch = {
  readonly disabled?: boolean;
  readonly dailyMessageLimit?: number | null;
};

export function parseAdminUserPatch(raw: unknown): ParseResult<AdminUserPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;
  const patch: { disabled?: boolean; dailyMessageLimit?: number | null } = {};

  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return { ok: false, error: 'disabled 必须是布尔值' };
    patch.disabled = body.disabled;
  }
  if (body.dailyMessageLimit !== undefined) {
    if (body.dailyMessageLimit === null) {
      patch.dailyMessageLimit = null;
    } else {
      const limit = body.dailyMessageLimit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 100_000) {
        return { ok: false, error: 'dailyMessageLimit 必须是 0 到 100000 的整数，或 null' };
      }
      patch.dailyMessageLimit = limit;
    }
  }

  if (patch.disabled === undefined && patch.dailyMessageLimit === undefined) {
    return { ok: false, error: '没有可修改的字段' };
  }
  return { ok: true, value: patch };
}

export type SettingsPatch = {
  readonly registration?: RegistrationMode;
  readonly dailyLimit?: number;
};

const REGISTRATION_MODES: readonly RegistrationMode[] = ['open', 'invite', 'closed'];

export function parseSettingsPatch(raw: unknown): ParseResult<SettingsPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;
  const patch: { registration?: RegistrationMode; dailyLimit?: number } = {};

  if (body.registration !== undefined) {
    if (
      typeof body.registration !== 'string' ||
      !REGISTRATION_MODES.includes(body.registration as RegistrationMode)
    ) {
      return { ok: false, error: `registration 只能是 ${REGISTRATION_MODES.join(' / ')}` };
    }
    patch.registration = body.registration as RegistrationMode;
  }
  if (body.dailyLimit !== undefined) {
    const limit = body.dailyLimit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 100_000) {
      return { ok: false, error: 'dailyLimit 必须是 0 到 100000 的整数' };
    }
    patch.dailyLimit = limit;
  }

  if (patch.registration === undefined && patch.dailyLimit === undefined) {
    return { ok: false, error: '没有可修改的字段' };
  }
  return { ok: true, value: patch };
}

export function parseInviteInput(raw: unknown): ParseResult<{ readonly note: string }> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const note = text((raw as Record<string, unknown>).note);
  if (note === undefined) return { ok: false, error: 'note 必须是字符串' };
  if (note.length > 200) return { ok: false, error: '备注最多 200 个字' };
  return { ok: true, value: { note: note.trim() } };
}
