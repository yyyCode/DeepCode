/**
 * 从 stdin 读 PreToolUse 事件，看这次要写的内容里有没有密钥形状的东西。
 *
 * 有 → stderr 说清是哪一行、什么形状，退出码 2（classic 的"拦下"，理由会给模型看）。
 * 没有 → 退出码 0，一个字不说（"没意见"）。
 *
 * 只看**内容**，不看文件路径：路径判断是权限规则（deny: ["Write(./.env)"]）的事，
 * 插件不该重复实现一套，更不该因为路径看起来敏感就放行。
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    // 读不懂输入就别说"没问题"。退出码 1 = 非阻断错误，走过去。
    process.exit(1);
  }

  const input = event.tool_input ?? {};
  // Write 用 content，Edit 用 new_string。取不到就当空串 —— 一个扫不出东西的
  // 钩子不该误报。
  const text = typeof input.content === 'string' ? input.content
    : typeof input.new_string === 'string' ? input.new_string
    : '';
  if (text === '') process.exit(0);

  const patterns = [
    { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
    { name: '写成字面量的口令', re: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  ];

  const hits = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      if (pattern.re.test(line)) {
        // 只说形状与行号，**不回显那一行**：回显等于把密钥再抄一遍，
        // 而钩子的 stderr 会进模型上下文与转录文件。
        // 名字前面留一格：`看起来是Anthropic key` 在中文里会粘成一个词
        // （名字里带中文的那几条本来就分得开，但同一条代码不该两种观感）。
        hits.push(`第 ${index + 1} 行看起来是 ${pattern.name}`);
        break;
      }
    }
  }

  if (hits.length === 0) process.exit(0);

  process.stderr.write(
    `这次写入里发现了 ${hits.length} 处密钥形状的内容：\n` +
      hits.map((hit) => `  ${hit}`).join('\n') +
      '\n（secret-guard 插件拦下了这次写入。真要写进去，请先把密钥换成占位符或从环境变量读。）\n',
  );
  process.exit(2);
});
