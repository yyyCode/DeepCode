import type { DispatchFn } from '../core/dispatch';
import { CORE_ORIGIN } from '../contract/next';
import { renderOffer } from './offer';
import {
  renderEnvironment,
  STATIC_PROMPT_SECTIONS,
  type PromptEnvironment,
  type PromptSection,
} from './prompt-text';

/**
 * 系统提示的**每轮重算**（P7 §3.2）与**静态/动态分界**（P13）。
 *
 * P7 之前这三段是在启动时拼一次、整场会话复用一个字符串（原 `main.ts` 里那三行）。
 * 改成每轮重算有两个理由，第二个才是重点：
 *
 * 1. 会话中改 `AGENTS.md` / 加一个目录约定之后**当场生效**，不必重启；
 * 2. **压缩之后注入面必须重新求值** —— 压缩丢的是对话，不是文件。既然约定是可重算的，
 *    "压缩后重新装载"就只是"再算一次"，而不是一条特例（`mods/agents-md/nested.ts`
 *    那边清去重表，同一件事的另一半）。
 *
 * P13 把"每轮都变"收窄到真正会变的那一段：代码常量（角色、安全边界、操作安全、
 * 工具选择、Git、输出）排在前面，标记 `cache: 'static'`；环境、指令文件、记忆、
 * 子代理清单排在后面，标记 `cache: 'dynamic'`。端点只缓存前面的前缀 ——
 * 静态段里混进一个 cwd，整段缓存就作废，所以这条分界必须由**拼装函数**保证，
 * 不能靠写提示词的人自觉。
 *
 * ⚠️ **代价如实写在这里**：每轮最多多 3 次文件读；系统提示的**动态尾巴**可能在会话
 * 中途变化。静态段是我们自己冻结的，动没动由 `test/system-prompt-cache.test.ts` 钉住。
 *
 * `pieces` 是给 `/context` 用的分节账：`text` 由 `pieces` 拼出来，**不另算一份** ——
 * 两本账的话，屏幕上那个合计数迟早与真正送进模型的那段对不上。
 * `staticText` / `dynamicText` 同样是从 `pieces` 拼的，供 provider 放缓存断点。
 */
export type PromptPiece = {
  readonly name: string;
  readonly text: string;
  /**
   * 这段在会话内会不会变。省略 = 不知道（旧测试夹具），账本不把它算进任何一边。
   * `'static'` 的段必须排在所有 `'dynamic'` 段之前 —— 这是前缀缓存的前提。
   */
  readonly cache?: 'static' | 'dynamic';
};

export type BuiltPrompt = {
  readonly text: string;
  /** 分节明细。空段（`''`）不进这里，与拼进 `text` 的那几段严格同一个集合。 */
  readonly pieces: readonly PromptPiece[];
  /** 静态前缀，**会话内逐字节不变**。provider 把缓存断点放在它后面。 */
  readonly staticText: string;
  /** 动态尾巴，每轮可以不同；不参与前缀缓存。 */
  readonly dynamicText: string;
};

/**
 * REPL 每轮只需要这三样；`pieces` 留给 `/context` 自己从 `last()` 取。
 * 拆分字段可选：只给 `text` 的旧调用方（以及测试）不必伪造前缀。
 */
export type TurnPrompt = {
  readonly text: string;
  readonly staticText?: string;
  readonly dynamicText?: string;
};

export type PromptBuilder = {
  /** 每轮调一次。 */
  build(): Promise<BuiltPrompt>;
  /** 最近一次算出来的那份（`/context` 读它）。还没算过时 `undefined`。 */
  last(): BuiltPrompt | undefined;
};

/**
 * 纯拼装：不碰引擎、不碰磁盘。`createPromptBuilder` 与 benchmark 共用这一份，
 * 于是"静态段稳定"可以在没有 dispatch 的场景里直接断言。
 *
 * 顺序是契约：静态段 → 环境 → `prompt.section` → 清单。静态段在前不是排版偏好，
 * 是缓存断点只能落在前缀上的硬约束。
 */
export function assemblePrompt(input: {
  /** 省略 = 产品默认的静态分节。测试可以换一段假的来观察拼装。 */
  readonly staticSections?: readonly PromptSection[];
  readonly environment?: PromptEnvironment;
  readonly sections: readonly PromptSection[];
  /** 已经渲染好的清单文本（空串 = 没有）。 */
  readonly offer: string;
}): BuiltPrompt {
  const staticPieces: PromptPiece[] = (input.staticSections ?? STATIC_PROMPT_SECTIONS).map((section) => ({
    name: section.name,
    text: section.text,
    cache: 'static',
  }));

  const dynamicPieces: PromptPiece[] = [
    ...(input.environment === undefined
      ? []
      : [{ name: 'environment', text: renderEnvironment(input.environment), cache: 'dynamic' as const }]),
    ...input.sections.map((section) => ({
      name: section.name,
      text: section.text,
      cache: 'dynamic' as const,
    })),
    { name: 'offer', text: input.offer, cache: 'dynamic' as const },
  ];

  const staticText = join(staticPieces);
  const dynamicText = join(dynamicPieces);
  const pieces = [...staticPieces, ...dynamicPieces].filter((piece) => piece.text !== '');

  return {
    text: [staticText, dynamicText].filter((text) => text !== '').join('\n\n'),
    pieces,
    staticText,
    dynamicText,
  };
}

function join(pieces: readonly PromptPiece[]): string {
  return pieces
    .filter((piece) => piece.text !== '')
    .map((piece) => piece.text)
    .join('\n\n');
}

export function createPromptBuilder(deps: {
  readonly dispatch: DispatchFn;
  /**
   * 静态分节。省略 = `STATIC_PROMPT_SECTIONS`（产品默认）。
   * 测试传一段假文本，就能把注意力放在"多久重算一次"上。
   */
  readonly sections?: readonly PromptSection[];
  /**
   * 环境段的来源。省略 = 不注入环境（P12 及以前的形状）。
   * 用回调而不是值：调用方决定它在会话开始时算一次还是每轮重算。
   */
  readonly environment?: () => PromptEnvironment | undefined;
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
      const environment = deps.environment?.();

      last = assemblePrompt({
        staticSections: deps.sections ?? STATIC_PROMPT_SECTIONS,
        ...(environment === undefined ? {} : { environment }),
        sections: sections.sections,
        offer: renderOffer(offer),
      });
      return last;
    },
  };
}
