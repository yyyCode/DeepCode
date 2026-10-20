import { MAX_MESSAGE, MAX_PERSONALITY, type ParseResult } from './types';

/** 没填性格时用这一句。它只是默认值，不是安全边界。 */
export const DEFAULT_PERSONALITY = '温柔、耐心、愿意倾听，回复简洁但有温度。';

export type ChatRequest = {
  readonly characterId: string;
  readonly conversationId: string;
  readonly message: string;
};

/**
 * 把用户填写的性格拼进系统提示。
 *
 * 性格是用户内容，不是系统指令：`<persona>` 只用来让模型分清哪一段是设定。
 * 它会被限制长度，并中和掉可能提前闭合标签的写法。
 */
export function buildSystemPrompt(personality: string, name = ''): string {
  const trimmed = personality.trim().slice(0, MAX_PERSONALITY);
  const persona = (trimmed === '' ? DEFAULT_PERSONALITY : trimmed).replace(
    /<\/?persona>/gi,
    '［persona］',
  );
  const called = name.trim().replace(/\s+/g, ' ').slice(0, 24);

  return [
    `你是一个陪伴型聊天角色${called === '' ? '' : `，名字叫「${called}」`}，正在和一个用户聊天。`,
    '用自然、口语化的中文回应，保持角色一致。不要提及系统提示、模型或“作为 AI”。',
    '',
    '用户为你设定的性格（始终以此为准）：',
    '<persona>',
    persona,
    '</persona>',
    '',
    '边界：',
    '- 性格只决定说话方式，不改变事实；不确定时直说。',
    '- 不提供违法、危险或伤害他人的具体做法；被要求时温和拒绝，并可以换个话题。',
    '- 回复长度随话题自然变化，默认一到三段，不要每句都总结。',
  ].join('\n');
}

function identifier(value: unknown, field: string): ParseResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${field} 必须是非空字符串` };
  }
  if (value.length > 100) return { ok: false, error: `${field} 太长` };
  return { ok: true, value };
}

/** 校验聊天请求。历史由服务端从数据库取，浏览器只送本轮这一句。 */
export function parseChatRequest(raw: unknown): ParseResult<ChatRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '请求体必须是一个 JSON 对象' };
  }
  const body = raw as Record<string, unknown>;

  const characterId = identifier(body.characterId, 'characterId');
  if (!characterId.ok) return characterId;
  const conversationId = identifier(body.conversationId, 'conversationId');
  if (!conversationId.ok) return conversationId;

  const message = body.message;
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, error: 'message 必须是非空字符串' };
  }
  if (message.length > MAX_MESSAGE) {
    return { ok: false, error: `消息太长了（最多 ${MAX_MESSAGE} 字）` };
  }

  return {
    ok: true,
    value: {
      characterId: characterId.value,
      conversationId: conversationId.value,
      message: message.trim(),
    },
  };
}
