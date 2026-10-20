import { useEffect, useRef, useState } from 'react';
import { AVATARS, type AvatarKey, type Character, type CharacterDraft } from '../api';

const MAX_NAME = 24;
const MAX_PERSONALITY = 4_000;
const MAX_GREETING = 500;

const PRESETS = [
  {
    label: '温柔陪伴',
    text: '温柔、耐心、愿意倾听。说话轻一点，先接住对方的情绪，再给建议；不急着讲道理。',
  },
  {
    label: '毒舌可靠',
    text: '嘴有点毒，但心里站在对方这边。会用调侃拆穿自我欺骗，说完一定给一个能落地的建议。',
  },
  {
    label: '元气少女',
    text: '元气、话多、好奇心重。喜欢用短句和语气词，会主动追问细节，把普通话题聊得很有趣。',
  },
] as const;

const AVATAR_LABEL: Record<AvatarKey, string> = {
  'girl-1': '桃粉',
  'girl-2': '雾紫',
  'girl-3': '暖橙',
};

const EMPTY: CharacterDraft = {
  name: '',
  personality: '',
  greeting: '',
  avatar: 'girl-1',
};

type Props = {
  readonly open: boolean;
  readonly character: Character | null;
  readonly publishAllowed: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: CharacterDraft, publish: boolean) => Promise<void>;
  readonly onDelete: (() => Promise<void>) | null;
};

export function CharacterPanel({
  open,
  character,
  publishAllowed,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<CharacterDraft>(EMPTY);
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(
      character === null
        ? EMPTY
        : {
            name: character.name,
            personality: character.personality,
            greeting: character.greeting,
            avatar: character.avatar,
          },
    );
    setPublish(character?.isPublic ?? false);
    setSaving(false);
    setConfirmDelete(false);
    setError(null);
    if (character === null) nameRef.current?.focus();
    else textareaRef.current?.focus();
  }, [open, character]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    if (saving) return;
    const name = draft.name.replace(/\s+/g, ' ').trim();
    if (name === '') {
      setError('先给她起个名字。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name }, publishAllowed && publish);
    } catch (caught) {
      setError((caught as Error).message || '保存失败');
      setSaving(false);
    }
  };

  const remove = async () => {
    if (onDelete === null || saving) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (caught) {
      setError((caught as Error).message || '删除失败');
      setSaving(false);
    }
  };

  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label="人物设定">
      <button type="button" className="panel__backdrop" aria-label="关闭" onClick={onClose} />
      <aside className="panel__sheet">
        <header className="panel__head">
          <div>
            <h2>{character === null ? '新建人物' : '编辑人物'}</h2>
            <p>名字和性格都会交给模型，每轮对话都生效。</p>
          </div>
          <button type="button" className="panel__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <label className="field">
          <span className="field__label">名字</span>
          <input
            ref={nameRef}
            className="field__input"
            value={draft.name}
            maxLength={MAX_NAME}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="例如：小柔"
          />
        </label>

        <div className="field">
          <span className="field__label">形象</span>
          <div className="swatches">
            {AVATARS.map((avatar) => (
              <button
                key={avatar}
                type="button"
                className={`swatch avatar--${avatar}${
                  draft.avatar === avatar ? ' swatch--active' : ''
                }`}
                onClick={() => setDraft({ ...draft, avatar })}
                aria-pressed={draft.avatar === avatar}
              >
                <span className="swatch__dot" />
                {AVATAR_LABEL[avatar]}
              </button>
            ))}
          </div>
        </div>

        <div className="panel__presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="chip"
              onClick={() => setDraft({ ...draft, personality: preset.text })}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <textarea
          ref={textareaRef}
          className="panel__text"
          value={draft.personality}
          maxLength={MAX_PERSONALITY}
          onChange={(event) => setDraft({ ...draft, personality: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          placeholder="例如：温柔、话少、偶尔毒舌；喜欢用短句，会记得我上次说的事。"
        />

        <div className="panel__meta">
          <span>
            {draft.personality.length} / {MAX_PERSONALITY}
          </span>
          <button
            type="button"
            className="link"
            onClick={() => setDraft({ ...draft, personality: '' })}
          >
            清空，用默认性格
          </button>
        </div>

        <label className="field field--greeting">
          <span className="field__label">开场白</span>
          <textarea
            className="field__input field__input--area"
            value={draft.greeting}
            maxLength={MAX_GREETING}
            rows={2}
            onChange={(event) => setDraft({ ...draft, greeting: event.target.value })}
            placeholder="留空就用默认问候。"
          />
        </label>

        {publishAllowed && (
          <label className="check">
            <input
              type="checkbox"
              checked={publish}
              onChange={(event) => setPublish(event.target.checked)}
            />
            <span>
              <strong>公开到角色广场</strong>
              <span className="check__hint">别人可以复制一份，改他们自己的副本，不影响你的角色。</span>
            </span>
          </label>
        )}

        {error !== null && (
          <div className="chat__error" role="alert">
            {error}
          </div>
        )}

        <footer className="panel__actions">
          {onDelete !== null && (
            <button
              type="button"
              className={`btn btn--danger${confirmDelete ? ' btn--danger-active' : ''}`}
              onClick={() => void remove()}
              disabled={saving}
            >
              {confirmDelete ? '再点一次确认删除' : '删除'}
            </button>
          )}
          <span className="panel__spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
