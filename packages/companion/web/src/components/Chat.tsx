import { useEffect, useRef, useState } from 'react';
import type { AvatarState } from './Avatar';
import { recorderSupported, useRecorder } from '../useRecorder';

export type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

type Props = {
  readonly characterId: string;
  readonly asrEnabled: boolean;
  readonly asrWav: boolean;
  readonly greeting: string;
  readonly messages: readonly ChatMessage[];
  readonly status: AvatarState;
  readonly error: string | null;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
};

export function Chat({
  characterId,
  asrEnabled,
  asrWav,
  greeting,
  messages,
  status,
  error,
  onSend,
  onStop,
}: Props) {
  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = status !== 'idle';
  const micVisible = asrEnabled && recorderSupported();

  const recorder = useRecorder({
    enabled: micVisible,
    wav: asrWav,
    resetKey: characterId,
    onText: (text) => {
      setInput((previous) => (previous.trim() === '' ? text : `${previous.trimEnd()}\n${text}`));
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  });
  const voiceBusy = recorder.state !== 'idle';

  // 新消息或状态变化时贴到底部。用 'auto' 而不是 'smooth'：流式追加时平滑滚动会追不上。
  useEffect(() => {
    const log = logRef.current;
    if (log === null) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, status]);

  // 输入框随内容长高，到 160px 封顶。
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const submit = () => {
    const text = input.trim();
    if (text === '' || busy || voiceBusy) return;
    onSend(text);
    setInput('');
  };

  const last = messages[messages.length - 1];
  const streaming = status === 'speaking' && last?.role === 'assistant';

  return (
    <section className="chat">
      <div className="chat__log" ref={logRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="chat__empty">
            <p className="bubble bubble--assistant">
              {greeting.trim() === '' ? '嗨，我在这儿。想聊点什么都可以。' : greeting}
            </p>
            <p className="chat__hint">想改名字或性格？点右上角的「人物」。</p>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`chat__row chat__row--${message.role}`}>
            <div className={`bubble bubble--${message.role}`}>
              {message.content}
              {streaming && message.id === last?.id && <span className="caret" />}
            </div>
          </div>
        ))}

        {status === 'thinking' && (
          <div className="chat__row chat__row--assistant">
            <div className="bubble bubble--assistant bubble--pending">想一想…</div>
          </div>
        )}
      </div>

      {(error !== null || recorder.error !== null) && (
        <div className="chat__error" role="alert">
          {error ?? recorder.error}
        </div>
      )}

      {recorder.state !== 'idle' && (
        <div className="composer__voice" role="status">
          {recorder.state === 'requesting' && '正在请求麦克风…'}
          {recorder.state === 'recording' &&
            `正在听… ${formatDuration(recorder.seconds)}（再点一次结束）`}
          {recorder.state === 'transcribing' && '正在识别…'}
        </div>
      )}

      <div className="composer">
        {micVisible && (
          <button
            type="button"
            className={`composer__mic${
              recorder.state === 'recording' ? ' composer__mic--recording' : ''
            }`}
            onClick={recorder.toggle}
            disabled={busy || recorder.state === 'requesting' || recorder.state === 'transcribing'}
            aria-label={recorder.state === 'recording' ? '停止录音' : '语音输入'}
            aria-pressed={recorder.state === 'recording'}
            title={recorder.state === 'recording' ? '停止录音' : '语音输入'}
          >
            {recorder.state === 'recording' ? (
              <span className="composer__mic-stop" aria-hidden="true" />
            ) : (
              <MicIcon />
            )}
          </button>
        )}
        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={input}
          placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          aria-label="输入消息"
        />
        {busy ? (
          <button type="button" className="composer__stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="composer__send"
            onClick={submit}
            disabled={input.trim() === '' || voiceBusy}
          >
            发送
          </button>
        )}
      </div>
    </section>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
