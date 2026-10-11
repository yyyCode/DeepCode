import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { renderOffer } from './offer';

/**
 * 系统提示的**每轮重算**（P7 §3.2）。
 *
 * P7 之前这三段是在启动时拼一次、整场会话复用一个字符串（原 `main.ts` 里那三行）。
 * 改成每轮重算有两个理由，第二个才是重点：
 *
 * 1. 会话中改 `AGENTS.md` / 加一个目录约定之后**当场生效**，不必重启；
 * 2. **压缩之后注入面必须重新求值** —— 压缩丢的是对话，不是文件。既然约定是可重算的，
 *    "压缩后重新装载"就只是"再算一次"，而不是一条特例（`mods/agents-md/nested.ts`
 *    那边清去重表，同一件事的另一半）。
 *
 * 复刻对象（`claude-code-架构分析/11-memory-and-context.md`）把这条叫"重算优于搬运"：
 * `prompt.context` 属于"答案被会话缓存、配置变更即失效"的那六个事件。
 *
 * ⚠️ **代价如实写在这里**：每轮最多多 3 次文件读；而且系统提示的**字节可能在会话中途
 * 变化**。我们不主动管 prompt cache（命中由端点侧隐式决定），所以这条只影响隐式命中 ——
 * 但它是真变化。复刻对象为此专门冻结过"记忆文件年龄注记"（其 CHANGELOG `2.1.275`），
 * 我们没到那一步，记在这儿备查。
 *
 * `pieces` 是给 `/context` 用的分节账：`text` 由 `pieces` 拼出来，**不另算一份** ——
 * 两本账的话，屏幕上那个合计数迟早与真正送进模型的那段对不上。
 */
export type PromptPiece = { readonly name: string; readonly text: string };

export type BuiltPrompt = {
  readonly text: string;
  /** 分节明细。空段（`''`）不进这里，与拼进 `text` 的那几段严格同一个集合。 */
  readonly pieces: readonly PromptPiece[];
};

export type PromptBuilder = {
  /** 每轮调一次。 */
  build(): Promise<BuiltPrompt>;
  /** 最近一次算出来的那份（`/context` 读它）。还没算过时 `undefined`。 */
  last(): BuiltPrompt | undefined;
};

export function createPromptBuilder(deps: {
  /** 基础那份（`main.ts` 的 `SYSTEM_PROMPT`），**不含**指令文件与清单。 */
  readonly base: string;
  readonly dispatch: DispatchFn;
}): PromptBuilder {
  let last: BuiltPrompt | undefined;

  return {
    last: () => last,

    async build(): Promise<BuiltPrompt> {
      // 指令文件（AGENTS.md / CLAUDE.md）从 `prompt.section` 来 —— 摘掉那个插件的注册，
      // 它们就不再进提示。清单一节（`renderOffer`）**有意没走这条路**：它要的是
      // `agent.offer` 的结果，而插件拿不到 dispatch（设计 §3.5）。
      const sections = await deps.dispatch('prompt.section', {}, CORE_ORIGIN);
      const offer = await deps.dispatch('agent.offer', {}, CORE_ORIGIN);

      const pieces: PromptPiece[] = [
        { name: 'base', text: deps.base },
        ...sections.sections.map((section) => ({ name: section.name, text: section.text })),
        { name: 'offer', text: renderOffer(offer) },
      ].filter((piece) => piece.text !== '');

      last = { text: pieces.map((piece) => piece.text).join('\n\n'), pieces };
      return last;
    },
  };
}
