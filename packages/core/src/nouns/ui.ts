import type { AskOptions, UiNoun } from '@deepcode/contract/engine';

export type UiSink = {
  print(line: string): void;
  notice(line: string): void;
  ask(question: string, options?: AskOptions): Promise<string>;
};

export function createUiNoun(sink: UiSink): UiNoun {
  return {
    log: (line) => sink.print(line),
    notice: (line) => sink.notice(line),
    ask: (question, options) => sink.ask(question, options),
  };
}
