// 读 stdin，把 Stop 该有的两个字段原样编进拒绝理由里。
//
// 用途是让 `stop_hook_active` 与 `last_assistant_message` 这两个**映射**被一条断言钉住：
// 只看"拦住了"证明不了钩子拿到的是对的东西 —— 一个恒定 deny 的钩子也能把 turn 拦下来。
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const reason =
    `event=${input.hook_event_name}` +
    `|stop_hook_active=${String(input.stop_hook_active)}` +
    `|last=${String(input.last_assistant_message)}`;
  console.log(
    JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
});
