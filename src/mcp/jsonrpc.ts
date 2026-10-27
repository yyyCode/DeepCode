import { StringDecoder } from 'node:string_decoder';
import { MAX_MCP_LINE_BYTES } from '../contract/mcp';

/**
 * 换行分隔的 JSON-RPC 2.0 —— MCP stdio 传输的全部。
 *
 * 没有 Content-Length 头，也没有批量消息：MCP 的 stdio 传输规定一条消息一行，
 * 消息内不得含裸换行。这里只做四件事：把字节流切成行、发请求、等响应、把
 * server 主动发来的请求兜底掉。
 *
 * ⚠️ 超时与中断都**必须**让调用方有机会发 `notifications/cancelled`：
 * 请求从 `pending` 表里删掉只是本地不再等，server 那边还在干活。
 * 这就是 `onCancel` 存在的唯一理由（`stdio-client.ts` 拿它发通知）。
 */

export type JsonRpcId = number | string;

export type JsonRpcRequestOptions = {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * 请求被本地放弃时调用（超时 / Ctrl-C）。参数是原因与请求 id ——
   * 后者是 `notifications/cancelled` 唯一需要的字段，而它只存在于这一层。
   */
  readonly onCancel?: (reason: 'timeout' | 'user', requestId: JsonRpcId) => void;
};

export type JsonRpcHandlers = {
  /** 写一条已经序列化好的消息（含换行由实现决定）。 */
  readonly write: (line: string) => void;
  /**
   * server → client 的请求。返回结果会被包成响应；抛错会变成 JSON-RPC error。
   * 省略时一律回 `-32601 Method not found` —— 不假装支持没实现的能力。
   */
  readonly onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** 收到非法 JSON / 不认识的信封。实现方决定 warn 还是丢。 */
  readonly onInvalid?: (line: string, error: unknown) => void;
  readonly maxLineBytes?: number;
};

type Pending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
};

export class JsonRpcTimeoutError extends Error {
  constructor(
    readonly requestId: JsonRpcId,
    readonly timeoutMs: number,
  ) {
    super(`JSON-RPC 请求超时（${timeoutMs}ms）`);
    this.name = 'JsonRpcTimeoutError';
  }
}

export class JsonRpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcRemoteError';
  }
}

/** server 请求的错误码。`-32601` 是「这个方法没实现」。 */
export class JsonRpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'JsonRpcMethodError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 字节流 → 行。
 *
 * `StringDecoder` 而不是 `chunk.toString()`：一个 UTF-8 字符可能横跨两个 chunk，
 * 直接 toString 会在边界上把中文/emoji 切成替换字符 —— 而 JSON 解析器只会报一句
 * 看不懂的语法错。
 *
 * 超限之后**丢弃后续全部输入**并只回调一次：这是「这台 server 已判死」的信号。
 * 继续接收一个已经失控的进程写出来的东西，等于把内存交给它。
 */
export class LineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private overflowed = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: Buffer): string[] {
    if (this.overflowed) return [];
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      this.overflowed = true;
      this.buffer = '';
      this.onOverflow();
      return [];
    }
    return this.takeLines();
  }

  /** 流结束时把最后一段没带换行的内容也交出去。 */
  end(): string[] {
    if (this.overflowed) return [];
    this.buffer += this.decoder.end();
    const lines = this.takeLines();
    const tail = this.buffer;
    this.buffer = '';
    return tail.trim() === '' ? lines : [...lines, tail];
  }

  private takeLines(): string[] {
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    const out: string[] = [];
    for (const part of parts) {
      // CRLF 的 `\r` 是分帧的一部分，不是正文。
      const line = part.replace(/\r$/, '');
      if (line.trim() !== '') out.push(line);
    }
    return out;
  }
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private closed: Error | undefined;
  readonly lines: LineDecoder;

  constructor(private readonly handlers: JsonRpcHandlers) {
    this.lines = new LineDecoder(
      handlers.maxLineBytes ?? MAX_MCP_LINE_BYTES,
      () => this.failAll(new Error(`单行 JSON-RPC 超过上限（${handlers.maxLineBytes ?? MAX_MCP_LINE_BYTES} 字节）`)),
    );
  }

  request(method: string, params: unknown, options: JsonRpcRequestOptions): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed);
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.cancel(options, 'user', id);
        reject(new Error(`JSON-RPC 请求已中断：${method}`));
      };

      this.pending.set(id, { resolve, reject, cleanup });

      timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.cancel(options, 'timeout', id);
        reject(new JsonRpcTimeoutError(id, options.timeoutMs));
      }, options.timeoutMs);

      // 已经 abort 的 signal 不会补发事件（`addEventListener` 的规矩）。
      // 上面入表到这一行之间夹着一次写，挤进这个窗口的 Ctrl-C 会就此丢失。
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.send({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`JSON-RPC 写失败：${messageOf(error)}`));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed !== undefined) return;
    try {
      this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    } catch {
      // 通知没有等待方。管道已经断了这件事由 close/failAll 那条线报告。
    }
  }

  /** 喂一行已经切好的文本。 */
  handleLine(line: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      this.handlers.onInvalid?.(line, error);
      return;
    }

    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      this.handlers.onInvalid?.(line, new Error('JSON-RPC 顶层不是一个对象'));
      return;
    }
    const record = envelope as Record<string, unknown>;

    // 请求：有 method 且有 id。通知：有 method 没有 id。
    if (typeof record['method'] === 'string') {
      const method = record['method'];
      if (record['id'] === undefined || record['id'] === null) {
        this.handlers.onNotification?.(method, record['params']);
        return;
      }
      const id = record['id'];
      if (typeof id !== 'number' && typeof id !== 'string') {
        this.handlers.onInvalid?.(line, new Error('JSON-RPC id 不是数字或字符串'));
        return;
      }
      void this.answerRequest(id, method, record['params']);
      return;
    }

    // 响应：必须有 id，且必须带 result 或 error。
    const id = record['id'];
    if (typeof id !== 'number' && typeof id !== 'string') {
      this.handlers.onInvalid?.(line, new Error('JSON-RPC 响应缺少合法 id'));
      return;
    }
    if (!('result' in record) && !('error' in record)) {
      this.handlers.onInvalid?.(line, new Error('JSON-RPC 响应既没有 result 也没有 error'));
      return;
    }

    const pending = this.pending.get(id);
    // 迟到的响应（本地已经超时/中断）是常态，不是错误。
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.cleanup();

    const error = record['error'];
    if (typeof error === 'object' && error !== null) {
      const detail = error as Record<string, unknown>;
      pending.reject(
        new JsonRpcRemoteError(
          typeof detail['code'] === 'number' ? detail['code'] : -32603,
          typeof detail['message'] === 'string' ? detail['message'] : 'JSON-RPC error',
          detail['data'],
        ),
      );
      return;
    }
    pending.resolve(record['result']);
  }

  /** 管道关闭 / 进程崩溃 / 超长行：所有等待方都拿到同一个原因。 */
  failAll(error: Error): void {
    if (this.closed !== undefined) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  get closedReason(): Error | undefined {
    return this.closed;
  }

  private cancel(options: JsonRpcRequestOptions, reason: 'timeout' | 'user', id: JsonRpcId): void {
    try {
      options.onCancel?.(reason, id);
    } catch {
      // 发通知失败不能盖住真正的超时/中断原因。
    }
  }

  private async answerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (method === 'ping') {
        this.send({ jsonrpc: '2.0', id, result: {} });
        return;
      }
      const handler = this.handlers.onRequest;
      if (handler === undefined) {
        throw new JsonRpcMethodError(-32601, `Method not found: ${method}`);
      }
      const result = await handler(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof JsonRpcMethodError ? error.code : -32603;
      this.send({ jsonrpc: '2.0', id, error: { code, message: messageOf(error) } });
    }
  }

  private send(message: Record<string, unknown>): void {
    this.handlers.write(JSON.stringify(message));
  }
}
