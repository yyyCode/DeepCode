#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' +
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2';

const url = process.env.DEEPCODE_ASR_MODEL_URL ?? DEFAULT_URL;
const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
const target =
  process.env.DEEPCODE_ASR_MODEL_DIR ??
  join(home, '.deepcode', 'models', 'asr', 'sensevoice-small-int8');
const force = process.argv.includes('--force');

function hasModel(dir) {
  return (
    (existsSync(join(dir, 'model.int8.onnx')) || existsSync(join(dir, 'model.onnx'))) &&
    existsSync(join(dir, 'tokens.txt'))
  );
}

if (hasModel(target) && !force) {
  console.log(`模型已经在了：${target}`);
  console.log('要重新下载，加 --force。');
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'deepcode-asr-'));
const archive = join(temp, 'model.tar.bz2');
const extracted = join(temp, 'extracted');

try {
  console.log(`下载 SenseVoice 模型（约 155 MB）：\n${url}`);
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPercent = -1;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (total <= 0) return;
    const percent = Math.min(100, Math.floor((received / total) * 100));
    if (percent >= lastPercent + 10) {
      lastPercent = percent;
      process.stdout.write(`\r${percent}%`);
    }
  });
  await pipeline(source, createWriteStream(archive));
  process.stdout.write('\r100%\n');

  mkdirSync(extracted, { recursive: true });
  const tar = spawnSync(
    'tar',
    ['-xjf', archive, '-C', extracted, '--strip-components=1'],
    { stdio: 'inherit' },
  );
  if (tar.error !== undefined || tar.status !== 0) {
    throw new Error(
      '解压失败。系统里需要有支持 bzip2 的 tar。可以手动解压后把 ' +
        'model.int8.onnx 和 tokens.txt 放到 ' +
        target,
    );
  }
  if (!hasModel(extracted)) {
    throw new Error('解压后没有找到 model.int8.onnx / tokens.txt');
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(extracted, target, { recursive: true });

  console.log(`模型已就绪：${target}`);
  console.log(
    '在 ~/.deepcode/config.json 里写 "asr": { "provider": "local", "language": "zh" } 即可启用。',
  );
  console.log(
    'SenseVoice 权重使用 FunASR Model License v1.1（不是 Apache-2.0）：' +
      'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
  );
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
