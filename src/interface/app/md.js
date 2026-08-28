// ============================================
// 极简 Markdown 渲染 —— 只构造 DOM 节点,永不使用 innerHTML
// ============================================
//
// 为什么不用 marked / markdown-it + DOMPurify:
//
// ① **安全靠结构而不靠消毒**。渲染的是模型输出、以及它从网页抓回来的片段,
//    全是不可信文本。库的做法是「把 markdown 解析成 HTML 字符串,再交给
//    innerHTML」,于是必须再挂一个消毒器,而漏配一个选项就是 XSS。
//    这里全程 createElement + textContent —— 文本永远是文本,
//    `<script>` 只会显示成五个字符。没有 HTML 解析,就没有 HTML 注入。
// ② 需要的子集很小(代码块、行内代码、粗体、链接、列表、表格、标题),
//    为它引两个依赖不划算。
//
// 刻意**不支持**的:
// - 原始 HTML 块 —— 见上,那正是要避免的东西
// - 图片 `![]()` —— 会让模型输出触发外部网络请求(等于信标),
//   而客户端里没有理由让远端知道你看了什么。渲染成链接
// - 嵌套列表的多级缩进 —— 模型很少用,而实现它要一套栈
// ============================================

(() => {
  'use strict';

  /** 只允许这些协议出现在链接里。javascript: 与 data: 是刻意排除的 */
  const SAFE_LINK = /^(https?:|mailto:)/i;

  // ---------- 行内 ----------
  //
  // 顺序有讲究:行内代码**最先**匹配,因为 `**不是粗体**` 这种写法里
  // 星号应当原样显示。先处理别的会让代码块内容被改写。
  const INLINE = [
    { re: /`([^`]+)`/, tag: 'code' },
    { re: /\*\*([^*]+)\*\*/, tag: 'strong' },
    { re: /__([^_]+)__/, tag: 'strong' },
    { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, tag: 'em' },
    { re: /~~([^~]+)~~/, tag: 'del' },
  ];

  const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;

  /**
   * 把一行文本里的行内标记摊进目标节点
   *
   * 递归处理:每次找最靠前的那个标记,左边当纯文本、右边继续递归。
   * 用递归而非一遍扫到底是为了让 `**粗体里的 `代码` **` 这类嵌套也成立。
   */
  function inline(target, text) {
    if (!text) return;

    // 先找链接:它的括号结构与其他标记不重叠,单独判更简单
    let best = null;
    const linkM = LINK.exec(text);
    if (linkM) best = { m: linkM, kind: 'link' };

    for (const { re, tag } of INLINE) {
      const m = re.exec(text);
      if (!m) continue;
      if (!best || m.index < best.m.index) best = { m, kind: tag };
    }

    if (!best) {
      target.appendChild(document.createTextNode(text));
      return;
    }

    const { m, kind } = best;
    if (m.index > 0) target.appendChild(document.createTextNode(text.slice(0, m.index)));

    if (kind === 'link') {
      const [, label, href] = m;
      if (SAFE_LINK.test(href)) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';       // 主进程会拦下来交给系统浏览器
        a.rel = 'noreferrer noopener';
        a.textContent = label || href;
        target.appendChild(a);
      } else {
        // 协议不安全:原样显示,不做成可点的东西
        target.appendChild(document.createTextNode(m[0]));
      }
    } else {
      const el = document.createElement(kind);
      if (kind === 'code') {
        // 行内代码里不再解析别的标记
        el.textContent = m[1];
      } else {
        inline(el, m[1]);
      }
      target.appendChild(el);
    }

    inline(target, text.slice(m.index + m[0].length));
  }

  // ---------- 块级 ----------

  const FENCE = /^```(\w*)\s*$/;
  const HEADER = /^(#{1,6})\s+(.*)$/;
  const UL = /^\s*[-*+]\s+(.*)$/;
  const OL = /^\s*(\d+)[.)]\s+(.*)$/;
  const QUOTE = /^>\s?(.*)$/;
  const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
  const TABLE_SEP = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/;

  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
      .split('|').map(c => c.trim());
  }

  /**
   * 渲染 markdown 文本,返回一个 DocumentFragment
   *
   * 未闭合的代码围栏当作「到末尾都是代码」处理 —— 流式输出的中途必然出现
   * 这种状态(模型刚吐出 ``` 还没吐完内容),报错或吞掉都比原样显示更糟。
   */
  function render(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text ?? '').split('\n');
    let i = 0;
    let para = null;

    const flushPara = () => {
      if (!para) return;
      const p = document.createElement('p');
      inline(p, para.join('\n'));
      frag.appendChild(p);
      para = null;
    };

    while (i < lines.length) {
      const line = lines[i];

      // 代码围栏
      const fence = FENCE.exec(line);
      if (fence) {
        flushPara();
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
        i++;   // 跳过收尾的 ```(未闭合时这里越界,while 自然结束)

        const pre = document.createElement('pre');
        pre.className = 'md-code';
        const code = document.createElement('code');
        if (lang) {
          pre.dataset.lang = lang;
          code.className = `lang-${lang}`;
        }
        code.textContent = body.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      // 表格:当前行含 |,且下一行是分隔行
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flushPara();
        const table = document.createElement('table');
        table.className = 'md-table';

        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const cell of splitRow(line)) {
          const th = document.createElement('th');
          inline(th, cell);
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        i += 2;
        const tbody = document.createElement('tbody');
        while (i < lines.length && lines[i].includes('|')) {
          const tr = document.createElement('tr');
          for (const cell of splitRow(lines[i])) {
            const td = document.createElement('td');
            inline(td, cell);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        frag.appendChild(table);
        continue;
      }

      // 标题
      const h = HEADER.exec(line);
      if (h) {
        flushPara();
        const el = document.createElement(`h${h[1].length}`);
        el.className = 'md-h';
        inline(el, h[2]);
        frag.appendChild(el);
        i++;
        continue;
      }

      // 分隔线。必须在列表之前判:`---` 也能匹配 UL
      if (RULE.test(line)) {
        flushPara();
        frag.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      // 列表(连续同类行归为一个 ul/ol)
      const ul = UL.exec(line);
      const ol = OL.exec(line);
      if (ul || ol) {
        flushPara();
        const ordered = !!ol;
        const list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'md-list';
        if (ordered) list.start = Number(ol[1]) || 1;

        while (i < lines.length) {
          const u = UL.exec(lines[i]);
          const o = OL.exec(lines[i]);
          if (ordered ? !o : !u) break;
          const li = document.createElement('li');
          inline(li, ordered ? o[2] : u[1]);
          list.appendChild(li);
          i++;
        }
        frag.appendChild(list);
        continue;
      }

      // 引用
      const q = QUOTE.exec(line);
      if (q) {
        flushPara();
        const bq = document.createElement('blockquote');
        bq.className = 'md-quote';
        const body = [q[1]];
        i++;
        while (i < lines.length && QUOTE.test(lines[i])) {
          body.push(QUOTE.exec(lines[i])[1]);
          i++;
        }
        inline(bq, body.join('\n'));
        frag.appendChild(bq);
        continue;
      }

      // 空行结束段落
      if (!line.trim()) {
        flushPara();
        i++;
        continue;
      }

      (para ??= []).push(line);
      i++;
    }

    flushPara();
    return frag;
  }

  /** 把渲染结果放进一个节点(先清空)。返回该节点 */
  function into(node, text) {
    node.textContent = '';
    node.appendChild(render(text));
    return node;
  }

  window.AgentMarkdown = { render, into };
})();
