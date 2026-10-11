/**
 * `reg query` 输出的读取器（P5d）—— Windows 那条托管通道。
 *
 * 输入是 `reg query HKLM\SOFTWARE\DeepCode /s` 的真实形状：
 *
 * ```
 * HKEY_LOCAL_MACHINE\SOFTWARE\DeepCode
 *     telemetry.enabled    REG_DWORD    0x0
 *     permissions.deny     REG_MULTI_SZ    Bash(git push:*)\0Bash(rm -rf:*)
 *     instructions.text    REG_SZ    所有改动都要跑测试
 * ```
 *
 * **值名按 `.` 拆成嵌套路径**：`permissions.deny` → `{ permissions: { deny: ... } }`。
 * 这不是我们的发明 —— 注册表本来是平的，而托管设置是棵树；MDM/ADMX 向来靠命名约定
 * 把树拍平（参考实现那份 ADMX 模板走的是同一条路，只是它多带一个给组策略编辑器看的
 * 描述文件，我们不写那个）。
 *
 * ⚠️ **编码**：`reg.exe` 按系统 OEM 代码页输出，不是 UTF-8。值全是 ASCII 时没差别；
 * 值里有中文（比如 `instructions.text`）在部分机器上会是乱码。这条写进了 README ——
 * 与其假装没有，不如说清它。
 */

/** 一行值的形状：`    名字    类型    值`（值里可以有空格）。 */
const VALUE_RE = /^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/;

type Entry = { readonly name: string; readonly type: string; readonly raw: string };

/**
 * 注册表没有布尔类型。`REG_SZ` 的 `true` / `false`（忽略大小写）读成布尔 ——
 * 这是一条**写进 README 的口径**，不是随手做的强制转换。
 *
 * 代价说清：想表达字面量字符串 `true` 就表达不出来了。我们的设置面里没有哪个字段会想要它
 * （`permissions.deny` 是字符串数组，走 `REG_MULTI_SZ`，不经过这儿）。
 * 与之相对的另一种做法（把 `REG_DWORD` 的 `0`/`1` 读成布尔）我们**没有**采用 ——
 * 那会让 `compact.keepTurns: 1` 变成 `true`，是个真的坑。
 */
function scalar(raw: string): unknown {
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  return raw;
}

function convert(entry: Entry): unknown {
  const raw = entry.raw.trim();
  switch (entry.type) {
    case 'REG_DWORD':
    case 'REG_QWORD': {
      const hex = raw.toLowerCase().startsWith('0x');
      const value = Number.parseInt(hex ? raw.slice(2) : raw, hex ? 16 : 10);
      if (Number.isNaN(value)) {
        throw new Error(`注册表：${entry.name} 的 ${entry.type} 值「${entry.raw}」不是一个数`);
      }
      return value;
    }
    case 'REG_MULTI_SZ':
      // `reg query` 把多字符串打成 `a\0b`（字面量的反斜杠零），少数版本会把它拆成同名多行。
      // 两种都认 —— 后者由 `collect` 那边合成数组。
      return entry.raw
        .split(/\\0|\u0000/)
        .map((item) => item.trim())
        .filter((item) => item !== '');
    case 'REG_SZ':
    case 'REG_EXPAND_SZ':
      return scalar(entry.raw);
    default:
      // 别的类型（REG_BINARY 之类）原样当字符串。看不懂的类型不该让整份策略报废 ——
      // 但我们也不假装读懂了它。
      return entry.raw;
  }
}

function collect(text: string): readonly Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // 不以空白开头的是键名行（`HKEY_LOCAL_MACHINE\...`）—— 跳过。
    // 也有 `reg query` 在找不到键时打到 stdout 的中文提示，同样在这里被跳过，
    // 于是"一个值都没有" → 返回 undefined（见下）。
    if (!/^\s/.test(line)) continue;

    const hit = VALUE_RE.exec(line);
    if (hit === null) throw new Error(`注册表：读不懂这一行「${line}」`);
    entries.push({ name: hit[1] ?? '', type: hit[2] ?? '', raw: hit[3] ?? '' });
  }
  return entries;
}

function setPath(root: Record<string, unknown>, name: string, value: unknown): void {
  const path = name.split('.');
  if (path.some((part) => part === '')) {
    throw new Error(`注册表：值名「${name}」里有点号拼出来的空段`);
  }

  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const existing = cursor[key];
    if (existing === undefined) {
      const made: Record<string, unknown> = {};
      cursor[key] = made;
      cursor = made;
      continue;
    }
    // 已经是标量（或数组）了还要往下拆 → 两份配置在抢同一个键。安静地覆盖最坏。
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      throw new Error(`注册表：「${name}」与一个已有的标量抢同一个键`);
    }
    cursor = existing as Record<string, unknown>;
  }

  const last = path[path.length - 1] ?? '';
  if (Object.hasOwn(cursor, last)) {
    throw new Error(`注册表：值名「${name}」出现了两次`);
  }
  cursor[last] = value;
}

/**
 * 读一份 `reg query ... /s` 的输出。
 *
 * **一个值都没有 → `undefined`**，不是 `{}`：那台机器上就没有托管策略这个键。
 * 两者在 `resolvePolicy` 里都表现成"这一层是空的"，但在这里分得开，
 * 因为"读到一个空策略"与"没有策略"是两句话。
 */
export function parseRegistryQuery(text: string): unknown {
  const entries = collect(text);
  if (entries.length === 0) return undefined;

  // 同名多行 = 老版 `reg query` 把 `REG_MULTI_SZ` 拆行的样子，合成一个数组。
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.name);
    if (list === undefined) grouped.set(entry.name, [entry]);
    else list.push(entry);
  }

  const root: Record<string, unknown> = {};
  for (const [name, list] of grouped) {
    if (list.length === 1) {
      setPath(root, name, convert(list[0] as Entry));
      continue;
    }
    const flat = list.flatMap((entry) => {
      const value = convert(entry);
      return Array.isArray(value) ? (value as unknown[]) : [value];
    });
    setPath(root, name, flat);
  }
  return root;
}
