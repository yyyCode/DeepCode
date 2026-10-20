import { useEffect, useRef, useState } from 'react';
import { api, type Character } from '../api';

type Props = {
  readonly open: boolean;
  readonly userId: string;
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onPick: (character: Character) => Promise<void>;
};

export function MarketPanel({ open, userId, disabled, onClose, onPick }: Props) {
  const [characters, setCharacters] = useState<readonly Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    setPicking(null);
    void api
      .listPublicCharacters()
      .then((list) => {
        if (seq.current === current) setCharacters(list);
      })
      .catch((caught: unknown) => {
        if (seq.current === current) setError((caught as Error).message || '广场打不开');
      })
      .finally(() => {
        if (seq.current === current) setLoading(false);
      });
  }, [open]);

  if (!open) return null;

  const pick = async (character: Character) => {
    if (picking !== null) return;
    setPicking(character.id);
    setError(null);
    try {
      await onPick(character);
      onClose();
    } catch (caught) {
      setError((caught as Error).message || '复制失败');
      setPicking(null);
    }
  };

  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label="角色广场">
      <button type="button" className="panel__backdrop" aria-label="关闭" onClick={onClose} />
      <aside className="panel__sheet panel__sheet--wide">
        <header className="panel__head">
          <div>
            <h2>角色广场</h2>
            <p>别人公开的角色可以一键复制到自己的列表，复制后随便改。</p>
          </div>
          <button type="button" className="panel__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {loading ? (
          <p className="panel__empty">正在加载…</p>
        ) : characters.length === 0 ? (
          <p className="panel__empty">广场还是空的。等管理员公开几个角色再来。</p>
        ) : (
          <div className="market">
            {characters.map((character) => {
              const mine = character.ownerId === userId;
              return (
                <article key={character.id} className="market__card">
                  <span className={`market__face avatar--${character.avatar}`} aria-hidden="true">
                    {character.name.slice(0, 1)}
                  </span>
                  <h3>{character.name}</h3>
                  <p>{character.personality.trim() === '' ? '还没有写性格。' : character.personality}</p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void pick(character)}
                    disabled={disabled || picking !== null}
                  >
                    {picking === character.id ? '复制中…' : mine ? '打开' : '复制并使用'}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {error !== null && (
          <div className="chat__error" role="alert">
            {error}
          </div>
        )}
      </aside>
    </div>
  );
}
