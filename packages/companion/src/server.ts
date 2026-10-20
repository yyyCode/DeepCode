import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, ModelProvider } from '@deepcode/contract/model-provider';
import { createProvider, type ProviderSettings } from '@deepcode/providers';
import {
  clearSessionCookie,
  FixedWindowLimiter,
  hashPassword,
  hashToken,
  newSessionToken,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  sessionExpiry,
  verifyPassword,
} from './auth';
import {
  AsrUnavailableError,
  audioExtension,
  type AsrProvider,
} from './asr';
import { createAsrProvider } from './asr-registry';
import { buildSystemPrompt, parseChatRequest } from './chat';
import {
  resolveAsrSettings as loadAsrSettings,
  resolveProviderSettings,
  type AsrSettings,
} from './config';
import { defaultDbPath, LOCAL_USER_ID, openCompanionDb } from './db';
import {
  parseAdminUserPatch,
  parseCharacterInput,
  parseInviteInput,
  parseLoginInput,
  parseRegisterInput,
  parseSettingsPatch,
} from './requests';
import { CompanionStore, utcDay } from './store';
import {
  CONTEXT_MESSAGES,
  MAX_AUDIO_BYTES,
  MAX_MESSAGE,
  MIN_PASSWORD,
  type Mode,
  type StoredMessage,
  type User,
} from './types';

const DIST = fileURLToPath(new URL('../web/dist', import.meta.url));
const BODY_LIMIT = 256 * 1024;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
/** 一次识别最多等 60 秒；上游卡住时不能让浏览器一直挂着。 */
const ASR_TIMEOUT_MS = 60_000;
/** 云端的粗粒度防滥用闸。本地模式不限次数。 */
const ASR_LIMIT_PER_MINUTE = 20;

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export type ProviderFactory = (settings: ProviderSettings) => ModelProvider;

export type ServerOptions = {
  readonly store?: CompanionStore;
  readonly mode?: Mode;
  readonly providerFactory?: ProviderFactory;
  readonly resolveSettings?: () => Promise<ProviderSettings>;
  /** 测试注入点；生产默认读环境变量与 ~/.deepcode/config.json。 */
  readonly resolveAsrSettings?: () => Promise<AsrSettings | undefined>;
  readonly asrProviderFactory?: (settings: AsrSettings) => AsrProvider;
  readonly secureCookies?: boolean;
  readonly publicOrigin?: string;
};

type PublicUser = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: User['role'];
  /** null = 不限量（本地版）。 */
  readonly dailyLimit: number | null;
  readonly usedToday: number;
  readonly createdAt: string;
};

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
}

function sse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 读完整个请求体再解析。上限之内的才拼成字符串。 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error(`请求体太大（上限 ${Math.round(BODY_LIMIT / 1024)} KB）`));
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

class PayloadTooLargeError extends Error {}

/**
 * 读原始音频。与 readBody 分开：这里不做 JSON 解析，且上限按音频算。
 *
 * Content-Length 先看一眼，能省掉 8 MB 的无效读取；没有这个头（分块传输）
 * 就边读边数。超限后不再收集，但仍把剩余数据排空，让连接正常结束。
 */
function readAudioBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new PayloadTooLargeError('音频太大'));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError('音频太大'));
        return;
      }
      resolveBody(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function toProviderMessages(history: readonly StoredMessage[]): readonly Message[] {
  return history.map((message) =>
    message.role === 'user'
      ? { role: 'user', content: message.content }
      : { role: 'assistant', content: [{ type: 'text', text: message.content }] },
  );
}

function userPayload(user: User, store: CompanionStore, mode: Mode = 'cloud'): PublicUser {
  if (mode === 'local') {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      dailyLimit: null,
      usedToday: 0,
      createdAt: user.createdAt,
    };
  }
  const used = store.getUsage(user.id, utcDay()).messages;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    dailyLimit: user.dailyMessageLimit ?? store.getDailyLimitDefault(),
    usedToday: used,
    createdAt: user.createdAt,
  };
}

function pathId(value: string | undefined): string {
  if (value === undefined) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function canUse(character: { ownerId: string | null; isPublic: boolean }, userId: string): boolean {
  return character.ownerId === userId || character.isPublic;
}

function originAllowed(req: IncomingMessage, publicOrigin: string | undefined): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // 非浏览器客户端；cookie + SameSite 仍然是防线
  try {
    const parsed = new URL(origin);
    if (publicOrigin !== undefined) return parsed.origin === new URL(publicOrigin).origin;
    return parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

export function createCompanionServer(options: ServerOptions = {}) {
  const mode: Mode = options.mode ?? 'local';
  const store = options.store ?? openCompanionDb({ mode });
  const providerFactory: ProviderFactory = options.providerFactory ?? createProvider;
  const resolveSettings = options.resolveSettings ?? resolveProviderSettings;
  const resolveAsr = options.resolveAsrSettings ?? (() => loadAsrSettings());
  const asrProviderFactory = options.asrProviderFactory ?? createAsrProvider;
  const secureCookies = options.secureCookies ?? false;
  const publicOrigin = options.publicOrigin;
  const limiter = new FixedWindowLimiter();
  const asrLimiter = new FixedWindowLimiter();
  const inFlight = new Set<string>();
  const inFlightAsr = new Set<string>();
  /** 配置坏了只警告一次；/api/meta 会被反复调，不能每次刷一行。 */
  let asrWarned = false;

  function clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  function currentUser(req: IncomingMessage): { readonly user: User; readonly tokenHash: string | null } | null {
    if (mode === 'local') {
      const user = store.getUser(LOCAL_USER_ID);
      return user === undefined ? null : { user, tokenHash: null };
    }

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token === undefined) return null;
    const tokenHash = hashToken(token);
    const session = store.findSession(tokenHash);
    if (session === undefined) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      store.deleteSession(tokenHash);
      return null;
    }
    const user = store.getUser(session.userId);
    if (user === undefined || user.disabled) {
      store.deleteSession(tokenHash);
      return null;
    }
    store.touchSession(tokenHash);
    return { user, tokenHash };
  }

  function requireUser(req: IncomingMessage, res: ServerResponse): User | null {
    const session = currentUser(req);
    if (session === null) {
      json(res, 401, { error: '请先登录' });
      return null;
    }
    return session.user;
  }

  function requireAdmin(req: IncomingMessage, res: ServerResponse): User | null {
    const user = requireUser(req, res);
    if (user === null) return null;
    if (user.role !== 'admin') {
      json(res, 403, { error: '需要管理员权限' });
      return null;
    }
    return user;
  }

  function startSession(user: User, res: ServerResponse): void {
    store.deleteExpiredSessions(new Date().toISOString());
    const token = newSessionToken();
    store.createSession(hashToken(token), user.id, sessionExpiry());
    res.setHeader('Set-Cookie', sessionCookie(token, secureCookies));
  }

  // ── 认证 ──────────────────────────────────────────────────────────

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!limiter.hit(`register:${clientIp(req)}`, 5, AUTH_WINDOW_MS)) {
      json(res, 429, { error: '注册请求太频繁，请稍后再试' });
      return;
    }

    let parsed: ReturnType<typeof parseRegisterInput>;
    try {
      parsed = parseRegisterInput(await readBody(req));
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
      return;
    }
    if (!parsed.ok) {
      json(res, 400, { error: parsed.error });
      return;
    }

    const registration = store.getRegistrationMode();
    if (registration === 'closed') {
      json(res, 403, { error: '现在不开放注册' });
      return;
    }

    const { email, password, displayName, inviteCode } = parsed.value;
    if (registration === 'invite' && inviteCode === '') {
      json(res, 400, { error: '需要邀请码才能注册' });
      return;
    }
    if (inviteCode !== '') {
      const invite = store.getInvite(inviteCode);
      if (invite === undefined || invite.disabled || invite.usedBy !== null) {
        json(res, 400, { error: '邀请码无效或已经被使用' });
        return;
      }
    }
    if (store.findUserByEmail(email) !== undefined) {
      json(res, 409, { error: '这个邮箱已经注册过了' });
      return;
    }

    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = store.createUser({ email, passwordHash, displayName });
    } catch (error) {
      // 并发注册同一个邮箱时，查重和插入之间可能被另一个请求插进来。
      if ((error as Error).message.includes('UNIQUE')) {
        json(res, 409, { error: '这个邮箱已经注册过了' });
        return;
      }
      throw error;
    }

    if (inviteCode !== '' && !store.redeemInvite(inviteCode, user.id)) {
      store.deleteUser(user.id);
      json(res, 400, { error: '邀请码刚刚被别人用掉了' });
      return;
    }

    startSession(user, res);
    json(res, 201, { user: userPayload(user, store) });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: ReturnType<typeof parseLoginInput>;
    try {
      parsed = parseLoginInput(await readBody(req));
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
      return;
    }
    if (!parsed.ok) {
      json(res, 400, { error: parsed.error });
      return;
    }

    const email = parsed.value.email;
    // 每个邮箱 10 次、每个 IP 30 次：只按邮箱限流的话，换邮箱就能绕过去。
    if (
      !limiter.hit(`login-ip:${clientIp(req)}`, 30, AUTH_WINDOW_MS) ||
      !limiter.hit(`login:${clientIp(req)}:${email}`, 10, AUTH_WINDOW_MS)
    ) {
      json(res, 429, { error: '尝试次数太多，请 15 分钟后再试' });
      return;
    }

    const record = store.findUserByEmail(email);
    const ok = record !== undefined && (await verifyPassword(parsed.value.password, record.passwordHash));
    if (record === undefined || !ok) {
      json(res, 401, { error: '邮箱或密码不对' });
      return;
    }
    if (record.disabled) {
      json(res, 403, { error: '这个账号已被停用' });
      return;
    }

    startSession(record, res);
    json(res, 200, { user: userPayload(record, store) });
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token !== undefined) store.deleteSession(hashToken(token));
    res.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
    json(res, 200, { ok: true });
  }

  // ── 人物与会话 ────────────────────────────────────────────────────

  async function handleCharacters(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!pathname.startsWith('/api/characters')) return false;

    const user = requireUser(req, res);
    if (user === null) return true;

    if (pathname === '/api/characters') {
      if (req.method === 'GET') {
        json(res, 200, { characters: store.listOwned(user.id) });
        return true;
      }
      if (req.method === 'POST') {
        let parsed: ReturnType<typeof parseCharacterInput>;
        try {
          parsed = parseCharacterInput(await readBody(req));
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
          return true;
        }
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        json(res, 201, { character: store.createCharacter(user.id, parsed.value) });
        return true;
      }
      json(res, 405, { error: '只支持 GET / POST' });
      return true;
    }

    if (pathname === '/api/characters/public') {
      if (req.method !== 'GET') {
        json(res, 405, { error: '只支持 GET' });
        return true;
      }
      json(res, 200, { characters: store.listPublic() });
      return true;
    }

    const cloneMatch = /^\/api\/characters\/([^/]+)\/clone$/.exec(pathname);
    if (cloneMatch !== null) {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return true;
      }
      const character = store.getCharacter(pathId(cloneMatch[1]));
      if (character === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      if (!canUse(character, user.id)) {
        json(res, 403, { error: '这个人物不能复制' });
        return true;
      }
      const copy = store.cloneCharacter(character.id, user.id);
      if (copy === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      json(res, 201, { character: copy });
      return true;
    }

    const conversationMatch = /^\/api\/characters\/([^/]+)\/conversation$/.exec(pathname);
    if (conversationMatch !== null) {
      if (req.method !== 'GET') {
        json(res, 405, { error: '只支持 GET' });
        return true;
      }
      const character = store.getCharacter(pathId(conversationMatch[1]));
      if (character === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      if (!canUse(character, user.id)) {
        json(res, 403, { error: '没有这个人物' });
        return true;
      }
      const conversation = store.getOrCreateConversation(user.id, character.id);
      if (conversation === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      json(res, 200, {
        conversationId: conversation.id,
        character,
        messages: store.messagesOf(conversation.id),
      });
      return true;
    }

    const conversationsMatch = /^\/api\/characters\/([^/]+)\/conversations$/.exec(pathname);
    if (conversationsMatch !== null) {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return true;
      }
      const character = store.getCharacter(pathId(conversationsMatch[1]));
      if (character === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      if (!canUse(character, user.id)) {
        json(res, 403, { error: '没有这个人物' });
        return true;
      }
      const conversation = store.createConversation(user.id, character.id);
      if (conversation === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      json(res, 201, { conversationId: conversation.id });
      return true;
    }

    const characterMatch = /^\/api\/characters\/([^/]+)$/.exec(pathname);
    if (characterMatch !== null) {
      const id = pathId(characterMatch[1]);
      const character = store.getCharacter(id);

      if (req.method === 'PATCH') {
        if (character === undefined) {
          json(res, 404, { error: '人物不存在' });
          return true;
        }
        if (character.ownerId !== user.id) {
          json(res, 403, { error: '只能修改自己的人物' });
          return true;
        }
        let parsed: ReturnType<typeof parseCharacterInput>;
        try {
          parsed = parseCharacterInput(await readBody(req));
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
          return true;
        }
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        const updated = store.updateCharacter(id, user.id, parsed.value);
        if (updated === undefined) {
          json(res, 404, { error: '人物不存在' });
          return true;
        }
        json(res, 200, { character: updated });
        return true;
      }

      if (req.method === 'DELETE') {
        if (character === undefined) {
          json(res, 404, { error: '人物不存在' });
          return true;
        }
        if (character.ownerId !== user.id) {
          json(res, 403, { error: '只能删除自己的人物' });
          return true;
        }
        store.deleteCharacter(id, user.id);
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 405, { error: '只支持 PATCH / DELETE' });
      return true;
    }

    json(res, 404, { error: 'not found' });
    return true;
  }

  // ── 聊天 ──────────────────────────────────────────────────────────

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = requireUser(req, res);
    if (user === null) return;

    let parsed: ReturnType<typeof parseChatRequest>;
    try {
      parsed = parseChatRequest(await readBody(req));
    } catch (error) {
      json(res, 400, { error: (error as Error).message });
      return;
    }
    if (!parsed.ok) {
      json(res, 400, { error: parsed.error });
      return;
    }

    const character = store.getCharacter(parsed.value.characterId);
    if (character === undefined || !canUse(character, user.id)) {
      json(res, 404, { error: '人物不存在' });
      return;
    }
    const conversation = store.getConversation(parsed.value.conversationId);
    if (conversation === undefined) {
      json(res, 404, { error: '会话不存在' });
      return;
    }
    if (conversation.userId !== user.id) {
      json(res, 403, { error: '这个会话不属于你' });
      return;
    }
    if (conversation.characterId !== character.id) {
      json(res, 400, { error: '这个会话不属于该人物' });
      return;
    }
    let settings;
    try {
      settings = await resolveSettings();
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
      return;
    }

    let provider: ModelProvider;
    try {
      provider = providerFactory(settings);
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
      return;
    }

    // 检查与占位之间不隔 await：同一用户的第二条并发请求在这里被挡掉。
    if (inFlight.has(user.id)) {
      json(res, 429, { error: '上一条还在回复，等它说完再发' });
      return;
    }
    inFlight.add(user.id);

    const day = utcDay();
    // 本地版不做额度限制：API key 是自己的，没必要给自己设卡。
    const limit =
      mode === 'local'
        ? Number.MAX_SAFE_INTEGER
        : user.dailyMessageLimit ?? store.getDailyLimitDefault();
    let reservation: ReturnType<CompanionStore['reserveChat']>;
    try {
      reservation = store.reserveChat(
        conversation.id,
        user.id,
        parsed.value.message,
        day,
        limit,
      );
    } catch (error) {
      inFlight.delete(user.id);
      json(res, 500, { error: (error as Error).message });
      return;
    }
    if (!reservation.ok) {
      inFlight.delete(user.id);
      json(res, 429, {
        error: `今天的 ${limit} 条额度用完了，明天再来吧`,
        limit,
        used: reservation.used,
      });
      return;
    }

    let history: readonly StoredMessage[];
    try {
      history = store.messagesOf(conversation.id, CONTEXT_MESSAGES);
    } catch (error) {
      inFlight.delete(user.id);
      json(res, 500, { error: (error as Error).message });
      return;
    }

    const controller = new AbortController();
    // 浏览器按“停止”或直接关页面时，把上游请求一起掐断。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let assistantText = '';
    let saved = false;
    const saveAssistant = () => {
      if (saved) return;
      saved = true;
      if (assistantText.trim() !== '') {
        store.appendMessage(conversation.id, 'assistant', assistantText);
      }
    };

    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      let stopReason = 'end_turn';
      for await (const event of provider.stream({
        system: buildSystemPrompt(character.personality, character.name),
        messages: toProviderMessages(history),
        tools: [],
        signal: controller.signal,
      })) {
        if (event.type === 'text') {
          assistantText += event.text;
          sse(res, { type: 'delta', text: event.text });
        } else if (event.type === 'done') {
          stopReason = event.stopReason;
          if (event.usage !== undefined) {
            store.addTokens(user.id, day, event.usage.inputTokens, event.usage.outputTokens);
            sse(res, { type: 'usage', usage: event.usage });
          }
          break;
        }
        // 陪伴端不挂工具：tool_use 不会出现，出现了也忽略。
      }

      saveAssistant();
      if (!res.writableEnded) {
        sse(res, { type: 'done', stopReason, remaining: reservation.remaining });
        res.end();
      }
    } catch (error) {
      saveAssistant();
      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = (error as Error).message || '模型请求失败';
      if (!res.headersSent) {
        json(res, 500, { error: message });
      } else if (!res.writableEnded) {
        sse(res, { type: 'error', message });
        res.end();
      }
    } finally {
      inFlight.delete(user.id);
    }
  }

  // ── 管理 ──────────────────────────────────────────────────────────

  function settingsPayload(): { registration: string; dailyLimit: number } {
    return {
      registration: store.getRegistrationMode(),
      dailyLimit: store.getDailyLimitDefault(),
    };
  }

  async function asrStatus(): Promise<{ enabled: boolean; wav: boolean }> {
    try {
      const settings = await resolveAsr();
      if (settings === undefined) return { enabled: false, wav: false };
      return {
        enabled: true,
        wav: settings.provider === 'local' || settings.provider === 'iflytek',
      };
    } catch (error) {
      if (!asrWarned) {
        asrWarned = true;
        console.warn(`[companion] ASR 配置不可用：${(error as Error).message}`);
      }
      return { enabled: false, wav: false };
    }
  }

  // ── 语音识别 ──────────────────────────────────────────────────────

  async function handleAsr(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = requireUser(req, res);
    if (user === null) return;

    const mimeType = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? '';
    if (audioExtension(mimeType) === undefined) {
      json(res, 415, { error: `不支持的音频类型：${mimeType === '' ? '未提供' : mimeType}` });
      return;
    }

    if (mode === 'cloud' && !asrLimiter.hit(user.id, ASR_LIMIT_PER_MINUTE, 60_000)) {
      json(res, 429, { error: '语音输入太频繁，请稍后再试' });
      return;
    }
    if (inFlightAsr.has(user.id)) {
      json(res, 429, { error: '上一条语音还在识别，等它完成再试' });
      return;
    }
    inFlightAsr.add(user.id);

    try {
      let audio: Buffer;
      try {
        audio = await readAudioBody(req, MAX_AUDIO_BYTES);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          json(res, 413, {
            error: `音频太大了（上限 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB）`,
          });
        } else {
          json(res, 400, { error: (error as Error).message || '读不了请求体' });
        }
        return;
      }
      if (audio.length === 0) {
        json(res, 400, { error: '没有收到音频' });
        return;
      }

      let settings: AsrSettings | undefined;
      try {
        settings = await resolveAsr();
      } catch (error) {
        console.warn(`[companion] ASR 配置不可用：${(error as Error).message}`);
        json(res, 503, { error: '语音识别配置有问题，请检查服务端日志' });
        return;
      }
      if (settings === undefined) {
        json(res, 503, {
          error: '服务端没有配置语音识别（DEEPCODE_ASR_API_KEY 或 ~/.deepcode/config.json 的 asr）',
        });
        return;
      }
      if (
        (settings.provider === 'local' || settings.provider === 'iflytek') &&
        audioExtension(mimeType) !== 'wav'
      ) {
        json(res, 415, { error: '当前语音识别需要 WAV 音频' });
        return;
      }

      let provider: AsrProvider;
      try {
        provider = asrProviderFactory(settings);
      } catch (error) {
        console.warn(`[companion] 建不起 ASR provider：${(error as Error).message}`);
        json(res, 500, { error: '语音识别服务内部错误' });
        return;
      }

      const controller = new AbortController();
      // 浏览器关页面 / 点停止时，把上游请求一起掐断。
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(provider.timeoutMs ?? ASR_TIMEOUT_MS),
      ]);
      try {
        const result = await provider.transcribe({ audio, mimeType, signal });
        if (controller.signal.aborted) return;
        json(res, 200, { text: result.text.trim().slice(0, MAX_MESSAGE) });
      } catch (error) {
        if (controller.signal.aborted) return;
        // 上游的原始报错只进服务端日志；给浏览器一句能读的话。
        console.warn(`[companion] ASR 失败：${(error as Error).message}`);
        if (error instanceof AsrUnavailableError) {
          json(res, 503, { error: '本地语音识别不可用，请检查模型和服务端日志' });
          return;
        }
        json(res, 502, { error: '语音识别失败，请稍后再试' });
      }
    } finally {
      inFlightAsr.delete(user.id);
    }
  }

  async function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!pathname.startsWith('/api/admin')) return false;

    if (mode === 'local') {
      json(res, 404, { error: '本地模式没有管理接口' });
      return true;
    }
    const admin = requireAdmin(req, res);
    if (admin === null) return true;

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('q') ?? '';
      json(res, 200, { users: store.listUsers(query, utcDay()) });
      return true;
    }

    const userMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
    if (userMatch !== null) {
      if (req.method !== 'PATCH') {
        json(res, 405, { error: '只支持 PATCH' });
        return true;
      }
      const id = pathId(userMatch[1]);
      let parsed: ReturnType<typeof parseAdminUserPatch>;
      try {
        parsed = parseAdminUserPatch(await readBody(req));
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return true;
      }
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      if (id === admin.id && parsed.value.disabled === true) {
        json(res, 400, { error: '不能停用自己' });
        return true;
      }
      if (parsed.value.disabled !== undefined) store.setUserDisabled(id, parsed.value.disabled);
      if (parsed.value.dailyMessageLimit !== undefined) {
        store.setUserDailyLimit(id, parsed.value.dailyMessageLimit);
      }
      const user = store.getUser(id);
      if (user === undefined) {
        json(res, 404, { error: '用户不存在' });
        return true;
      }
      json(res, 200, { user: userPayload(user, store) });
      return true;
    }

    if (pathname === '/api/admin/invites') {
      if (req.method === 'GET') {
        json(res, 200, { invites: store.listInvites() });
        return true;
      }
      if (req.method === 'POST') {
        let parsed: ReturnType<typeof parseInviteInput>;
        try {
          parsed = parseInviteInput(await readBody(req));
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
          return true;
        }
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        const code = randomBytes(6).toString('hex').toUpperCase();
        json(res, 201, { invite: store.createInvite(code, parsed.value.note, admin.id) });
        return true;
      }
      json(res, 405, { error: '只支持 GET / POST' });
      return true;
    }

    const inviteMatch = /^\/api\/admin\/invites\/([^/]+)$/.exec(pathname);
    if (inviteMatch !== null) {
      if (req.method !== 'DELETE') {
        json(res, 405, { error: '只支持 DELETE' });
        return true;
      }
      if (!store.disableInvite(pathId(inviteMatch[1]))) {
        json(res, 404, { error: '邀请码不存在' });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/admin/settings') {
      if (req.method === 'GET') {
        json(res, 200, settingsPayload());
        return true;
      }
      if (req.method === 'PATCH') {
        let parsed: ReturnType<typeof parseSettingsPatch>;
        try {
          parsed = parseSettingsPatch(await readBody(req));
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
          return true;
        }
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        if (parsed.value.registration !== undefined) {
          store.setSetting('registration.mode', parsed.value.registration);
        }
        if (parsed.value.dailyLimit !== undefined) {
          store.setSetting('daily_limit.default', String(parsed.value.dailyLimit));
        }
        json(res, 200, settingsPayload());
        return true;
      }
      json(res, 405, { error: '只支持 GET / PATCH' });
      return true;
    }

    const publishMatch = /^\/api\/admin\/characters\/([^/]+)\/publish$/.exec(pathname);
    if (publishMatch !== null) {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return true;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
        return true;
      }
      const isPublic =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>).public
          : undefined;
      if (typeof isPublic !== 'boolean') {
        json(res, 400, { error: 'public 必须是布尔值' });
        return true;
      }
      const character = store.publishCharacter(pathId(publishMatch[1]), isPublic);
      if (character === undefined) {
        json(res, 404, { error: '人物不存在' });
        return true;
      }
      json(res, 200, { character });
      return true;
    }

    json(res, 404, { error: 'not found' });
    return true;
  }

  // ── 静态文件 ──────────────────────────────────────────────────────

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(DIST, relative);
    // 目录穿越：解析后必须还在 dist 里。
    if (target !== DIST && !target.startsWith(DIST + sep)) return false;

    let filePath = target;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return false;
    } catch {
      // 单页应用：没有扩展名的路径回落到 index.html。
      if (extname(relative) !== '') return false;
      filePath = resolve(DIST, 'index.html');
      try {
        if (!(await stat(filePath)).isFile()) return false;
      } catch {
        return false;
      }
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
      if (mode === 'cloud' && !originAllowed(req, publicOrigin)) {
        json(res, 403, { error: '来源不被允许' });
        return;
      }
    }

    if (pathname === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/meta') {
      const session = currentUser(req);
      const asr = await asrStatus();
      json(res, 200, {
        mode,
        registration: mode === 'cloud' ? store.getRegistrationMode() : 'closed',
        user: session === null ? null : userPayload(session.user, store, mode),
        // 只报能力开关，不报 key / baseUrl / model —— 那些只在服务端。
        features: { asr: asr.enabled, asrWav: asr.wav },
      });
      return;
    }

    if (pathname === '/api/auth/register') {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return;
      }
      if (mode === 'local') {
        json(res, 400, { error: '本地模式不需要注册' });
        return;
      }
      await handleRegister(req, res);
      return;
    }

    if (pathname === '/api/auth/login') {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return;
      }
      if (mode === 'local') {
        json(res, 400, { error: '本地模式不需要登录' });
        return;
      }
      await handleLogin(req, res);
      return;
    }

    if (pathname === '/api/auth/logout') {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return;
      }
      handleLogout(req, res);
      return;
    }

    if (pathname === '/api/auth/me') {
      const session = currentUser(req);
      if (session === null) {
        json(res, 401, { error: '请先登录' });
        return;
      }
      json(res, 200, { user: userPayload(session.user, store) });
      return;
    }

    if (pathname === '/api/asr') {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return;
      }
      await handleAsr(req, res);
      return;
    }

    if (pathname === '/api/chat') {
      if (req.method !== 'POST') {
        json(res, 405, { error: '只支持 POST' });
        return;
      }
      await handleChat(req, res);
      return;
    }

    if (await handleAdmin(req, res, pathname)) return;
    if (await handleCharacters(req, res, pathname)) return;

    // 未命中的 API 不能回落到 index.html —— 前端会拿整页 HTML 去 JSON.parse。
    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }

    if (await serveStatic(req, res, pathname)) return;

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        '前端还没有构建。开发时访问 Vite 的 http://127.0.0.1:5173；' +
          '或先运行 pnpm --filter @deepcode/companion build。\n',
      );
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error('[companion] 未处理的请求错误：', error);
      if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
      else if (!res.writableEnded) res.end();
    });
  });
}

/** 环境变量里的管理员账号：存在就提升为 admin，不存在就创建。 */
async function bootstrapAdmin(store: CompanionStore, env: NodeJS.ProcessEnv): Promise<void> {
  const email = env.DEEPCODE_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.DEEPCODE_ADMIN_PASSWORD;
  if (email === undefined || email === '' || password === undefined || password === '') return;

  const existing = store.findUserByEmail(email);
  if (existing !== undefined) {
    if (existing.role !== 'admin') store.promoteAdmin(existing.id);
    return;
  }
  if (password.length < MIN_PASSWORD) {
    console.error(`[companion] DEEPCODE_ADMIN_PASSWORD 至少 ${MIN_PASSWORD} 位，管理员未创建`);
    return;
  }
  store.createUser({
    email,
    passwordHash: await hashPassword(password),
    displayName: '管理员',
    role: 'admin',
  });
  console.log(`[companion] 已创建管理员账号 ${email}`);
}

export async function startServer(mode: Mode): Promise<void> {
  const store = openCompanionDb({ mode });
  await bootstrapAdmin(store, process.env);

  const parsedPort = Number.parseInt(process.env.PORT ?? '', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3001;
  const host = process.env.DEEPCODE_HOST ?? (mode === 'cloud' ? '0.0.0.0' : '127.0.0.1');

  const publicOrigin = process.env.DEEPCODE_PUBLIC_ORIGIN?.trim() || undefined;
  const server = createCompanionServer({
    store,
    mode,
    secureCookies: process.env.DEEPCODE_COOKIE_SECURE === '1',
    publicOrigin,
  });

  server.listen(port, host, () => {
    console.log(`[companion] ${mode === 'cloud' ? '平台' : '本地'}模式`);
    console.log(`[companion] API 在 http://${host}:${port}`);
    console.log(`[companion] 数据在 ${defaultDbPath()}`);
    if (mode === 'local') console.log('[companion] 开发时请打开 http://127.0.0.1:5173');
  });
}
