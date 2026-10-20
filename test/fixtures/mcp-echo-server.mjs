#!/usr/bin/env node
// 测试用的最小 MCP stdio server：手写 JSON-RPC，不依赖 SDK。
// 只实现 initialize / tools/list / tools/call / ping 四条路径。
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: '回显一段文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'fail',
    description: '总是报错',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'structured',
    description: '只返回结构化内容',
    inputSchema: { type: 'object', properties: {} },
  },
];

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

function handle(message) {
  if (Array.isArray(message)) {
    for (const item of message) handle(item);
    return;
  }
  if (message === null || typeof message !== 'object') return;

  const { id, method, params } = message;
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') return;

  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'echo') {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] },
      });
      return;
    }
    if (name === 'fail') {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'boom' }], isError: true },
      });
      return;
    }
    if (name === 'structured') {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [], structuredContent: { answer: 42 } },
      });
      return;
    }
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
    return;
  }

  if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  try {
    handle(JSON.parse(trimmed));
  } catch {
    // 坏消息直接丢掉；测试要的是"客户端能不能正常说话"，不是容错服务器。
  }
});
rl.on('close', () => process.exit(0));
