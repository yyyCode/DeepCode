/* DeepCode 官网的三个渐进增强：终端演示的重播、复制按钮、移动端目录与当前区块高亮。
   没有依赖、没有构建、不做任何外部请求。

   一条规矩：**这段脚本只重放内容，不生产内容。** 演示里那八行、要复制的三条命令，
   HTML 里都有；关掉 JS、或者系统开了「减少动态效果」，它们照样完整地摆在那儿。
   所以这里没有任何一处是会「加载失败就留个白框」的写法。 */
(function () {
  'use strict';

  var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ── 1. 终端演示：把静态那八行重放一遍 ───────────────────────────────── */

  var demo = document.querySelector('[data-demo]');
  var termBody = demo && demo.querySelector('.term__body');
  var replayBtn = demo && demo.querySelector('[data-demo-replay]');

  if (demo && termBody && replayBtn && !still) {
    var items = [].slice.call(termBody.querySelectorAll('.l')).map(function (el) {
      return { el: el, text: el.textContent, typed: el.hasAttribute('data-type') };
    });
    var caret = termBody.querySelector('.caret');
    var gen = 0;

    // 隐藏用的是 opacity 而不是 display:none，所以高度本来就不会变。量一次钉住只是保险。
    termBody.style.minHeight = termBody.offsetHeight + 'px';
    if (caret) caret.parentNode.removeChild(caret);

    // CJK 一个一个字打太慢，逗号句号又太跳 —— 分开给节奏。
    // 用码点比而不是正则字符类：省得在这个页面里塞一堆 \\uXXXX 转义，谁读都得先解码。
    var perChar = function (ch) {
      var c = ch.codePointAt(0);
      var wide = (c >= 0x2e80 && c <= 0x9fff) ||
        (c >= 0x3000 && c <= 0x303f) ||
        (c >= 0xff00 && c <= 0xffef);
      return wide ? 42 : 18;
    };
    // 每行亮完之后的停顿：等确认的那两处要更久，否则「停下来问你」看不出是停下来了。
    var settle = function (el) {
      if (el.classList.contains('a')) return 560;
      if (el.classList.contains('w')) return 660;
      if (el.classList.contains('p')) return 380;
      return 340;
    };

    var putCaret = function (el) { if (caret) el.appendChild(caret); };

    var play = function () {
      var mine = ++gen;                       // 重播时把上一遍的循环作废
      var alive = function () { return mine === gen; };

      items.forEach(function (it) {
        if (it.typed) it.el.textContent = ''; // 打字的那两行清空重打，其余原样
        it.el.classList.add('is-pending');
      });

      var step = function (i) {
        if (i >= items.length || !alive()) return Promise.resolve();
        var it = items[i];
        it.el.classList.remove('is-pending');

        if (!it.typed) {
          putCaret(it.el);
          return sleep(settle(it.el)).then(function () { return step(i + 1); });
        }

        // 逐字：整行的 textContent 重设，光标跟着重新贴到行尾。
        // 打字行里没有子元素（`<b>y</b>` 那种带标记的行不参与打字），所以能这么写。
        var chars = Array.from(it.text);
        var type = function (n) {
          if (n > chars.length || !alive()) return Promise.resolve();
          it.el.textContent = chars.slice(0, n).join('');
          putCaret(it.el);
          return sleep(perChar(chars[n - 1])).then(function () { return type(n + 1); });
        };
        return type(1).then(function () { return sleep(settle(it.el)); })
          .then(function () { return step(i + 1); });
      };

      return step(0);
    };

    replayBtn.addEventListener('click', function () { play(); });

    // 进了视野才开始打 —— 不然一屏空白要先扫过去才动。只打一遍，来回滚不重放。
    var once = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        once.disconnect();
        play();
      }
    }, { threshold: 0.25 });
    once.observe(demo);
  } else if (replayBtn) {
    // 静态那一屏不需要「重播」这个按钮，留着就是个按了没反应的控件。
    replayBtn.hidden = true;
  }

  /* ── 2. 复制按钮 ─────────────────────────────────────────────────────── */

  // 注意：`file://` 不是安全上下文，`navigator.clipboard` 往往根本不存在 ——
  // 对「双击 index.html 打开」这个主要场景来说，下面这条降级路径其实是主路径。
  var legacyCopy = function (text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  };

  var timers = new WeakMap();
  [].slice.call(document.querySelectorAll('.copy')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var report = function (ok) {
        btn.textContent = ok ? '已复制' : '请手动复制';
        btn.classList.add('is-done');
        clearTimeout(timers.get(btn));
        timers.set(btn, setTimeout(function () {
          btn.textContent = '复制';
          btn.classList.remove('is-done');
        }, 1800));
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { report(true); }, function () { report(legacyCopy(text)); });
      } else {
        report(legacyCopy(text));
      }
    });
  });

  /* ── 3. 目录：移动端折叠 + 当前区块高亮 ──────────────────────────────── */

  var nav = document.getElementById('nav');
  var navBtn = document.querySelector('.navbtn');
  var topbar = document.getElementById('topbar');

  if (nav && navBtn) {
    var setOpen = function (open) {
      nav.classList.toggle('is-open', open);
      navBtn.setAttribute('aria-expanded', String(open));
    };
    navBtn.addEventListener('click', function () { setOpen(!nav.classList.contains('is-open')); });
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  if (topbar) {
    var stick = function () { topbar.classList.toggle('is-stuck', window.scrollY > 4); };
    stick();
    window.addEventListener('scroll', stick, { passive: true });
  }

  var links = [].slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var sections = links.map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(function (s) { return !!s; });

  if (links.length && sections.length) {
    var here = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.classList.toggle('is-here', a.getAttribute('href') === '#' + entry.target.id);
        });
      });
    }, { rootMargin: '-72px 0px -58% 0px' });
    sections.forEach(function (s) { here.observe(s); });
  }
})();
