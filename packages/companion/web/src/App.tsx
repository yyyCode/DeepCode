import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  streamChat,
  type Character,
  type CharacterDraft,
  type ChatEvent,
  type Meta,
  type User,
} from './api';
import { AdminPanel } from './components/AdminPanel';
import { AuthScreen } from './components/AuthScreen';
import { Avatar, type AvatarState } from './components/Avatar';
import { Chat, type ChatMessage } from './components/Chat';
import { CharacterPanel } from './components/CharacterPanel';
import { CharacterRail } from './components/CharacterRail';
import { MarketPanel } from './components/MarketPanel';

const SELECTED_KEY = 'deepcode.companion.character';

let sequence = 0;
const newId = () => `m${++sequence}`;

const STATUS_TEXT: Record<AvatarState, string> = {
  idle: '在线',
  thinking: '在想…',
  speaking: '正在说',
};

type EditorState = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly character: Character };

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const bootSeq = useRef(0);

  async function loadMeta(): Promise<void> {
    const seq = ++bootSeq.current;
    setBooting(true);
    setBootError(null);
    try {
      const current = await api.meta();
      if (seq === bootSeq.current) setMeta(current);
    } catch (caught) {
      if (seq === bootSeq.current) {
        setBootError((caught as Error).message || '连不上陪伴服务');
      }
    } finally {
      if (seq === bootSeq.current) setBooting(false);
    }
  }

  useEffect(() => {
    void loadMeta();
    // 只跑一次：StrictMode 的二次挂载由 bootSeq 去重。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (booting) {
    return (
      <div className="app">
        <main className="stage stage--note">
          <p className="stage__note">正在打开…</p>
        </main>
      </div>
    );
  }

  if (bootError !== null) {
    return (
      <div className="app">
        <main className="stage stage--note">
          <p className="stage__note">{bootError}</p>
          <button type="button" className="btn btn--primary" onClick={() => void loadMeta()}>
            重试
          </button>
        </main>
      </div>
    );
  }

  if (meta === null) return null;

  if (meta.user === null) {
    return (
      <AuthScreen
        meta={meta}
        onAuthed={(user) => setMeta({ ...meta, user })}
      />
    );
  }

  return (
    <ChatApp
      meta={meta}
      user={meta.user}
      onUser={(user) => setMeta({ ...meta, user })}
      onLoggedOut={() => setMeta({ ...meta, user: null })}
    />
  );
}

type ChatAppProps = {
  readonly meta: Meta;
  readonly user: User;
  readonly onUser: (user: User) => void;
  readonly onLoggedOut: () => void;
};

function ChatApp({ meta, user, onUser, onLoggedOut }: ChatAppProps) {
  const [characters, setCharacters] = useState<readonly Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [status, setStatus] = useState<AvatarState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bootSeq = useRef(0);
  const loadSeq = useRef(0);

  const selected = characters.find((character) => character.id === selectedId) ?? null;
  const busy = status !== 'idle';
  // 本地版只有一个内置用户，管理接口与广场都不存在。
  const canManage = user.role === 'admin' && meta.mode === 'cloud';

  async function selectCharacter(character: Character): Promise<void> {
    const seq = ++loadSeq.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setSelectedId(character.id);
    setMessages([]);
    setError(null);
    try {
      localStorage.setItem(SELECTED_KEY, character.id);
    } catch {
      // 隐私模式里 localStorage 可能不可写 —— 这次仍能用。
    }

    try {
      const data = await api.conversation(character.id);
      if (seq !== loadSeq.current) return;
      conversationRef.current = data.conversationId;
      setMessages(
        data.messages.map((message) => ({
          id: `db-${message.id}`,
          role: message.role,
          content: message.content,
        })),
      );
    } catch (caught) {
      if (seq !== loadSeq.current) return;
      if (isUnauthorized(caught)) {
        onLoggedOut();
        return;
      }
      conversationRef.current = null;
      setError((caught as Error).message || '打不开这个人物');
    }
  }

  async function boot(): Promise<void> {
    const seq = ++bootSeq.current;
    setBooting(true);
    setBootError(null);
    try {
      const list = await api.listCharacters();
      if (seq !== bootSeq.current) return;
      setCharacters(list);

      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(SELECTED_KEY);
      } catch {
        remembered = null;
      }
      const chosen = list.find((character) => character.id === remembered) ?? list[0];
      if (chosen !== undefined) await selectCharacter(chosen);
    } catch (caught) {
      if (seq === bootSeq.current) {
        if (isUnauthorized(caught)) {
          onLoggedOut();
          return;
        }
        setBootError((caught as Error).message || '连不上陪伴服务');
      }
    } finally {
      if (seq === bootSeq.current) setBooting(false);
    }
  }

  useEffect(() => {
    void boot();
    // 只跑一次：StrictMode 的二次挂载由 bootSeq 去重。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 退出登录或切换账号时，别让还在跑的生成继续挂在这里。
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = () => {
    abortRef.current?.abort();
  };

  const send = async (text: string) => {
    const character = selected;
    const conversationId = conversationRef.current;
    if (character === null || conversationId === null || status !== 'idle') return;

    const userMessage: ChatMessage = { id: newId(), role: 'user', content: text };
    setMessages((previous) => [...previous, userMessage]);
    setError(null);
    setStatus('thinking');

    const assistantId = newId();
    let assistantAdded = false;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        { characterId: character.id, conversationId, message: text },
        (event: ChatEvent) => {
          if (event.type === 'delta') {
            if (!assistantAdded) {
              assistantAdded = true;
              setStatus('speaking');
              setMessages((previous) => [
                ...previous,
                { id: assistantId, role: 'assistant', content: event.text },
              ]);
            } else {
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: message.content + event.text }
                    : message,
                ),
              );
            }
          } else if (event.type === 'done') {
            if (user.dailyLimit !== null && typeof event.remaining === 'number') {
              onUser({ ...user, usedToday: Math.max(0, user.dailyLimit - event.remaining) });
            }
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        },
        controller.signal,
      );

      if (!assistantAdded) setError('她这次没有返回内容，再试一次？');
    } catch (caught) {
      if (isUnauthorized(caught)) {
        onLoggedOut();
        return;
      }
      if ((caught as Error).name !== 'AbortError') {
        setError((caught as Error).message || '连接中断了');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStatus('idle');
      }
    }
  };

  async function newConversation(): Promise<void> {
    const character = selected;
    if (character === null) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    try {
      const conversationId = await api.newConversation(character.id);
      conversationRef.current = conversationId;
      setMessages([]);
      setError(null);
    } catch (caught) {
      if (isUnauthorized(caught)) {
        onLoggedOut();
        return;
      }
      setError((caught as Error).message || '新建对话失败');
    }
  }

  async function saveCharacter(draft: CharacterDraft, publish: boolean): Promise<void> {
    const current = editor;
    if (current === null) return;

    if (current.mode === 'edit') {
      let updated = await api.updateCharacter(current.character.id, draft);
      if (canManage && updated.isPublic !== publish) {
        updated = await api.publishCharacter(updated.id, publish);
      }
      setCharacters((previous) =>
        previous.map((character) => (character.id === updated.id ? updated : character)),
      );
      setEditor(null);
      return;
    }

    let created = await api.createCharacter(draft);
    if (canManage && publish) {
      created = await api.publishCharacter(created.id, true);
    }
    setCharacters((previous) => [...previous, created]);
    setEditor(null);
    await selectCharacter(created);
  }

  async function deleteCurrent(): Promise<void> {
    const current = editor;
    if (current === null || current.mode !== 'edit') return;

    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    await api.deleteCharacter(current.character.id);
    const remaining = characters.filter((character) => character.id !== current.character.id);
    setCharacters(remaining);
    setEditor(null);

    if (selectedId === current.character.id) {
      const next = remaining[0];
      if (next !== undefined) {
        await selectCharacter(next);
      } else {
        setSelectedId(null);
        conversationRef.current = null;
        setMessages([]);
        try {
          localStorage.removeItem(SELECTED_KEY);
        } catch {
          // 忽略：存储不可写时没有可清理的东西。
        }
      }
    }
  }

  async function pickFromMarket(character: Character): Promise<void> {
    const owned = characters.find((entry) => entry.id === character.id);
    if (owned !== undefined) {
      await selectCharacter(owned);
      return;
    }
    const copy = await api.cloneCharacter(character.id);
    setCharacters((previous) => [...previous, copy]);
    await selectCharacter(copy);
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      onLoggedOut();
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          <span>DeepCode Companion</span>
        </div>
        <div className="topbar__right">
          <span className={`status status--${status}`}>
            {selected === null ? STATUS_TEXT[status] : `${selected.name} · ${STATUS_TEXT[status]}`}
          </span>
          <span className="quota" title="今天已用 / 今日消息额度">
            {user.dailyLimit === null ? '不限量' : `${user.usedToday} / ${user.dailyLimit} 条`}
          </span>
          {meta.mode === 'cloud' && (
            <button type="button" className="ghost-btn" onClick={() => setMarketOpen(true)}>
              广场
            </button>
          )}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void newConversation()}
            disabled={selected === null || busy}
          >
            新对话
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => selected !== null && setEditor({ mode: 'edit', character: selected })}
            disabled={selected === null}
          >
            人物
          </button>
          {canManage && (
            <button type="button" className="ghost-btn" onClick={() => setAdminOpen(true)}>
              管理
            </button>
          )}
          {meta.mode === 'cloud' ? (
            <button
              type="button"
              className="ghost-btn topbar__user"
              title={`${user.email} · 退出登录`}
              onClick={() => void logout()}
            >
              {user.displayName}
            </button>
          ) : (
            <span className="topbar__user">本地</span>
          )}
        </div>
      </header>

      {booting ? (
        <main className="stage stage--note">
          <p className="stage__note">正在打开…</p>
        </main>
      ) : bootError !== null ? (
        <main className="stage stage--note">
          <p className="stage__note">{bootError}</p>
          <button type="button" className="btn btn--primary" onClick={() => void boot()}>
            重试
          </button>
        </main>
      ) : characters.length === 0 ? (
        <main className="stage stage--note">
          <p className="stage__note">还没有人物。先创建一个，或者去广场复制一个。</p>
          <div className="stage__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setEditor({ mode: 'create' })}
            >
              新建人物
            </button>
            {meta.mode === 'cloud' && (
              <button type="button" className="btn btn--ghost" onClick={() => setMarketOpen(true)}>
                去广场看看
              </button>
            )}
          </div>
        </main>
      ) : (
        <main className="stage">
          <CharacterRail
            characters={characters}
            selectedId={selectedId}
            disabled={busy}
            onSelect={(character) => void selectCharacter(character)}
            onCreate={() => setEditor({ mode: 'create' })}
          />
          <section className="stage__main">
            {selected !== null && (
              <>
                <div className="hero">
                  <Avatar state={status} avatar={selected.avatar} />
                  <h1 className="hero__name">{selected.name}</h1>
                </div>
                <Chat
                  characterId={selected.id}
                  asrEnabled={meta.features.asr}
                  asrWav={meta.features.asrWav}
                  greeting={selected.greeting}
                  messages={messages}
                  status={status}
                  error={error}
                  onSend={(text) => {
                    void send(text);
                  }}
                  onStop={stop}
                />
              </>
            )}
          </section>
        </main>
      )}

      <CharacterPanel
        open={editor !== null}
        character={editor?.mode === 'edit' ? editor.character : null}
        publishAllowed={canManage}
        onClose={() => setEditor(null)}
        onSave={saveCharacter}
        onDelete={editor?.mode === 'edit' ? deleteCurrent : null}
      />

      <MarketPanel
        open={marketOpen}
        userId={user.id}
        disabled={busy}
        onClose={() => setMarketOpen(false)}
        onPick={pickFromMarket}
      />

      {canManage && (
        <AdminPanel open={adminOpen} me={user} onClose={() => setAdminOpen(false)} />
      )}
    </div>
  );
}
