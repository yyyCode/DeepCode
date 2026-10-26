// src/cli/offer.ts
import type { Result } from '../contract/events';

/**
 * 把 `agent.offer` 的答复渲染成 system prompt 里的那一节（设计 §7）。
 *
 * **模型看到的是一行 `description`，不是文件** —— 与参考实现一致。`tools` 一并印出来是
 * **我们多加的**：既然白名单是承重的东西，让用户与模型都看得见比藏起来好。
 * 印的是**文件里写的那份**（省略 = 继承全部，那时什么都不印）。
 *
 * 两节都空时返回 `''` —— 拼接方靠这个把整节省掉，别给空白加标题。
 */
export function renderOffer(offer: Result<'agent.offer'>): string {
  const sections: string[] = [];

  if (offer.agents.length > 0) {
    sections.push(
      [
        '可用子代理（用 Task 派发；只读的也可以用 Explore 并发派，subagent_type 填名字）：',
        ...offer.agents.map((agent) => {
          const marks: string[] = [];
          if (agent.readOnly === true) marks.push('只读');
          if (agent.tools !== undefined) marks.push(`tools: ${agent.tools.join(', ')}`);
          return marks.length === 0
            ? `- ${agent.name}: ${agent.description}`
            : `- ${agent.name}: ${agent.description}（${marks.join('；')}）`;
        }),
        '',
        '派发口径：独立、只读的探索优先用 Explore 并发派（同一条回复里可以发多个）；' +
          '要写盘或有先后依赖的用 Task，串行。几条工具调用就能做完的小任务不要派；' +
          '不要让两个子代理改同一个文件。',
      ].join('\n'),
    );
  }

  if (offer.skills.length > 0) {
    sections.push(
      [
        '可用技能（用 Skill 工具按名加载）：',
        ...offer.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
