import { createHash } from 'node:crypto';

/**
 * 两家 provider 的函数名都只接受 `[A-Za-z0-9_-]`，长度上限 64。
 * 这里按最严的那一档做，宁短勿长。
 */
export const MAX_TOOL_NAME = 64;

const HASH_LENGTH = 8;

export type ToolIdentity = {
  readonly server: string;
  readonly name: string;
};

/**
 * 把 MCP 的 server/tool 名映射成模型看得见的工具名。
 *
 * 前缀 `mcp__` 同时干两件事：避开内建工具名，以及让人一眼看出它来自 MCP。
 * 同一个 (server, tool) 永远得到同一个名字；不同来源撞名时加一段内容哈希，
 * 结果仍然是确定的 —— 重连之后名字不会跳。
 */
export function allocateVisibleToolNames(entries: readonly ToolIdentity[]): readonly string[] {
  const used = new Set<string>();
  const out: string[] = [];

  for (const entry of entries) {
    const base = baseName(entry);
    let candidate = base;
    if (used.has(candidate)) candidate = withHash(base, shortHash(entry));

    // 哈希也撞的概率可以忽略，但撞了也不能把两个工具合并成一个。
    let attempt = 2;
    while (used.has(candidate)) {
      candidate = withHash(base, `${shortHash(entry)}_${attempt}`);
      attempt += 1;
    }

    used.add(candidate);
    out.push(candidate);
  }

  return out;
}

/** 单条映射，不做跨项去重。测试与调试用；正式路径走 `allocateVisibleToolNames`。 */
export function visibleToolName(server: string, tool: string): string {
  return baseName({ server, name: tool });
}

function baseName(entry: ToolIdentity): string {
  const server = cleanPart(entry.server);
  const tool = cleanPart(entry.name);
  const raw = `mcp__${server}__${tool}`;
  if (raw.length <= MAX_TOOL_NAME) return raw;
  return withHash(raw, shortHash(entry));
}

function cleanPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? 'x' : cleaned;
}

function shortHash(entry: ToolIdentity): string {
  return createHash('sha256')
    .update(`${entry.server}\0${entry.name}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

function withHash(base: string, suffix: string): string {
  const tail = `_${suffix}`;
  if (base.length + tail.length <= MAX_TOOL_NAME) return `${base}${tail}`;
  return `${base.slice(0, MAX_TOOL_NAME - tail.length)}${tail}`;
}
