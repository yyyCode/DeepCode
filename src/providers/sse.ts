/**
 * 逐帧读 SSE。
 *
 * 两家的形状不一样：Anthropic 每帧带 `event:` 行，OpenAI 只有 `data:` 行、以 `data: [DONE]` 收尾。
 * 所以这里只管切帧，`event` 允许是空串 —— 认不认空事件由各自的 provider 决定
 * （Anthropic 侧只认有名字的帧，与它原来的行为一致：那些帧本来就被丢掉）。
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = '';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      // 只看有没有 data：event 可以缺，data 缺了这帧就没有意义。
      if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };

      boundary = buffer.indexOf('\n\n');
    }
  }
}
