/**
 * 一个**不改引擎**的插件：加一个工具。
 *
 * 它一行内核代码都没碰 —— 工具清单来自注册面上 `tool.call` 的 matcher 取值
 * （`$.tool.list()` 就是这么实现的），所以"注册上来"就等于"模型看得见"。
 *
 * 它也不是特权：走的是与 Read / Write / Bash 完全相同的那两条事件
 * （`tool.describe` 说清参数、`tool.call` 干活），而权限判定由内核那一条
 * `tool.check` 链负责 —— 这个插件连问都不问，也没法替用户答。
 */
export default {
  register(on) {
    on('tool.describe', { tool: 'TodoWrite' }, () => ({
      description: '往当前工作目录的 .deepcode-todo.md 追加一条待办。',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', description: '待办内容（一句话）' },
        },
        required: ['item'],
      },
    }));

    // ⚠️ 这一条**必须有**，而且不是走过场。`confirm` 坐 `builtin`，它对 `tool.check`
    // 的注册不带 matcher 且不调 `next` —— 一个它不认识的工具会被当"未知工具"**直接拒掉**。
    // 光在清单的 `uses` 里写上一句 `tool.check` 没用（那只让 W7 这条警告闭嘴），
    // 得真的在这个钩子点上应答一次。插件答了 `ask`，链就在它这儿结束（`confirm` 不再跑，
    // 所以不会有它生成的预览 —— 那是"链上先应答者胜"的直接后果，不是 bug）。
    // 插件**不能**答 `allow`：第三方的 allow 会被丢弃（core/third-party.ts），
    // 于是那一下等于把判定交回 `confirm`，工具又变成"未知工具"。
    on('tool.check', { tool: 'TodoWrite' }, () => ({
      decision: 'ask',
      rule: '插件工具：TodoWrite',
    }));

    on('tool.call', { tool: 'TodoWrite' }, async ($, e) => {
      // 模型给的东西一律当不可信输入：它可能给个对象、给个空串、给个数字。
      const input = e.input ?? {};
      const item = typeof input.item === 'string' ? input.item.trim() : '';
      if (item === '') return { deny: 'TodoWrite 需要 item（非空字符串）' };

      const path = `${$.session.cwd()}/.deepcode-todo.md`;
      let existing = '';
      try {
        existing = await $.fs.read(path);
      } catch {
        // 第一次用，文件还不存在。这不是错误。
      }
      const header = existing === '' ? '# 待办\n\n' : '';
      await $.fs.write(path, `${existing}${header}- [ ] ${item}\n`);
      return { value: `已记下：${item}` };
    });
  },
};
