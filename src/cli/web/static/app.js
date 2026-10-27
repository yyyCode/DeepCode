// DeepCode 本地界面。没有构建步骤，也不引任何依赖 —— 这里就是全部前端代码。
// 所有来自模型与工具的文字都先转义、再匹配极简 markdown（见 renderMarkdown）。

const token = new URLSearchParams(location.search).get('t');

const timeline = document.getElementById('timeline');
const hero = document.getElementById('hero');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const stateEl = document.getElementById('state');
const stateText = document.getElementById('state-text');
const cwdEl = document.getElementById('cwd');
const modelEl = document.getElementById('model');

let busy = false;
let waiting = 0;
let connection = 'connecting';
/** 时间线里有几样东西（不含空状态）。只有它决定空状态显不显示。 */
let itemCount = 0;
/** 正在跑的工具数。它和 `busy` 一起决定要不要画"思考中"。 */
let runningTools = 0;
/** 当前正在流式追加的助手气泡。`turn.start` 或下一条提问到来时清空。 */
let activeAssistant = null;
let thinkingEl = null;
const toolCards = new Map();
const askCards = new Map();

// ── 小工具 ────────────────────────────────────────────────────────────

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const nearBottom = () =>
  timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;

function scrollIfNear(wasNear) {
  if (wasNear) timeline.scrollTop = timeline.scrollHeight;
}

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function updateHero() {
  if (hero !== null) hero.hidden = itemCount > 0;
}

function addItem(element) {
  const wasNear = nearBottom();
  timeline.append(element);
  itemCount += 1;
  // "思考中"永远贴在最后一行：日志、工具、助手文字都该出现在它上面。
  if (thinkingEl !== null && thinkingEl !== element) timeline.append(thinkingEl);
  updateHero();
  scrollIfNear(wasNear);
  return element;
}

function systemLine(text, level) {
  const item = document.createElement('div');
  item.className = 'item';
  const line = document.createElement('div');
  line.className = level === 'warn' ? 'sys warn' : 'sys';
  line.textContent = text;
  item.append(line);
  return addItem(item);
}

// ── markdown-lite ─────────────────────────────────────────────────────
// 顺序是安全的前提：**先整体转义**，再只生成我们自己的标签。
// 链接只认 http/https（转义之后 `javascript:` 那种根本匹配不上）。

function inline(text) {
  return text
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(^|[\s(（])(https?:\/\/[^\s<)）]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );
}

function renderMarkdown(source) {
  const lines = escapeHtml(source).split('\n');
  const out = [];
  let inFence = false;
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      flush();
      if (inFence) {
        out.push('</code></pre>');
        inFence = false;
      } else {
        out.push('<pre><code>');
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      out.push(`${line}\n`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item !== null) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (inFence) out.push('</code></pre>');
  flush();
  return out.join('');
}

// ── 时间线元素 ────────────────────────────────────────────────────────

function userBubble(text) {
  const item = document.createElement('div');
  item.className = 'item msg-user';
  item.textContent = text;
  return addItem(item);
}

function delta(text) {
  if (activeAssistant === null) {
    const item = document.createElement('div');
    item.className = 'item msg-assistant';
    const body = document.createElement('div');
    body.className = 'md';
    item.append(body);
    activeAssistant = { body, text: '' };
    addItem(item);
  }
  activeAssistant.text += text;
  const wasNear = nearBottom();
  activeAssistant.body.innerHTML = renderMarkdown(activeAssistant.text);
  updateThinking();
  scrollIfNear(wasNear);
}

// ── 思考中 ────────────────────────────────────────────────────────────

function updateThinking() {
  const want =
    busy && waiting === 0 && runningTools === 0 && activeAssistant === null && connection !== 'down';
  if (!want) {
    if (thinkingEl !== null) {
      thinkingEl.remove();
      thinkingEl = null;
      itemCount = Math.max(0, itemCount - 1);
      updateHero();
    }
    return;
  }
  if (thinkingEl !== null) return;
  const item = document.createElement('div');
  item.className = 'item thinking';
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) dots.append(document.createElement('i'));
  const label = document.createElement('span');
  label.textContent = '思考中';
  item.append(dots, label);
  thinkingEl = item;
  addItem(item);
}

// ── 工具行 ────────────────────────────────────────────────────────────

function summarizeInput(tool, input) {
  if (input === null || typeof input !== 'object') return '';
  const fields = ['command', 'file_path', 'path', 'pattern', 'query', 'description', 'task'];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value !== '') return value.split('\n')[0];
  }
  try {
    return JSON.stringify(input).slice(0, 100);
  } catch {
    return '';
  }
}

function inputText(input) {
  try {
    const text = JSON.stringify(input, null, 2) ?? String(input);
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…（截断）` : text;
  } catch {
    return String(input);
  }
}

function block(caption) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-block';
  if (caption !== undefined) {
    const label = document.createElement('div');
    label.className = 'tool-caption';
    label.textContent = caption;
    wrap.append(label);
  }
  const pre = document.createElement('pre');
  wrap.append(pre);
  return { wrap, pre };
}

function toolCard(id, tool, input) {
  const existing = toolCards.get(id);
  if (existing !== undefined) return existing;

  const item = document.createElement('div');
  item.className = 'item tool';
  item.dataset.status = 'running';

  const details = document.createElement('details');
  const summary = document.createElement('summary');

  const status = document.createElement('span');
  status.className = 'tool-status';
  status.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = tool;

  const sep = document.createElement('span');
  sep.className = 'tool-sep';
  sep.setAttribute('aria-hidden', 'true');

  const target = document.createElement('span');
  target.className = 'tool-target';
  target.textContent = summarizeInput(tool, input);
  const hasTarget = target.textContent !== '';
  sep.hidden = !hasTarget;
  target.hidden = !hasTarget;

  const meta = document.createElement('span');
  meta.className = 'tool-meta';

  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  summary.title = hasTarget ? `${tool} · ${target.textContent}` : tool;
  summary.append(status, name, sep, target, meta, chevron);

  const body = document.createElement('div');
  body.className = 'tool-body';
  const inputBlock = block('输入');
  inputBlock.pre.textContent = inputText(input);
  const outputBlock = block('输出');
  outputBlock.wrap.hidden = true;
  body.append(inputBlock.wrap, outputBlock.wrap);

  const truncated = document.createElement('div');
  truncated.className = 'truncated';
  truncated.textContent = '界面里只显示前 20 000 个字符。模型拿到的是完整的。';
  truncated.hidden = true;
  body.append(truncated);

  details.append(summary, body);
  item.append(details);
  addItem(item);

  const card = { item, details, meta, outputBlock, truncated };
  toolCards.set(id, card);
  return card;
}

function finishTool(event) {
  const card = toolCard(event.toolUseId, event.tool ?? '工具', undefined);
  const status = event.status ?? 'ok';
  card.item.dataset.status = status;
  card.meta.textContent = formatMs(event.durationMs);
  if (typeof event.output === 'string') {
    card.outputBlock.pre.textContent = event.output;
    card.outputBlock.wrap.hidden = false;
  }
  if (event.truncated === true) card.truncated.hidden = false;
  // 出错的时候人最想知道发生了什么：直接展开，省一次点击。
  if (status === 'error' || status === 'denied') card.details.open = true;
}

// ── 权限卡 ────────────────────────────────────────────────────────────

function askCard(event) {
  const item = document.createElement('div');
  item.className = 'item ask';

  const strip = document.createElement('div');
  strip.className = 'ask-strip';
  const icon = document.createElement('span');
  icon.className = 'ask-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '!';
  const stripText = document.createElement('span');
  stripText.textContent = '需要你确认';
  strip.append(icon, stripText);

  const body = document.createElement('div');
  body.className = 'ask-body';

  const title = document.createElement('div');
  title.className = 'ask-title';
  title.textContent = event.question;
  body.append(title);

  if (typeof event.tool === 'string') {
    const pre = document.createElement('pre');
    pre.className = 'ask-command';
    pre.textContent = `${event.tool}\n${inputText(event.input)}`;
    body.append(pre);
  }

  const actions = document.createElement('div');
  actions.className = 'ask-actions';
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = String(choice.value);
    button.textContent = String(choice.label ?? choice.value);
    button.addEventListener('click', async () => {
      for (const other of actions.querySelectorAll('button')) other.disabled = true;
      await post('/api/answer', { id: event.id, value: String(choice.value) });
    });
    actions.append(button);
  }
  body.append(actions);

  const note = document.createElement('div');
  note.className = 'ask-note';
  note.textContent = '5 分钟不答按拒绝处理。';
  body.append(note);

  item.append(strip, body);
  addItem(item);

  const card = {
    item,
    actions,
    note,
    stripText,
    icon,
    labels: new Map(choices.map((choice) => [String(choice.value), String(choice.label ?? choice.value)])),
  };
  askCards.set(event.id, card);
  return card;
}

function resolveAsk(event) {
  const card = askCards.get(event.id);
  askCards.delete(event.id);
  waiting = Math.max(0, waiting - 1);
  if (card !== undefined) {
    card.item.classList.add('settled');
    for (const button of card.actions.querySelectorAll('button')) {
      button.disabled = true;
      button.classList.toggle('chosen', button.dataset.value === String(event.value));
    }
    const reasons = {
      answer: `已选择：${card.labels.get(String(event.value)) ?? event.value}`,
      timeout: '超时没人回答，按拒绝处理。',
      closed: '服务停止，按拒绝处理。',
      abort: '已中断，按拒绝处理。',
    };
    card.note.textContent = reasons[event.reason] ?? `已收场：${event.value}`;
    card.stripText.textContent = event.reason === 'answer' ? '已确认' : '没有确认';
    card.icon.textContent = event.reason === 'answer' ? '✓' : '!';
  }
  updateState();
}

// ── 状态与网络 ────────────────────────────────────────────────────────

function updateState() {
  let phase = 'idle';
  let text = '空闲';
  if (connection === 'down') {
    phase = 'down';
    text = '已断开';
  } else if (connection === 'connecting') {
    text = '连接中';
  } else if (waiting > 0) {
    phase = 'ask';
    text = '等待确认';
  } else if (busy) {
    phase = 'busy';
    text = '思考中';
  }
  stateEl.dataset.phase = phase;
  stateText.textContent = text;
  sendButton.textContent = busy ? '停止' : '发送';
  sendButton.classList.toggle('stop', busy);
  updateThinking();
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deepcode-token': token ?? '' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    systemLine(`请求发不出去：${String(error)}`, 'warn');
    return false;
  }
  if (response.ok) return true;
  let message = `请求失败（${response.status}）`;
  try {
    const data = await response.json();
    if (typeof data.error === 'string') message = data.error;
  } catch {
    // 非 JSON 的错误体就用状态码。
  }
  systemLine(message, 'warn');
  return false;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (connection === 'down') {
    systemLine('与服务的连接断了，刷新页面试试。', 'warn');
    return;
  }
  if (busy) {
    void post('/api/interrupt', {});
    return;
  }
  const text = input.value.trim();
  if (text === '') return;
  input.value = '';
  autosize();
  void post('/api/prompt', { text });
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener('input', autosize);

// 空状态上的三个入口：直接发出去。忙的时候只填进输入框，别把正在跑的 turn 打断。
for (const button of document.querySelectorAll('.suggest')) {
  button.addEventListener('click', () => {
    const prompt = button.dataset.prompt ?? '';
    if (prompt === '') return;
    input.value = prompt;
    autosize();
    if (busy || connection !== 'open') {
      input.focus();
      return;
    }
    composer.requestSubmit();
  });
}

// ── SSE ──────────────────────────────────────────────────────────────

function resetTimeline() {
  timeline.replaceChildren(...(hero === null ? [] : [hero]));
  itemCount = 0;
  runningTools = 0;
  thinkingEl = null;
  toolCards.clear();
  askCards.clear();
  activeAssistant = null;
  waiting = 0;
  updateHero();
}

function onEvent(event) {
  switch (event.type) {
    case 'user':
      activeAssistant = null;
      userBubble(String(event.text ?? ''));
      updateThinking();
      break;
    case 'delta':
      delta(String(event.text ?? ''));
      break;
    case 'log':
      systemLine(String(event.text ?? ''), event.level === 'warn' ? 'warn' : undefined);
      break;
    case 'tool.start':
      // 工具之后的文字属于下一段回答。不收口的话，它会继续往上面那条气泡里
      // 追加 —— 时间线上就成了"工具结果出现在它前面的话之后"。
      activeAssistant = null;
      runningTools += 1;
      toolCard(String(event.toolUseId), String(event.tool ?? '工具'), event.input);
      updateThinking();
      break;
    case 'tool.end':
      runningTools = Math.max(0, runningTools - 1);
      finishTool(event);
      updateThinking();
      break;
    case 'tool.denied': {
      const rule = typeof event.rule === 'string' && event.rule !== '' ? `：${event.rule}` : '';
      systemLine(`${String(event.tool)} 被拒绝${rule}`, 'warn');
      break;
    }
    case 'ask':
      activeAssistant = null;
      waiting += 1;
      askCard(event);
      updateState();
      break;
    case 'ask.resolved':
      resolveAsk(event);
      break;
    // `consent` 不单独画一行：同一件事已经落在上面那张权限卡的"已确认"里了。
    case 'consent':
      break;
    case 'turn':
      activeAssistant = null;
      updateThinking();
      break;
    case 'busy':
      busy = event.busy === true;
      updateState();
      break;
    default:
      break;
  }
}

if (token === null || token === '') {
  systemLine('地址里缺 token。请用 deepcode web 打印出来的那条完整地址打开。', 'warn');
  input.disabled = true;
  sendButton.disabled = true;
  updateState();
} else {
  const source = new EventSource(`/events?t=${encodeURIComponent(token)}`);

  source.addEventListener('open', () => {
    connection = 'open';
    updateState();
  });

  source.addEventListener('error', () => {
    // EventSource 自己会重连；重连后服务端会先发 hello + 回放，
    // 那时整条时间线按回放重建，不会出现两遍。
    connection = 'down';
    updateState();
  });

  source.addEventListener('hello', (message) => {
    let hello;
    try {
      hello = JSON.parse(message.data);
    } catch {
      return;
    }
    connection = 'open';
    resetTimeline();
    busy = hello.busy === true;
    cwdEl.textContent = String(hello.cwd ?? '');
    cwdEl.title = String(hello.cwd ?? '');
    modelEl.textContent = String(hello.model ?? '');
    modelEl.hidden = modelEl.textContent === '';
    modelEl.title = modelEl.textContent;
    if (hello.replayTruncated === true) {
      systemLine('更早的记录不在这一份回放里，完整内容在磁盘上的转录文件中。', 'warn');
    }
    updateState();
    // 回放跟着 hello 一条条到：先贴到底，后面每一条都会因为"本来就在底部"继续跟着。
    timeline.scrollTop = timeline.scrollHeight;
  });

  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    onEvent(event);
  };
}

updateState();
autosize();
