export const TARGET_RATE = 16_000;
export const MAX_SECONDS = 60;

function ascii(data: Uint8Array, offset: number): string {
  let value = '';
  for (let i = 0; i < 4; i += 1) {
    value += String.fromCharCode(data[offset + i] ?? 0);
  }
  return value;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
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

/**
 * 只接受 PCM 16-bit 的 WAV，并统一成 16 kHz 单声道。
 *
 * 浏览器的 `MediaRecorder` 产出的是 webm/opus 或 mp4；本地识别和讯飞文件识别
 * 都要求这个格式，所以浏览器先用 WebAudio 解码并转换，服务端因此不需要 ffmpeg。
 */
export function parseWav(data: Uint8Array): Float32Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (
    data.byteLength < 44 ||
    ascii(data, 0) !== 'RIFF' ||
    ascii(data, 8) !== 'WAVE'
  ) {
    throw new Error('不是合法的 WAV 文件');
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let format = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const id = ascii(data, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, data.byteLength - body);
    }
    // WAV 的 chunk 按偶数字节对齐。
    offset = body + size + (size % 2);
  }

  if (format !== 1) throw new Error('只支持 PCM WAV');
  if (bitsPerSample !== 16) throw new Error('只支持 16-bit WAV');
  if (channels < 1 || channels > 8) throw new Error('WAV 声道数不合法');
  if (sampleRate < 8_000 || sampleRate > 192_000) throw new Error('WAV 采样率不合法');
  if (dataOffset < 0 || dataLength === 0) throw new Error('WAV 里没有音频数据');

  const frameBytes = channels * 2;
  const frames = Math.floor(dataLength / frameBytes);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + frame * frameBytes + channel * 2, true);
    }
    mono[frame] = sum / channels / 32_768;
  }

  return resample(mono, sampleRate, TARGET_RATE);
}

/** 把 16 kHz 单声道采样写成标准 PCM16 WAV。 */
export function encodeWav(
  samples: Float32Array,
  sampleRate = TARGET_RATE,
): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true);
  }
  return bytes;
}
