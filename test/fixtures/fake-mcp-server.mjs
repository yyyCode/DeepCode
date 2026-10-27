// 测试用 stdio MCP server。零依赖，只用 node: 内建。
// 用 FAKE_MCP_MODE 切换行为：normal（默认）/ no-tools / paginated / bad-json /
// crash-on-call / exit-early。
import process from 'node:process';

const mode = process.env.FAKE_MCP_MODE ?? 'normal';

function debug(line) {
  process.stderr.write(`${line}\n`);
}

if (mode === 'exit-early') {
  debug('fake server: 启动即退出');
  process.exit(1);
}

const ALL_TOOLS = [
  {
    name: 'echo',
    description: '回显参数',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'fail', description: '返回 isError', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: '慢调用', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'mixed', description: '', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: '只有 structuredContent', inputSchema: { type: 'object', properties: {} } },
  { name: 'empty', description: '空结果', inputSchema: { type: 'object', properties: {} } },
  { name: 'error', description: 'JSON-RPC 错误', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: '调用后整个进程退出', inputSchema: { type: 'object', properties: {} } },
  { name: 'bad-name.v2', description: '名字需要合法化', inputSchema: { type: 'object', properties: {} } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function reply(id, result) {
  send({ id, result });
}

function fail(id, code, message) {
  send({ id, error: { code, message } });
}

function pageOf(params) {
  if (mode !== 'paginated') return ALL_TOOLS;
  const cursor = params?.cursor;
  if (cursor === undefined) return ALL_TOOLS.slice(0, 2);
  return ALL_TOOLS.slice(2);
}

function nextCursorOf(params) {
  if (mode !== 'paginated' || params?.cursor !== undefined) return undefined;
  return 'page-2';
}

function callTool(id, name, args) {
  switch (name) {
    case 'echo':
      return reply(id, { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] });

    case 'fail':
      return reply(id, { isError: true, content: [{ type: 'text', text: 'boom' }] });

    case 'slow': {
      const ms = typeof args?.ms === 'number' ? args.ms : 2_000;
      setTimeout(() => reply(id, { content: [{ type: 'text', text: 'slow done' }] }), ms);
      return undefined;
    }

    case 'mixed':
      return reply(id, {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'file body' } },
          { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA' } },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
          { type: 'weird', foo: 1 },
        ],
      });

    case 'structured':
      return reply(id, { structuredContent: { ok: true, n: 2 } });

    case 'empty':
      return reply(id, { content: [] });

    case 'error':
      return fail(id, -32000, 'tool exploded');

    case 'crash':
      process.exit(1);
      return undefined;

    case 'bad-name.v2':
      return reply(id, { content: [{ type: 'text', text: 'sanitized' }] });

    default:
      return fail(id, -32602, `Unknown tool: ${name}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') handle(line);
    index = buffer.indexOf('\n');
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    debug(`fake server: 收到非法 JSON：${line}`);
    return;
  }

  if (typeof message?.method !== 'string') return;

  // 通知：没有 id。
  if (message.id === undefined || message.id === null) {
    if (message.method === 'notifications/cancelled') {
      // 客户端超时/中断时会发这条。测试从 stderr 里看它有没有到。
      debug(`cancelled:${message.params?.requestId}:${message.params?.reason}`);
    }
    return;
  }

  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: process.env.FAKE_MCP_VERSION ?? params?.protocolVersion ?? '2025-06-18',
        capabilities: mode === 'no-tools' ? {} : { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      });
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list': {
      if (mode === 'bad-json') process.stdout.write('this is not json\n');
      const nextCursor = nextCursorOf(params);
      reply(id, {
        tools: pageOf(params),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
      return;
    }

    case 'tools/call': {
      if (mode === 'crash-on-call') process.exit(1);
      const name = params?.name;
      const args = params?.arguments;
      if (typeof name !== 'string') {
        fail(id, -32602, 'tools/call 缺少 name');
        return;
      }
      callTool(id, name, args);
      return;
    }

    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}
