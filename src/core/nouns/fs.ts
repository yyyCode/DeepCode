import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import type { FsNoun } from '../../contract/engine';

export function createFsNoun(): FsNoun {
  return {
    read: (path) => readFile(path, 'utf8'),
    write: (path, content) => writeFile(path, content, 'utf8').then(() => undefined),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    list: (dir) => readdir(dir),
    stat: async (path) => {
      const s = await stat(path);
      return { size: s.size, isDirectory: s.isDirectory() };
    },
  };
}
