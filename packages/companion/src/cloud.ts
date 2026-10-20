import { startServer } from './server';

// 平台版：公开注册/邀请码、账号隔离、额度、角色广场与管理接口都在这条路径上。
// 管理员账号由 DEEPCODE_ADMIN_EMAIL / DEEPCODE_ADMIN_PASSWORD 引导创建。
await startServer('cloud');
