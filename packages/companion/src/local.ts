import { startServer } from './server';

// 本地版：只绑 127.0.0.1，登录态直接落到内置的 local 用户，不需要账号。
await startServer('local');
