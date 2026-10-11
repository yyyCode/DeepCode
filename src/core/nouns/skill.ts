// src/core/nouns/skill.ts
import { CORE_ORIGIN } from '../../contract/next';
import type { EngineInterface } from '../../contract/engine';
import type { DispatchFn } from '../dispatch';

/**
 * 把技能正文过一遍 `skill.prompt`。
 *
 * ⚠️ 这是**变换缝**，不是闸：链尾无人应答时返回的是**原文**（coreImpls 里那条），
 * 不是拒绝。在缝上 deny 会让一个没被任何插件碰过的技能彻底不可用。
 * 详细理由见 `contract/events.ts` 里 `'skill.prompt'` 的注释与设计 §10.3。
 */
export function createSkillNoun(deps: {
  dispatch: () => DispatchFn;
}): EngineInterface['skill'] {
  return {
    async load(req) {
      const result = await deps.dispatch()(
        'skill.prompt',
        { name: req.name, text: req.text },
        CORE_ORIGIN,
      );
      return { text: result.text };
    },
  };
}
