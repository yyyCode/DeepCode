import type { UiNoun } from '../../contract/engine';

export type UiSink = {
  print(line: string): void;
  notice(line: string): void;
  ask(question: string): Promise<string>;
};

export function createUiNoun(sink: UiSink): UiNoun {
  return {
    log: (line) => sink.print(line),
    notice: (line) => sink.notice(line),
    ask: (question) => sink.ask(question),
  };
}
