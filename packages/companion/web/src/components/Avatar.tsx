import type { AvatarKey } from '../api';

export type AvatarState = 'idle' | 'thinking' | 'speaking';

/**
 * 占位卡通形象。换真图时只改这个文件：把 <svg> 换成一个 <img>，
 * 三个状态对应的 class 留在外层容器上即可。
 * 配色由 `avatar--girl-*` 上的 CSS 变量决定。
 */
export function Avatar({ state, avatar }: { state: AvatarState; avatar: AvatarKey }) {
  return (
    <div className={`avatar avatar--${state} avatar--${avatar}`} aria-hidden="true">
      <div className="avatar__halo" />
      <svg className="avatar__art" viewBox="0 0 240 260">
        <defs>
          <linearGradient id="avatar-hair" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--avatar-hair-top)" />
            <stop offset="100%" stopColor="var(--avatar-hair-bottom)" />
          </linearGradient>
          <linearGradient id="avatar-dress" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--avatar-dress-top)" />
            <stop offset="100%" stopColor="var(--avatar-dress-bottom)" />
          </linearGradient>
          <radialGradient id="avatar-glow" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="var(--avatar-glow)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--avatar-glow)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse cx="120" cy="118" rx="96" ry="104" fill="url(#avatar-glow)" />

        {/* 长发与肩膀 */}
        <path
          d="M52 104C52 44 78 22 120 22s68 22 68 82l8 100c-8 10-24 14-36 8l-4-62H84l-4 62c-12 6-28 2-36-8Z"
          fill="url(#avatar-hair)"
        />
        <path
          d="M68 214c4-28 24-40 52-40s48 12 52 40v30H68Z"
          fill="url(#avatar-dress)"
        />

        {/* 脖子与脸 */}
        <rect x="108" y="156" width="24" height="30" rx="12" fill="#efc3ae" />
        <ellipse cx="64" cy="120" rx="8" ry="12" fill="#efc3ae" />
        <ellipse cx="176" cy="120" rx="8" ry="12" fill="#efc3ae" />
        <ellipse cx="120" cy="116" rx="56" ry="60" fill="#f8d8c6" />

        {/* 刘海与两侧头发 */}
        <path
          d="M64 106c0-42 20-62 56-62s56 20 56 62c-8-18-26-30-56-30s-48 12-56 30Z"
          fill="url(#avatar-hair)"
        />
        <path d="M62 100c-8 28-8 60 0 86-8 0-16-10-16-26v-52Z" fill="url(#avatar-hair)" />
        <path d="M178 100c8 28 8 60 0 86 8 0 16-10 16-26v-52Z" fill="url(#avatar-hair)" />

        {/* 腮红 */}
        <ellipse cx="86" cy="136" rx="11" ry="6" fill="#f29a9a" opacity="0.5" />
        <ellipse cx="154" cy="136" rx="11" ry="6" fill="#f29a9a" opacity="0.5" />

        {/* 眼睛：眨眼靠 CSS 压扁这一组 */}
        <g className="avatar__eyes">
          <ellipse cx="98" cy="116" rx="7" ry="9" fill="#3a2438" />
          <ellipse cx="142" cy="116" rx="7" ry="9" fill="#3a2438" />
          <circle cx="100.5" cy="113" r="2.2" fill="#fff" />
          <circle cx="144.5" cy="113" r="2.2" fill="#fff" />
        </g>

        {/* 嘴 */}
        <path
          className="avatar__mouth"
          d="M113 142q7 6 14 0"
          stroke="#b96a72"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />

        {/* 领口 */}
        <path
          d="M100 176l20 14 20-14"
          stroke="#f7e6ee"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        />
      </svg>

      {state === 'thinking' && (
        <div className="avatar__dots" aria-label="正在思考">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
