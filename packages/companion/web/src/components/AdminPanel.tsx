import { useEffect, useRef, useState } from 'react';
import {
  api,
  type AdminUser,
  type Invite,
  type PlatformSettings,
  type RegistrationMode,
  type User,
} from '../api';

type Props = {
  readonly open: boolean;
  readonly me: User;
  readonly onClose: () => void;
};

type Tab = 'users' | 'invites' | 'settings';

const REGISTRATION_LABEL: Record<RegistrationMode, string> = {
  open: '公开注册',
  invite: '邀请码注册',
  closed: '关闭注册',
};

export function AdminPanel({ open, me, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('users');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [query, setQuery] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);

  const [invites, setInvites] = useState<readonly Invite[]>([]);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [registration, setRegistration] = useState<RegistrationMode>('open');
  const [dailyLimit, setDailyLimit] = useState('200');
  const [savingSettings, setSavingSettings] = useState(false);

  const usersSeq = useRef(0);
  const usersQuery = useRef('');

  async function loadUsers(search: string): Promise<void> {
    const current = ++usersSeq.current;
    setLoadingUsers(true);
    try {
      const list = await api.adminUsers(search);
      if (usersSeq.current === current) setUsers(list);
    } catch (caught) {
      if (usersSeq.current === current) setError((caught as Error).message || '用户列表加载失败');
    } finally {
      if (usersSeq.current === current) setLoadingUsers(false);
    }
  }

  async function loadInvites(): Promise<void> {
    try {
      setInvites(await api.adminInvites());
    } catch (caught) {
      setError((caught as Error).message || '邀请码加载失败');
    }
  }

  async function loadSettings(): Promise<void> {
    try {
      const current = await api.adminSettings();
      setSettings(current);
      setRegistration(current.registration);
      setDailyLimit(String(current.dailyLimit));
    } catch (caught) {
      setError((caught as Error).message || '设置加载失败');
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setQuery('');
    usersQuery.current = '';
    void loadUsers('');
    void loadInvites();
    void loadSettings();
    // 只在打开时拉一次；后续刷新由各操作自己触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const patchUser = async (
    user: AdminUser,
    patch: { disabled?: boolean; dailyMessageLimit?: number | null },
  ): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await api.adminPatchUser(user.id, patch);
      await loadUsers(usersQuery.current);
      setNotice('已保存');
    } catch (caught) {
      setError((caught as Error).message || '修改失败');
    }
  };

  const createInvite = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const invite = await api.adminCreateInvite(note.trim());
      setInvites((previous) => [invite, ...previous]);
      setNote('');
      setNotice('邀请码已生成');
    } catch (caught) {
      setError((caught as Error).message || '生成失败');
    } finally {
      setCreating(false);
    }
  };

  const disableInvite = async (invite: Invite) => {
    setError(null);
    setNotice(null);
    try {
      await api.adminDisableInvite(invite.code);
      setInvites((previous) =>
        previous.map((entry) => (entry.code === invite.code ? { ...entry, disabled: true } : entry)),
      );
      setNotice('邀请码已停用');
    } catch (caught) {
      setError((caught as Error).message || '停用失败');
    }
  };

  const saveSettings = async () => {
    if (savingSettings) return;
    const limit = Number.parseInt(dailyLimit, 10);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100_000) {
      setError('每日额度要是 0 到 100000 的整数');
      return;
    }
    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.adminPatchSettings({ registration, dailyLimit: limit });
      setSettings(updated);
      setNotice('设置已保存，对新请求立即生效');
    } catch (caught) {
      setError((caught as Error).message || '保存失败');
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label="管理后台">
      <button type="button" className="panel__backdrop" aria-label="关闭" onClick={onClose} />
      <aside className="panel__sheet panel__sheet--wide">
        <header className="panel__head">
          <div>
            <h2>管理后台</h2>
            <p>用户、邀请码和默认额度。停用用户会立刻踢掉他的登录态。</p>
          </div>
          <button type="button" className="panel__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="admin__tabs" role="tablist" aria-label="管理分类">
          {(['users', 'invites', 'settings'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`auth__tab${tab === key ? ' auth__tab--active' : ''}`}
              onClick={() => {
                setTab(key);
                setError(null);
                setNotice(null);
              }}
            >
              {key === 'users' ? '用户' : key === 'invites' ? '邀请码' : '设置'}
            </button>
          ))}
        </div>

        {error !== null && (
          <div className="chat__error" role="alert">
            {error}
          </div>
        )}
        {notice !== null && (
          <p className="admin__notice" role="status">
            {notice}
          </p>
        )}

        {tab === 'users' && (
          <section className="admin__section">
            <div className="admin__toolbar">
              <input
                className="field__input"
                value={query}
                placeholder="按邮箱或昵称搜索"
                onChange={(event) => {
                  setQuery(event.target.value);
                  usersQuery.current = event.target.value;
                  void loadUsers(event.target.value);
                }}
              />
              {loadingUsers && <span className="admin__muted">加载中…</span>}
            </div>

            {users.length === 0 && !loadingUsers ? (
              <p className="panel__empty">没有匹配的用户。</p>
            ) : (
              <div className="admin__list">
                {users.map((user) => (
                  <article key={user.id} className="admin__row">
                    <div className="admin__who">
                      <strong>
                        {user.displayName}
                        {user.role === 'admin' && <span className="admin__badge">管理员</span>}
                        {user.id === me.id && <span className="admin__badge">我</span>}
                      </strong>
                      <span className="admin__muted">{user.email}</span>
                      <span className="admin__muted">
                        今日 {user.usage.messages} 条 · token {user.usage.tokensIn}/{user.usage.tokensOut}
                      </span>
                    </div>
                    <LimitEditor
                      value={user.dailyMessageLimit}
                      onSave={(limit) => patchUser(user, { dailyMessageLimit: limit })}
                    />
                    <button
                      type="button"
                      className={`btn ${user.disabled ? 'btn--ghost' : 'btn--danger'}`}
                      disabled={user.id === me.id}
                      onClick={() => void patchUser(user, { disabled: !user.disabled })}
                    >
                      {user.disabled ? '启用' : '停用'}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'invites' && (
          <section className="admin__section">
            <div className="admin__toolbar">
              <input
                className="field__input"
                value={note}
                maxLength={200}
                placeholder="备注（给谁、为什么）"
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void createInvite()}
                disabled={creating}
              >
                {creating ? '生成中…' : '生成邀请码'}
              </button>
            </div>

            <p className="admin__muted">
              当前注册方式：{REGISTRATION_LABEL[settings?.registration ?? 'open']}。邀请码一次性，注册成功即作废。
            </p>

            {invites.length === 0 ? (
              <p className="panel__empty">还没有邀请码。</p>
            ) : (
              <div className="admin__list">
                {invites.map((invite) => {
                  const status = invite.disabled ? '已停用' : invite.usedBy !== null ? '已使用' : '可用';
                  return (
                    <article key={invite.code} className="admin__row">
                      <div className="admin__who">
                        <code className="admin__code">{invite.code}</code>
                        <span className="admin__muted">{invite.note.trim() === '' ? '（无备注）' : invite.note}</span>
                        <span className="admin__muted">
                          {status} · {invite.createdAt.slice(0, 10)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          if (navigator.clipboard === undefined) {
                            setError('这个浏览器不允许复制，手动选一下邀请码');
                            return;
                          }
                          void navigator.clipboard.writeText(invite.code).then(
                            () => setNotice('已复制'),
                            () => setError('复制失败，手动选一下'),
                          );
                        }}
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={invite.disabled || invite.usedBy !== null}
                        onClick={() => void disableInvite(invite)}
                      >
                        停用
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <section className="admin__section">
            <label className="field">
              <span className="field__label">注册方式</span>
              <select
                className="field__input"
                value={registration}
                onChange={(event) => setRegistration(event.target.value as RegistrationMode)}
              >
                <option value="open">公开注册</option>
                <option value="invite">邀请码注册</option>
                <option value="closed">关闭注册</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">每人每日消息额度</span>
              <input
                className="field__input"
                type="number"
                min={0}
                max={100000}
                value={dailyLimit}
                onChange={(event) => setDailyLimit(event.target.value)}
              />
            </label>
            <p className="admin__muted">
              单独给某个用户设过额度的话，以用户那栏为准；这里只影响没单独设置的人。
            </p>

            <div className="admin__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void saveSettings()}
                disabled={savingSettings}
              >
                {savingSettings ? '保存中…' : '保存设置'}
              </button>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

function LimitEditor({
  value,
  onSave,
}: {
  readonly value: number | null;
  readonly onSave: (limit: number | null) => Promise<void>;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);

  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);

  const save = async () => {
    const trimmed = text.trim();
    const limit = trimmed === '' ? null : Number(trimmed);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 100_000)) {
      setBad(true);
      return;
    }
    setBad(false);
    setBusy(true);
    try {
      await onSave(limit);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin__limit">
      <input
        className={`field__input${bad ? ' field__input--bad' : ''}`}
        type="number"
        min={0}
        max={100000}
        value={text}
        placeholder="默认"
        aria-label="每日消息额度"
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void save();
          }
        }}
      />
      <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void save()}>
        {busy ? '…' : '改额度'}
      </button>
    </div>
  );
}
