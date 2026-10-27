import { describe, expect, it } from 'vitest';
import {
  JsonRpcMethodError,
  JsonRpcPeer,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
  LineDecoder,
} from '../src/mcp/jsonrpc';

/** 一对内存里的 peer：A 写出去的行直接喂给 B，反之亦然。 */
function linkedPair(options: {
  serverRequests?: (method: string, params: unknown) => unknown;
  invalid?: (line: string, error: unknown) => void;
  notifications?: { method: string; params: unknown }[];
} = {}) {
  let server: JsonRpcPeer;
  const client = new JsonRpcPeer({
    write: (line) => server.handleLine(line),
    ...(options.invalid === undefined ? {} : { onInvalid: options.invalid }),
    ...(options.notifications === undefined
      ? {}
      : { onNotification: (method, params) => options.notifications?.push({ method, params }) }),
  });
  server = new JsonRpcPeer({
    write: (line) => client.handleLine(line),
    onRequest: (method, params) =>
      options.serverRequests === undefined
        ? Promise.reject(new JsonRpcMethodError(-32601, `Method not found: ${method}`))
        : options.serverRequests(method, params),
    ...(options.invalid === undefined ? {} : { onInvalid: options.invalid }),
  });
  return { client, server };
}

describe('LineDecoder', () => {
  it('跨 chunk 的 UTF-8 字符不会被切坏', () => {
    const lines: string[] = [];
    const decoder = new LineDecoder(1024, () => {});
    const bytes = Buffer.from('{"a":"你"}\n{"b":2}\r\n', 'utf8');
    // 故意切在「你」的三个字节中间。
    const cut = bytes.indexOf(Buffer.from('你')) + 1;
    lines.push(...decoder.push(bytes.subarray(0, cut)));
    lines.push(...decoder.push(bytes.subarray(cut)));
    expect(lines).toEqual(['{"a":"你"}', '{"b":2}']);
  });

  it('超限只回调一次，之后不再接收', () => {
    let overflows = 0;
    const decoder = new LineDecoder(8, () => {
      overflows += 1;
    });
    expect(decoder.push(Buffer.from('{"long":"0123456789"}'))).toEqual([]);
    expect(decoder.push(Buffer.from('{"again":1}\n'))).toEqual([]);
    expect(overflows).toBe(1);
  });

  it('end() 交出最后一段没有换行的内容', () => {
    const decoder = new LineDecoder(1024, () => {});
    expect(decoder.push(Buffer.from('{"a":1}'))).toEqual([]);
    expect(decoder.end()).toEqual(['{"a":1}']);
  });
});

describe('JsonRpcPeer', () => {
  it('请求得到结果', async () => {
    const { client } = linkedPair({ serverRequests: () => ({ ok: true }) });
    await expect(
      client.request('tools/list', {}, { timeoutMs: 500 }),
    ).resolves.toEqual({ ok: true });
  });

  it('远程 error 变成 JsonRpcRemoteError', async () => {
    const { client } = linkedPair({
      serverRequests: () => {
        throw new JsonRpcMethodError(-32601, 'Method not found: x');
      },
    });
    const error = await client.request('x', {}, { timeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcRemoteError);
    expect((error as JsonRpcRemoteError).code).toBe(-32601);
  });

  it('超时会 reject 并回报原因', async () => {
    const cancels: string[] = [];
    const peer = new JsonRpcPeer({ write: () => {} });
    const error = await peer
      .request('slow', {}, { timeoutMs: 10, onCancel: (reason) => cancels.push(reason) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JsonRpcTimeoutError);
    expect(cancels).toEqual(['timeout']);
  });

  it('abort 会 reject 并回报 user', async () => {
    const cancels: string[] = [];
    const controller = new AbortController();
    const peer = new JsonRpcPeer({ write: () => {} });
    const pending = peer.request('slow', {}, {
      timeoutMs: 5_000,
      signal: controller.signal,
      onCancel: (reason) => cancels.push(reason),
    });
    controller.abort();
    await expect(pending).rejects.toThrow('已中断');
    expect(cancels).toEqual(['user']);
  });

  it('非法 JSON 与不认识的信封走 onInvalid', () => {
    const invalid: string[] = [];
    const peer = new JsonRpcPeer({
      write: () => {},
      onInvalid: (line, error) => invalid.push(`${line}:${String(error)}`),
    });
    peer.handleLine('{');
    peer.handleLine('[]');
    peer.handleLine('{"id":1}');
    expect(invalid).toHaveLength(3);
  });

  it('server 的 ping 自动回空对象', () => {
    const writes: string[] = [];
    const peer = new JsonRpcPeer({ write: (line) => writes.push(line) });
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
    expect(JSON.parse(writes[0] ?? '')).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('不认识的 server 请求回 -32601', () => {
    const writes: string[] = [];
    const peer = new JsonRpcPeer({ write: (line) => writes.push(line) });
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage' }));
    const response = JSON.parse(writes[0] ?? '') as { error?: { code?: number } };
    expect(response.error?.code).toBe(-32601);
  });

  it('通知交给 onNotification', () => {
    const seen: { method: string; params: unknown }[] = [];
    const peer = new JsonRpcPeer({
      write: () => {},
      onNotification: (method, params) => seen.push({ method, params }),
    });
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }));
    expect(seen).toEqual([{ method: 'notifications/message', params: { level: 'info' } }]);
  });

  it('failAll 拒绝所有等待方，迟到响应不抛', async () => {
    const peer = new JsonRpcPeer({ write: () => {} });
    const pending = peer.request('never', {}, { timeoutMs: 5_000 });
    peer.failAll(new Error('进程退出了'));
    await expect(pending).rejects.toThrow('进程退出了');
    expect(() => peer.handleLine('{"jsonrpc":"2.0","id":1,"result":{}}')).not.toThrow();
    await expect(peer.request('later', {}, { timeoutMs: 10 })).rejects.toThrow('进程退出了');
  });
});
