// 把收到的 stdin **原样**当 additionalContext 交回去。
//
// 唯一用途是让测试看得见"桥到底递了什么进去"—— `tool_response` 是我们自己的形状
// （`{ok, output}`），不是参考实现那一个，所以它必须被一条断言钉住，而不是靠人读代码。
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: raw } }));
});
