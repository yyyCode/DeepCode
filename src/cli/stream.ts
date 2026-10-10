import type { Plugin } from '../contract/plugin';
import type { Renderer } from './render';

/**
 * 把模型流出来的文本写到终端上。
 *
 * 这条 hook 不是装饰，是产品能不能说话的分界线：loop 把每个文本增量抛成
 * `turn.step`，而**内核里没有任何代码会把它画出来** —— 内核负责抛出事件，
 * 插件负责应答（`NOTIFICATION_EVENTS` 的兜底只是"没人听就返回空"）。
 *
 * 少了它，模型说的话一个字都到不了用户眼前，而 typecheck、lint、C1/C2 全绿：
 * 那些测试断言的是事件链与文件内容，不是终端上有没有字。
 */
export const streamPlugin = (render: Renderer): Plugin => ({
  name: 'cli-stream',
  uses: ['turn.step'],

  register(on) {
    // 只观察，不拦：写完就返回，链到此为止（这与"返回 undefined = 失败"是两回事）。
    on('turn.step', (_$, e) => {
      render.delta(e.delta);
      return {} as const;
    });
  },
});
