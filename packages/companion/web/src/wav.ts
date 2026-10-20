const TARGET_RATE = 16_000;

/**
 * 本地 SenseVoice 只吃 16 kHz 单声道 PCM。MediaRecorder 给的是 webm/opus 或 mp4，
 * 先在浏览器里解码、混成单声道、重采样，再编码成 WAV 上传。
 *
 * 60 秒 16 kHz / 16-bit 约 1.9 MB，仍在服务端 8 MB 限制内。
 */
export async function toWav(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, TARGET_RATE);
  const decoded = await context.decodeAudioData(bytes);
  const mono = mixToMono(decoded);
  const samples = resample(mono, decoded.sampleRate, TARGET_RATE);
  return encodeWav(samples);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const frames = buffer.length;
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();

  const out = new Float32Array(frames);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      out[frame] = (out[frame] ?? 0) + (data[frame] ?? 0) / channels;
    }
  }
  return out;
}

function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  const length = Math.max(1, Math.floor((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const ratio = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    out[i] =
      (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function encodeWav(samples: Float32Array): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // 字节率
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(
      44 + i * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return new Blob([bytes], { type: 'audio/wav' });
}
