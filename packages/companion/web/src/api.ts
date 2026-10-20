export const AVATARS = ['girl-1', 'girl-2', 'girl-3'] as const;
export type AvatarKey = (typeof AVATARS)[number];

export type Mode = 'local' | 'cloud';
export type RegistrationMode = 'open' | 'invite' | 'closed';
export type UserRole = 'user' | 'admin';

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

export type CharacterDraft = {
  readonly name: string;
  readonly personality: string;
  readonly greeting: string;
  readonly avatar: AvatarKey;
};

export type User = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  /** null = 不限量（本地版）。 */
  readonly dailyLimit: number | null;
  readonly usedToday: number;
  readonly createdAt: string;
};

export type Meta = {
  readonly mode: Mode;
  readonly registration: RegistrationMode;
  readonly user: User | null;
  /** 服务端能力开关。只发布尔值；ASR 的 key 永远不到浏览器。 */
  readonly features: { readonly asr: boolean; readonly asrWav: boolean };
};

export type UsageSummary = {
  readonly messages: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
};

export type AdminUser = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly disabled: boolean;
  readonly dailyMessageLimit: number | null;
  readonly createdAt: string;
  readonly usage: UsageSummary;
};

export type Invite = {
  readonly code: string;
  readonly note: string;
  readonly createdBy: string | null;
  readonly usedBy: string | null;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly usedAt: string | null;
};

export type PlatformSettings = {
  readonly registration: RegistrationMode;
  readonly dailyLimit: number;
};

export type ServerMessage = {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
};

export type ChatEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: { inputTokens: number; outputTokens: number } }
  | {
      readonly type: 'done';
      readonly stopReason?: string;
      readonly remaining?: number;
    }
  | { readonly type: 'error'; readonly message: string };

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function failure(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(data?.error ?? `请求失败（${response.status}）`, response.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

export type RegisterInput = {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly inviteCode: string;
};

export const api = {
  async meta(): Promise<Meta> {
    return request<Meta>('/api/meta');
  },

  async register(input: RegisterInput): Promise<User> {
    const data = await request<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return data.user;
  },

  async login(email: string, password: string): Promise<User> {
    const data = await request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return data.user;
  },

  async logout(): Promise<void> {
    await request('/api/auth/logout', { method: 'POST' });
  },

  async listCharacters(): Promise<readonly Character[]> {
    const data = await request<{ characters: readonly Character[] }>('/api/characters');
    return data.characters;
  },

  async listPublicCharacters(): Promise<readonly Character[]> {
    const data = await request<{ characters: readonly Character[] }>('/api/characters/public');
    return data.characters;
  },

  async createCharacter(draft: CharacterDraft): Promise<Character> {
    const data = await request<{ character: Character }>('/api/characters', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    return data.character;
  },

  async updateCharacter(id: string, draft: CharacterDraft): Promise<Character> {
    const data = await request<{ character: Character }>(
      `/api/characters/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(draft) },
    );
    return data.character;
  },

  async deleteCharacter(id: string): Promise<void> {
    await request(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async cloneCharacter(id: string): Promise<Character> {
    const data = await request<{ character: Character }>(
      `/api/characters/${encodeURIComponent(id)}/clone`,
      { method: 'POST' },
    );
    return data.character;
  },

  async publishCharacter(id: string, isPublic: boolean): Promise<Character> {
    const data = await request<{ character: Character }>(
      `/api/admin/characters/${encodeURIComponent(id)}/publish`,
      { method: 'POST', body: JSON.stringify({ public: isPublic }) },
    );
    return data.character;
  },

  async conversation(
    characterId: string,
  ): Promise<{ conversationId: string; messages: readonly ServerMessage[] }> {
    return request(`/api/characters/${encodeURIComponent(characterId)}/conversation`);
  },

  async newConversation(characterId: string): Promise<string> {
    const data = await request<{ conversationId: string }>(
      `/api/characters/${encodeURIComponent(characterId)}/conversations`,
      { method: 'POST' },
    );
    return data.conversationId;
  },

  async transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
    const response = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
      signal,
    });
    if (!response.ok) throw await failure(response);
    const data = (await response.json()) as { text?: unknown };
    return typeof data.text === 'string' ? data.text : '';
  },

  async adminUsers(query: string): Promise<readonly AdminUser[]> {
    const trimmed = query.trim();
    const suffix = trimmed === '' ? '' : `?q=${encodeURIComponent(trimmed)}`;
    const data = await request<{ users: readonly AdminUser[] }>(`/api/admin/users${suffix}`);
    return data.users;
  },

  async adminPatchUser(
    id: string,
    patch: { disabled?: boolean; dailyMessageLimit?: number | null },
  ): Promise<User> {
    const data = await request<{ user: User }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return data.user;
  },

  async adminInvites(): Promise<readonly Invite[]> {
    const data = await request<{ invites: readonly Invite[] }>('/api/admin/invites');
    return data.invites;
  },

  async adminCreateInvite(note: string): Promise<Invite> {
    const data = await request<{ invite: Invite }>('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    return data.invite;
  },

  async adminDisableInvite(code: string): Promise<void> {
    await request(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
  },

  async adminSettings(): Promise<PlatformSettings> {
    return request<PlatformSettings>('/api/admin/settings');
  },

  async adminPatchSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
    return request<PlatformSettings>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
};

/** 读 SSE：服务端按 `data: {...}\n\n` 写，这里只认这一种。 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload !== '') onEvent(JSON.parse(payload) as ChatEvent);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    // 收到 error 事件或解析失败时，先把这条流放掉，别让上游继续生成。
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export async function streamChat(
  input: { characterId: string; conversationId: string; message: string },
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok) throw await failure(response);
  if (response.body === null) throw new Error('服务器没有返回可读的流');

  await readSse(response.body, onEvent);
}
