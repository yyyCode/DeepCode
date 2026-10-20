import { useState, type FormEvent } from 'react';
import { api, type Meta, type User } from '../api';

type Props = {
  readonly meta: Meta;
  readonly onAuthed: (user: User) => void;
};

export function AuthScreen({ meta, onAuthed }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRegister = meta.registration !== 'closed';
  const active = mode === 'register' && canRegister ? 'register' : 'login';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (active === 'register') {
      if (displayName.trim() === '') {
        setError('先起一个昵称。');
        return;
      }
      if (password.length < 8) {
        setError('密码至少 8 位。');
        return;
      }
      if (meta.registration === 'invite' && inviteCode.trim() === '') {
        setError('这个站点需要邀请码。');
        return;
      }
    }

    setBusy(true);
    try {
      const user =
        active === 'register'
          ? await api.register({
              email: email.trim(),
              password,
              displayName: displayName.trim(),
              inviteCode: inviteCode.trim(),
            })
          : await api.login(email.trim(), password);
      onAuthed(user);
    } catch (caught) {
      setError((caught as Error).message || '登录失败');
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__card">
        <header className="auth__head">
          <div className="brand">
            <span className="brand__dot" />
            <span>DeepCode Companion</span>
          </div>
          <h1>{active === 'register' ? '创建账号' : '欢迎回来'}</h1>
          <p>
            {active === 'register'
              ? '账号之间互相隔离：你的人物、对话和额度都只属于你。'
              : '登录后继续和你的角色聊天。'}
          </p>
        </header>

        {canRegister && (
          <div className="auth__tabs" role="tablist" aria-label="登录或注册">
            <button
              type="button"
              role="tab"
              aria-selected={active === 'login'}
              className={`auth__tab${active === 'login' ? ' auth__tab--active' : ''}`}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={active === 'register'}
              className={`auth__tab${active === 'register' ? ' auth__tab--active' : ''}`}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
            >
              注册
            </button>
          </div>
        )}

        {!canRegister && <p className="auth__note">现在不开放注册，请使用已有账号登录。</p>}

        <form className="auth__form" onSubmit={(event) => void submit(event)}>
          {active === 'register' && (
            <label className="field">
              <span className="field__label">昵称</span>
              <input
                className="field__input"
                value={displayName}
                maxLength={24}
                autoComplete="nickname"
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="别人怎么称呼你"
              />
            </label>
          )}

          <label className="field">
            <span className="field__label">邮箱</span>
            <input
              className="field__input"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          <label className="field">
            <span className="field__label">密码</span>
            <input
              className="field__input"
              type="password"
              value={password}
              autoComplete={active === 'register' ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={active === 'register' ? '至少 8 位' : '输入密码'}
              required
            />
          </label>

          {active === 'register' && meta.registration === 'invite' && (
            <label className="field">
              <span className="field__label">邀请码</span>
              <input
                className="field__input"
                value={inviteCode}
                autoComplete="off"
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="向管理员要一个"
              />
            </label>
          )}

          {error !== null && (
            <div className="chat__error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
            {busy ? '请稍等…' : active === 'register' ? '注册并进入' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
