// src/cli/skills.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillSpec } from '../contract/agent';
import { parseFrontmatter, readScalar, type Frontmatter } from '../contract/frontmatter';
import { rosterRoots, subdirectories, type RosterRoot } from './walkdir';

/**
 * 认得的 frontmatter 字段。`version` 与 `license` **收下但不用** ——
 * 参考笔记里说技能 frontmatter 只有 name / description / version / license 这四个，
 * 对它们报"不认识"是纯噪音。
 */
export const KNOWN_SKILL_FIELDS: readonly string[] = ['name', 'description', 'version', 'license'];

/** description 的上限。500 是参考实现给的规范值，不是我们拍的数（设计 §10.1）。 */
const DESCRIPTION_LIMIT = 500;

export type SkillRosterDeps = {
  readonly root: string;
  readonly home: string;
  readonly plugins?: readonly { readonly name: string; readonly dir: string }[];
  readonly warn?: (line: string) => void;
};

/**
 * 技能的目录形态是 `<skillsDir>/<name>/SKILL.md`（不是散落的 `.md`）——
 * 因为它自带一个目录：`references/`、`examples/`、`scripts/` 那些**第三层**的东西
 * 就放在技能自己的目录里，靠模型用 `Read` / `Bash` 自己取（设计 §10.1）。
 *
 * 所以 `SkillSpec.dir` 是承重的：`Skill` 工具的结果里要把这个路径交给模型。
 */
export async function discoverSkills(deps: SkillRosterDeps): Promise<readonly SkillSpec[]> {
  const warn = deps.warn ?? ((): void => {});
  const claimed = new Map<string, string>();
  const skills: SkillSpec[] = [];

  const roots = rosterRoots({
    root: deps.root,
    home: deps.home,
    plugins: deps.plugins ?? [],
    sub: 'skills',
  });

  for (const root of roots) {
    for (const dirName of await subdirectories(root.dir, '技能目录', warn)) {
      const dir = join(root.dir, dirName);
      const spec = await readSkill(join(dir, 'SKILL.md'), dir, dirName, root, warn);
      if (spec === undefined) continue;

      const owner = claimed.get(spec.name);
      if (owner !== undefined) {
        warn(`${dir}：技能 ${spec.name} 已由${owner}提供，这一份没用上。`);
        continue;
      }
      claimed.set(spec.name, describeOrigin(root));
      skills.push(spec);
    }
  }

  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function describeOrigin(root: RosterRoot): string {
  if (root.origin === 'plugin') return `插件 ${root.namespace}`;
  return root.origin === 'project' ? '项目级目录' : '用户级目录';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSkill(
  path: string,
  dir: string,
  dirName: string,
  root: RosterRoot,
  warn: (line: string) => void,
): Promise<SkillSpec | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // 目录在、SKILL.md 不在（`ENOENT`）是最常见的一种：直接说清要什么文件名，
    // 别只说"读不了"——用户看到的是这个技能为什么没出现。
    warn(`${dir}：没有可读的 SKILL.md（${describeError(error)}）—— 这个技能不装。`);
    return undefined;
  }

  let fm: Frontmatter;
  try {
    fm = parseFrontmatter(text);
  } catch (error) {
    warn(`${path}：frontmatter 坏掉（${describeError(error)}）—— 这个技能不装。`);
    return undefined;
  }

  for (const key of fm.fields.keys()) {
    if (!KNOWN_SKILL_FIELDS.includes(key)) warn(`${path}：不认识的字段 ${key}，忽略。`);
  }

  const declared = readScalar(fm, 'name');
  if (declared === undefined) warn(`${path}：没写 name，用目录名兜底。`);
  const local = declared ?? dirName;
  const name = root.namespace === undefined ? local : `${root.namespace}:${local}`;

  const description = readScalar(fm, 'description');
  if (description === undefined || description.trim() === '') {
    warn(`${path}：没有 description —— 模型全靠它决定要不要加载，这个技能不装。`);
    return undefined;
  }

  const body = fm.body.trim();
  if (body === '') {
    // 装还是要装的（正文可能是空的但即将由 skill.prompt 的应答者填上），
    // 但这事得让人看见：不吭声的话，加载它得到一屏空白。
    warn(`${path}：正文是空的 —— 加载它只会得到一段空文本。`);
  }

  // 截断是**装载时**做的（设计 §10.1）：这段文字每次会话都进 system prompt，
  // 而清单里的每一行都是真金白银的 token。截了要出声。
  const trimmed =
    description.length > DESCRIPTION_LIMIT
      ? (() => {
          warn(
            `${path}：description 有 ${description.length} 字符，超过 ${DESCRIPTION_LIMIT}，已截断。`,
          );
          return description.slice(0, DESCRIPTION_LIMIT);
        })()
      : description;

  return {
    name,
    description: trimmed,
    body,
    /** 技能自己的目录：第三层（`references/` 等）靠它 + 模型自己的 `Read`。 */
    dir,
  };
}
