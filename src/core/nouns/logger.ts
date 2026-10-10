import type { LoggerNoun } from '../../contract/engine';

/** debug 只在 DEEPCODE_DEBUG 设了时才输出，且只走 stderr（不污染 stdout 的模型输出）。 */
export function createLoggerNoun(env: NodeJS.ProcessEnv): LoggerNoun {
  const debugOn = Boolean(env.DEEPCODE_DEBUG);
  return {
    debug: (line) => {
      if (debugOn) process.stderr.write(`[debug] ${line}\n`);
    },
    warn: (line) => process.stderr.write(`[warn] ${line}\n`),
  };
}
