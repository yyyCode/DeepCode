import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { toWav } from './wav';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'transcribing';

const MAX_RECORD_MS = 60_000;
const TIMESLICE_MS = 250;

/** 优先 opus/webm；Safari 只给 mp4，放到后面。 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/**
 * 这个浏览器能不能录音。
 *
 * `isSecureContext` 是硬条件：非 HTTPS 的局域网地址上 getUserMedia 直接不可用，
 * 按钮就不该出现（localhost 例外，浏览器把它当安全上下文）。
 */
export function recorderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    window.isSecureContext !== false
  );
}

type Options = {
  readonly enabled: boolean;
  /** 本地识别只收 WAV；服务端通过 /api/meta 告诉前端要不要转。 */
  readonly wav: boolean;
  /** 切换人物时传新值，用来停掉还在录的那一段。 */
  readonly resetKey: string;
  readonly onText: (text: string) => void;
};

export type Recorder = {
  readonly state: RecorderState;
  readonly seconds: number;
  readonly error: string | null;
  toggle(): void;
};

export function useRecorder({ enabled, wav, resetKey, onText }: Options): Recorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 回调每次渲染都可能是新函数；放进 ref，别让它成为 start/stop 的依赖。
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const discardRef = useRef(false);
  /** 卸载或切换人物之后，异步回来的结果一律丢掉。 */
  const activeRef = useRef(true);
  /** 比 active 更细：切人物后 active 会立刻变回 true，但旧请求的世代必须作废。 */
  const generationRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    generationRef.current += 1;
    discardRef.current = true;
    clearTimer();
    uploadRef.current?.abort();
    uploadRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder !== null && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // 已经停了；退出路径不该被它绊住。
      }
    }
    releaseStream();
    chunksRef.current = [];
  }, [clearTimer, releaseStream]);

  // 卸载或换人物：停止录音、释放麦克风、中止上传。
  useEffect(() => {
    activeRef.current = true;
    return teardown;
  }, [resetKey, teardown]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === null || recorder.state !== 'recording') return;
    discardRef.current = false;
    recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!enabled || state !== 'idle') return;

    setError(null);
    setSeconds(0);
    setState('requesting');
    activeRef.current = true;
    discardRef.current = false;
    const generation = generationRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      if (!activeRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const supported = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder =
        supported === undefined
          ? new MediaRecorder(stream)
          : new MediaRecorder(stream, { mimeType: supported, audioBitsPerSecond: 48_000 });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setError('录音出错了，再试一次');
        discardRef.current = true;
        clearTimer();
        releaseStream();
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // 已经停了。
          }
        }
        if (activeRef.current) {
          setState('idle');
          setSeconds(0);
        }
      };

      recorder.onstop = () => {
        void (async () => {
          const chunks = chunksRef.current;
          const type = recorder.mimeType || supported || 'audio/webm';
          chunksRef.current = [];
          clearTimer();
          releaseStream();
          if (recorderRef.current === recorder) recorderRef.current = null;

          if (!activeRef.current) return;
          if (discardRef.current) {
            setState('idle');
            setSeconds(0);
            return;
          }

          let blob = new Blob(chunks, { type });
          if (blob.size === 0) {
            setError('没有录到声音，再试一次');
            setState('idle');
            setSeconds(0);
            return;
          }

          setState('transcribing');
          if (wav) {
            try {
              blob = await toWav(blob);
            } catch {
              if (activeRef.current && generation === generationRef.current) {
                setError('录音格式转换失败，再试一次');
                setState('idle');
                setSeconds(0);
              }
              return;
            }
            if (!activeRef.current || generation !== generationRef.current) return;
          }

          const controller = new AbortController();
          uploadRef.current = controller;

          api
            .transcribe(blob, controller.signal)
            .then((text) => {
              if (!activeRef.current || generation !== generationRef.current) return;
              const trimmed = text.trim();
              if (trimmed === '') {
                setError('没听清，再说一次');
                return;
              }
              onTextRef.current(trimmed);
            })
            .catch((caught: unknown) => {
              if (!activeRef.current || generation !== generationRef.current) return;
              if ((caught as Error).name === 'AbortError') return;
              setError((caught as Error).message || '语音识别失败，请重试');
            })
            .finally(() => {
              if (uploadRef.current === controller) uploadRef.current = null;
              if (activeRef.current && generation === generationRef.current) {
                setState('idle');
                setSeconds(0);
              }
            });
        })();
      };

      recorder.start(TIMESLICE_MS);
      setState('recording');

      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setSeconds(Math.floor(elapsed / 1000));
        if (elapsed >= MAX_RECORD_MS && recorder.state === 'recording') {
          discardRef.current = false;
          recorder.stop();
        }
      }, TIMESLICE_MS);
    } catch (caught) {
      releaseStream();
      if (!activeRef.current || generation !== generationRef.current) return;
      setState('idle');
      setSeconds(0);
      setError(describeMicError(caught));
    }
  }, [clearTimer, enabled, releaseStream, state, wav]);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      stop();
      return;
    }
    if (state === 'idle') void start();
  }, [start, state, stop]);

  return { state, seconds, error, toggle };
}

function describeMicError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return '需要麦克风权限，请在浏览器地址栏允许后重试';
    }
    if (error.name === 'NotFoundError') return '没有找到可用的麦克风';
    if (error.name === 'NotReadableError') return '麦克风正被其他程序占用';
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return '打不开麦克风，请检查权限和系统设置';
}
