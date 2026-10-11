// 只有 additionalContext、没有判定：`UserPromptSubmit` / `PostToolUse` 上钩子唯一能做的事。
// 与 say-deny.mjs 成对 —— 那条走 permissionDecision（判定），这条走 additionalContext（说话）。
console.log(
  JSON.stringify({
    hookSpecificOutput: { additionalContext: '本仓库的约定：改完记得跑 fmt' },
  }),
);
