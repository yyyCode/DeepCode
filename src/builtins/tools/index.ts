import type { Plugin } from '../../contract/plugin';
import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { writeTool } from './write';

/** MVP 的六个核心工具。这里是硬编码清单 —— P3 的目录扫描会取代它。 */
export const coreTools: readonly Plugin[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];
