// DeepCode 本地界面。没有构建步骤，也不引任何依赖 —— 这里就是全部前端代码。
// 所有来自模型与工具的文字都先转义、再匹配极简 markdown（见 renderMarkdown）。

const token = new URLSearchParams(location.search).get('t');

const timeline = document.getElementById('timeline');
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
/** 当前正在流式追加的助手气泡。`turn.start` 或下一条提问到来时清空。 */
let activeAssistant = null;
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

function addItem(element) {
  const wasNear = nearBottom();
  timeline.append(element);
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
  scrollIfNear(wasNear);
}

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

function toolCard(id, tool, input) {
  const existing = toolCards.get(id);
  if (existing !== undefined) return existing;

  const item = document.createElement('div');
  item.className = 'item tool';
  item.dataset.status = 'running';

  const head = document.createElement('div');
  head.className = 'tool-head';

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = tool;

  const target = document.createElement('span');
  target.className = 'tool-target';
  target.textContent = summarizeInput(tool, input);

  const meta = document.createElement('span');
  meta.className = 'tool-meta';
  meta.textContent = '运行中';

  head.append(name, target, meta);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '输入与输出';
  const inputPre = document.createElement('pre');
  inputPre.textContent = inputText(input);
  const outputPre = document.createElement('pre');
  outputPre.hidden = true;
  details.append(summary, inputPre, outputPre);

  item.append(head, details);
  addItem(item);

  const card = { item, meta, outputPre, details };
  toolCards.set(id, card);
  return card;
}

function finishTool(event) {
  const card = toolCard(event.toolUseId, event.tool ?? '工具', undefined);
  const status = event.status ?? 'ok';
  card.item.dataset.status = status;
  const labels = { ok: '完成', error: '出错', denied: '拒绝' };
  const duration = formatMs(event.durationMs);
  card.meta.textContent = `${labels[status] ?? status}${duration === '' ? '' : `  ${duration}`}`;
  if (typeof event.output === 'string') {
    card.outputPre.textContent = event.output;
    card.outputPre.hidden = false;
  }
  if (event.truncated === true) {
    const note = document.createElement('div');
    note.className = 'truncated';
    note.textContent = '界面里只显示前 20 000 个字符。模型拿到的是完整的。';
    card.item.append(note);
  }
}

function askCard(event) {
  const item = document.createElement('div');
  item.className = 'item ask';

  const title = document.createElement('div');
  title.className = 'ask-title';
  title.textContent = event.question;

  item.append(title);

  if (typeof event.tool === 'string') {
    const pre = document.createElement('pre');
    pre.textContent = `${event.tool}\n${inputText(event.input)}`;
    item.append(pre);
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
  item.append(actions);

  const note = document.createElement('div');
  note.className = 'ask-note';
  note.textContent = '5 分钟不答按拒绝处理。';
  item.append(note);

  const card = { item, actions, note };
  askCards.set(event.id, card);
  addItem(item);
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
      answer: `已选择：${event.value}`,
      timeout: '超时没人回答，按拒绝处理。',
      closed: '服务停止，按拒绝处理。',
      abort: '已中断，按拒绝处理。',
    };
    card.note.textContent = reasons[event.reason] ?? `已收场：${event.value}`;
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

// ── SSE ──────────────────────────────────────────────────────────────

function resetTimeline() {
  timeline.replaceChildren();
  toolCards.clear();
  askCards.clear();
  activeAssistant = null;
  waiting = 0;
}

function onEvent(event) {
  switch (event.type) {
    case 'user':
      activeAssistant = null;
      userBubble(String(event.text ?? ''));
      break;
    case 'delta':
      delta(String(event.text ?? ''));
      break;
    case 'log':
      systemLine(String(event.text ?? ''), event.level === 'warn' ? 'warn' : undefined);
      break;
    case 'tool.start':
      toolCard(String(event.toolUseId), String(event.tool ?? '工具'), event.input);
      break;
    case 'tool.end':
      finishTool(event);
      break;
    case 'tool.denied': {
      const rule = typeof event.rule === 'string' && event.rule !== '' ? `：${event.rule}` : '';
      systemLine(`${String(event.tool)} 被拒绝${rule}`, 'warn');
      break;
    }
    case 'ask':
      waiting += 1;
      askCard(event);
      updateState();
      break;
    case 'ask.resolved':
      resolveAsk(event);
      break;
    case 'consent':
      systemLine(
        `${String(event.tool)} ${
          event.granted === 'always' ? '已在本次会话允许' : '已允许一次'
        }`,
      );
      break;
    case 'turn':
      if (event.phase === 'start') activeAssistant = null;
      if (event.phase === 'end') activeAssistant = null;
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
    modelEl.textContent = String(hello.model ?? '');
    if (hello.replayTruncated === true) {
      systemLine('更早的记录不在这一份回放里，完整内容在磁盘上的转录文件中。', 'warn');
    }
    systemLine('会话已连上。问点什么，或者敲 /help 看命令。');
    updateState();
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
