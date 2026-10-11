/**
 * 指令文件的层 —— **与权限设置是同一件事的两种说法**（P5 设计 §4.1）。
 *
 * | 层 | 谁写 | 权限那边的对偶 |
 * | --- | --- | --- |
 * | `project` | 这个仓库 | `<root>/.deepcode/settings.json` |
 * | `local` | 这台机器上的这个仓库 | `<root>/.deepcode/settings.local.json` |
 * | `user` | 你 | `~/.deepcode/settings.json` |
 * | `managed` | 组织 | `policy` 源（托管设置文件） |
 *
 * 嵌套（`mods/agents-md/nested.ts`，P4a 已做）**不在这张表里**：它不是一层，
 * 是 `project` 那一层按目录深度继续往外排；而且它挂在 `Read` 的结果上，不进系统提示。
 *
 * ⚠️ **数组顺序就是送进模型那段文本的顺序**：越贴近这个仓库的越靠前，
 * 托管那份压在最末 —— 它是权威，所以它最后说话。
 *
 * 为什么这个词表住在契约里：`mods/agents-md` 只许 import `src/contract/`（P5a 立的边界），
 * 而 CLI 那一侧（`cli/settings.ts`）要读同一份 `managed` 段 —— 两侧共用一个说法，
 * 免得"层"这个字在两边各叫各的。
 */
export const INSTRUCTION_LAYERS = ['project', 'local', 'user', 'managed'] as const;

export type InstructionLayer = (typeof INSTRUCTION_LAYERS)[number];

/**
 * 托管层下发的一段指令。
 *
 * `label` 是给人看的**出处**（一个文件路径，或者一句"托管设置里内嵌的那一段"）——
 * 它要跟着正文一起进提示：模型得知道每段话是从哪儿来的，
 * 与其余四层那个 `Contents of <路径>:` 是同一个道理。
 */
export type ManagedInstruction = {
  readonly label: string;
  readonly text: string;
};
