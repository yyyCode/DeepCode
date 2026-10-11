// 纯文本 stdout（不是 JSON）：exit 0 读不出判定 = "没意见"，但这句话是给人看的说明，
// 所以照旧回显。与 say-deny.mjs 成对 —— 那条的 stdout 是协议，不该回显。
console.log('这个仓库有约定：改完记得跑 fmt');
