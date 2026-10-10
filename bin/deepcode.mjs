#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'cli', 'main.ts');

const child = spawn(process.execPath, [join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
// code 为 null = 子进程被信号打死，那不是"成功"。
child.on('exit', (code) => process.exit(code ?? 1));
