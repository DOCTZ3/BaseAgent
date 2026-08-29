// ============================================
// 客户端渲染层 —— 把 AgentEvent 流画成界面
// ============================================
//
// **这份代码是最终要用的那份**,不是一次性的 mockup。它只依赖一个东西:
// 一个能吐 AgentEvent 的传输。原型阶段由 mock.js 提供假事件流(file:// 双击可看),
// 接上 server 之后换成 SSE —— 下面的渲染代码一行不改。
//
// 与 CLI 渲染器的区别不是「换了套颜色」:
// - CLI 的 reset 要靠 ANSI 往上回退擦除(算终端行数),这里只是清空一个 DOM 节点
// - CLI 每步结束要手动收掉未闭合的样式,这里没有这个概念
// 所以两边不共用代码 —— 共用只会让两套逻辑互相将就。
//
// 刻意**不显示** turn / token / 压缩次数 / trace 路径:那些是调试壳的东西。
// ============================================

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // Markdown 渲染器(md.js,必须在本文件之前加载)。
  // 取不到时降级为纯文本 —— 渲染坏掉不该让回答整段消失
  const md = window.AgentMarkdown ?? {
    into(node, text) { node.textContent = text; return node; },
  };

  const els = {
    stream: $('stream'),
    input: $('input'),
    send: $('btn-send'),
    stop: $('btn-stop'),
    wsLabel: $('ws-label'),
    sideList: $('side-list'),
    toBottom: $('btn-to-bottom'),
  };

  // ---------- 滚动 ----------
  //
  // 这三个函数**只有一份**,不各处直接写 scrollTop = scrollHeight。
  // 原先是后者:六处散落的赋值,而「贴底判定」只存在于 newTurn 的闭包里 ——
  // 于是新增一个滚动点就会漏掉按钮状态的同步,表现成「已经到底了按钮还亮着」。

  /** 距底 80px 以内算「贴着底部」。给余量是因为流式期间高度一直在变 */
  const BOTTOM_SLACK = 80;

  const atBottom = () =>
    els.stream.scrollHeight - els.stream.scrollTop - els.stream.clientHeight
      <= BOTTOM_SLACK;

  /** 无条件滚到底,并同步按钮 */
  function scrollToBottom() {
    els.stream.scrollTop = els.stream.scrollHeight;
    syncToBottomBtn();
  }

  /**
   * 只在用户本来就贴着底部时才跟随
   *
   * 无条件跟随会让用户往上翻看历史时被一直拽回来 —— 而多步任务里
   * 流式输出持续几十秒,那期间根本没法读前面的内容
   */
  function follow() {
    if (atBottom()) els.stream.scrollTop = els.stream.scrollHeight;
    syncToBottomBtn();
  }

  /** 按钮只在往上翻走之后出现:贴底时它没用,常驻会挡住右下角的正文 */
  function syncToBottomBtn() {
    if (els.toBottom) els.toBottom.hidden = atBottom();
  }

  els.stream.addEventListener('scroll', syncToBottomBtn);
  els.toBottom?.addEventListener('click', () => {
    els.stream.scrollTo({ top: els.stream.scrollHeight, behavior: 'smooth' });
    // 平滑滚动是异步的,scroll 事件会在滚动过程中把按钮点掉,不必手动同步
  });

  // ---------- 一轮的渲染状态 ----------
  //
  // 每轮新建。**不能提到模块作用域** —— 上一轮的 answer 节点留着,
  // 下一轮的正文就会续写到上一轮的气泡里(CLI 那边我刚踩过同类的坑:
  // streamed 标志泄漏导致回答整段消失)。
  function newTurn() {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    els.stream.appendChild(wrap);

    // 推理**按步分块**,不聚合成一个总的「思考过程」。
    //
    // 聚合的问题不是审美而是**顺序错了**:块的位置在第一次推理到达时就定下,
    // 于是第 4 步的推理在视觉上出现在第 2 步的工具调用**上面** ——
    // 而「这段推理导致了那次工具调用」正是这个界面最该表达的东西。
    // ChatGPT 那种「Thought for 8s」能聚合,是因为推理是不可分割的前置阶段、
    // 中间没有别的东西交错;一旦工具调用夹在推理之间,聚合必然破坏因果关系。
    let think = null;      // 当前步的推理块 { el, body, text, touched }
    let answer = null;     // 正文节点
    let buf = '';          // 正文原文。done 时用它做一次性 Markdown 渲染
    const tools = new Map();   // id → 标签节点

    // atBottom / follow 用模块级那一份(见文件顶部的「滚动」段)。
    // 这里原先有一份同名的闭包实现 —— 两份并存时「回到底部」按钮的状态
    // 同步只发生在其中一份里,表现成「已经到底了按钮还亮着」

    /** 短推理的字数上限 —— 到此为止不给折叠块 */
    const THINK_FLAT = 80;

    /**
     * 收掉当前推理块 —— 工具开始、正文开始、进入下一步、本轮结束时都要调
     *
     * 长度决定形态,这是从 trace 里看出来的:第一步的推理通常几百字(在规划),
     * 后续常常只有一句 —— 实测有一步只是「我的代码有个语法错误,反斜杠转义了
     * 引号,让我修复」。给这种一句话套个折叠块,点开点关比读它还费劲。
     *
     * 折叠时 summary 带一段预览而不只写「思考」:否则用户无法判断值不值得点开,
     * 而多步任务里会有四五个这种块。
     */
    function closeThink() {
      if (!think) return;
      const text = think.text.trim();

      if (!text) {
        think.el.remove();            // 空块不留:模型这一步没有思维链
      } else if (text.length <= THINK_FLAT) {
        think.el.open = true;
        think.el.classList.add('flat');   // 去掉三角与 hover,读起来就是一行注释
        think.sum.textContent = '思考';
      } else {
        think.el.open = false;
        const preview = text.replace(/\s+/g, ' ').slice(0, 42);
        think.sum.textContent = `思考 · ${preview}…`;
        think.sum.title = `${text.length} 字,点击展开`;
      }
      think = null;   // 置空是关键:下一段推理会新建块,于是顺序天然对上
    }

    return {
      reasoning(text) {
        if (!think) {
          // 用 <details> 而不是 div,是为了收尾时能原地折起来 ——
          // 换元素类型要做 DOM 手术,而流式中途换节点会让已渲染的文字闪一下
          const el = document.createElement('details');
          el.className = 'think';
          el.open = true;   // 流式期间摊开:边生成边折叠会让内容在眼前跳
          const sum = document.createElement('summary');
          sum.textContent = '思考';
          const body = document.createElement('div');
          body.className = 'think-text';
          el.append(sum, body);
          wrap.appendChild(el);
          think = { el, sum, body, text: '' };
        }
        think.text += text;
        think.body.textContent = think.text;
        follow();
      },

      content(text) {
        if (!answer) {
          // 正文开始 = 本步推理结束,先把上面那块收掉
          closeThink();
          answer = document.createElement('div');
          answer.className = 'answer streaming';
          wrap.appendChild(answer);
          buf = '';
        }
        // 流式期间只追加**纯文本**,不做 Markdown:每来一个字符重渲染一次
        // 是 O(n²) 的 DOM 重建,而且半截的 ``` 或 | 会让结构反复跳变。
        // 本轮结束时(done)拿 buf 一次性渲染。
        //
        // textContent 而非 innerHTML:模型输出是不可信文本,
        // 里面完全可能有 <script> 或从网页抓来的 HTML 片段
        buf += text;
        answer.textContent = buf;
        follow();
      },

      /** 重试:丢弃本步已收到的全部增量 */
      reset() {
        // 整块删掉而不是清空文本:重试会从头再说一遍,留着空块
        // 会在页面上攒下一串空壳
        if (think) { think.el.remove(); think = null; }
        // buf 必须跟着清:不清的话重试后的正文会拼在上一次那半截后面,
        // 而 done 渲染的是 buf —— 用户看到同一段话说了两遍
        buf = '';
        if (answer) { answer.remove(); answer = null; }
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = '(重试,重新生成…)';
        wrap.appendChild(n);
        follow();
      },

      step(step, maxSteps) {
        // 新的一步开始 —— 上一步的推理块到此为止(哪怕没有工具调用)
        closeThink();
        // 第一步不报:刚点发送就跳「第 1 步」是噪音
        if (step <= 1) return;
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = `第 ${step} / ${maxSteps} 步`;
        wrap.appendChild(n);
        follow();
      },

      toolStart(id, name) {
        // 工具要跑了 —— 本步的推理和正文都到此结束。
        // **这一处是顺序正确的关键**:推理块在工具标签之前收口,
        // 于是「这段推理 → 这次工具调用」的先后关系在 DOM 里成立
        closeThink();
        if (answer) { answer.classList.remove('streaming'); answer = null; }

        const tag = document.createElement('div');
        tag.className = 'tool running';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '●';
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = name;
        const sm = document.createElement('span');
        sm.className = 'sum';
        sm.textContent = '执行中…';
        tag.append(dot, nm, sm);
        wrap.appendChild(tag);
        tools.set(id, tag);
        follow();
      },

      toolEnd(id, ok, summary) {
        const tag = tools.get(id);
        if (!tag) return;   // 没配上就跳过,不要让展示层的意外影响别的渲染
        tag.className = `tool ${ok ? 'ok' : 'fail'}`;
        tag.querySelector('.dot').textContent = ok ? '✓' : '✕';
        const sm = tag.querySelector('.sum');
        sm.textContent = summary || (ok ? '完成' : '失败');
        sm.title = summary || '';   // 截断了,悬停看全文
        follow();
      },

      /**
       * 本轮结束
       *
       * `answer` 是兜底所需:收尾调用(wrapUp)不走流式、no_response 没有正文,
       * 这两条路径下事件流里一个 content 都没有,最终答案只在返回值里。
       */
      done(stopReason, finalAnswer) {
        // 兜底:模型只推理不给正文就结束时(no_response),
        // 那一块仍然摊着、还带着流式的样子
        closeThink();

        if (answer) {
          answer.classList.remove('streaming');
          // 到这里才做 Markdown:流式期间是纯文本追加(见 content 注释)。
          // 渲染器只构造 DOM 节点、不碰 innerHTML,所以不需要额外消毒
          answer.classList.add('md');
          md.into(answer, buf);
        }

        if (!answer && finalAnswer) {
          // 兜底路径:收尾调用(wrapUp)不走流式、no_response 没有正文,
          // 这两种情况事件流里一个 content 都没有,答案只在返回值里
          const n = document.createElement('div');
          n.className = 'answer md';
          md.into(n, finalAnswer);
          wrap.appendChild(n);
        }

        if (stopReason === 'max_steps') {
          note(wrap, '达到步数上限后收尾,结论可能不完整。');
        } else if (stopReason === 'no_response') {
          note(wrap, '模型未返回有效内容。', true);
        } else if (stopReason === 'truncated') {
          // 必须说出原因和**具体改哪一项**:被截断的回答与正常回答同形
          // (有正文、无工具调用),不提示的话只表现成「话说到一半就没了」,
          // 而设置里那个数值框是唯一的解释
          note(wrap, '回答被「单次生成上限」截断,内容不完整。可在设置里调大该值。', true);
        } else if (stopReason === 'aborted') {
          // **不标红**:中断是用户自己要求的,不是故障。
          // 标红会让人以为「停止」这个动作出了错
          note(wrap, '已停止。');
        }
        // 收尾无条件滚到底:这里是本轮的结论,即使用户翻上去了也该带他回来
        scrollToBottom();
      },

      fail(message) {
        if (answer) answer.classList.remove('streaming');
        note(wrap, message, true);
        scrollToBottom();
      },
    };
  }

  function note(parent, text, isError) {
    const n = document.createElement('div');
    n.className = 'notice' + (isError ? ' error' : '');
    n.textContent = text;
    parent.appendChild(n);
  }

  /**
   * 往消息流里留一条系统提示(配置已更新之类)
   *
   * 必须包一层 .msg:裸的 .notice 会通栏显示、与对话内容对不齐
   * (max-width 和居中都在 .msg 上)。
   *
   * 为什么用消息流而不是按钮上的临时文字:重建会话现在很快(浏览器已提到
   * 进程级、不再重启 chromium),按钮上那行「正在应用…」一闪而过看不见 ——
   * 实测就是这样。留在流里的痕迹不依赖用户恰好在看某个位置。
   */
  function streamNote(text, isError) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    note(wrap, text, isError);
    els.stream.appendChild(wrap);
    scrollToBottom();
  }

  // ---------- 历史渲染 ----------
  //
  // 与流式渲染是**两套**,不复用:流式要处理增量、reset、未闭合状态,
  // 历史是一次性画完的静态内容。硬凑成一套只会让两边互相将就。
  //
  // 显示的是**完整原始对话**(turns.jsonl),不是压缩后的上下文 ——
  // 模型请求走压缩那套,两条路分开。

  /** 消息内容可能是字符串或图文混排块,统一摊平成文字 */
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(p => (p.type === 'text' ? p.text : `[图片 ${p.label || ''}]`))
        .join('');
    }
    return '';
  }

  /** 画一轮历史。位置约定与 core 一致:messages[0] 是提问,末尾不带 toolCalls 的 assistant 是答案 */
  function renderHistoryTurn(turn) {
    const msgs = turn.messages || [];
    if (msgs.length === 0) return;

    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    bubble.textContent = textOf(msgs[0].content);
    els.stream.appendChild(bubble);

    const wrap = document.createElement('div');
    wrap.className = 'msg';
    els.stream.appendChild(wrap);

    // 中间过程:模型调过哪些工具。历史里没有成败(那只在事件流里),
    // 所以用中性样式,不画成绿勾或红叉 —— 那会是编造的信息
    for (const m of msgs.slice(1)) {
      for (const tc of m.toolCalls || []) {
        const tag = document.createElement('div');
        tag.className = 'tool';
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = tc.name;
        tag.appendChild(nm);
        wrap.appendChild(tag);
      }
    }

    // 最终回答:最后一条不带 toolCalls 的 assistant
    const finals = msgs.filter(m => m.role === 'assistant' && !(m.toolCalls || []).length);
    const last = finals[finals.length - 1];
    if (last) {
      const ans = document.createElement('div');
      ans.className = 'answer md';
      // 历史也走 Markdown —— 否则同一段回答「当时看着是排版好的、
      // 重开会话变成纯文本」,而用户会以为历史存坏了
      md.into(ans, textOf(last.content));
      wrap.appendChild(ans);
    }
  }

  // ---------- 事件分发 ----------
  //
  // 与 AgentEvent 一一对应(orchestrator.ts)。default 不静默丢弃:
  // core 加了新事件类型而这里没跟上时,至少 console 里能看见
  function dispatch(turn, ev) {
    switch (ev.type) {
      case 'reasoning':  turn.reasoning(ev.text); break;
      case 'content':    turn.content(ev.text); break;
      case 'reset':      turn.reset(); break;
      case 'step':       turn.step(ev.step, ev.maxSteps); break;
      case 'tool_start': turn.toolStart(ev.id, ev.name); break;
      case 'tool_end':   turn.toolEnd(ev.id, ev.ok, ev.summary); break;
      case 'done':       break;   // 由 transport 在拿到最终答案后调 turn.done
      default:           console.warn('未识别的事件类型', ev);
    }
  }

  // ---------- 发送 ----------
  let busy = false;

  function setBusy(v) {
    busy = v;
    els.send.hidden = v;
    els.stop.hidden = !v;
    els.input.disabled = v;
    if (!v) els.input.focus();
  }

  async function submit() {
    const text = els.input.value.trim();
    if (!text || busy) return;

    const empty = els.stream.querySelector('.empty');
    if (empty) empty.remove();

    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    bubble.textContent = text;
    els.stream.appendChild(bubble);

    // 发送即归位,**无条件**滚到底(不走 follow)。
    //
    // 用 follow 的话:用户翻上去看旧内容、然后直接在输入框打字发送,
    // 视口会停在原处 —— 自己刚发的那条在屏幕外,看起来像「发送没反应」。
    // 主动发消息就是明确表达了「我要看接下来发生什么」,这时拽回底部不算打扰。
    scrollToBottom();

    els.input.value = '';
    els.input.style.height = 'auto';
    setBusy(true);

    const turn = newTurn();
    try {
      // transport 由 mock.js(原型)或 sse.js(接上 server 后)提供。
      // 契约只有两条:逐个吐 AgentEvent,最后 resolve 出 { stopReason, answer }
      const result = await window.AgentTransport.run(text, ev => dispatch(turn, ev));
      turn.done(result.stopReason, result.answer);
    } catch (e) {
      turn.fail(`执行失败: ${e && e.message ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  els.send.addEventListener('click', submit);
  els.stop.addEventListener('click', () => window.AgentTransport.abort?.());

  els.input.addEventListener('keydown', e => {
    // Shift+Enter 换行,Enter 发送。输入法组字过程中的 Enter 不能当发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  // 随内容长高,到 max-height 为止
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
  });

  // ---------- 确认对话框 ----------
  //
  // `run_command` 全部的安全性就是用户读那一行命令。所以这里:
  // 命令**原样**呈现(pre + textContent,不转义不折行)、默认焦点在「拒绝」、
  // Esc 等于拒绝。任何「顺手点过去」的设计都会让这道边界静默消失。
  window.AgentConfirm = {
    ask(req) {
      return new Promise(resolve => {
        const mask = $('confirm-mask');
        const body = $('confirm-body');
        $('confirm-title').textContent = `确认执行 ${req.toolName}`;

        body.textContent = req.toolName === 'run_command' && req.args && req.args.command
          ? String(req.args.command)
          : JSON.stringify(req.args, null, 2);

        mask.hidden = false;
        $('btn-deny').focus();

        const finish = ok => {
          mask.hidden = true;
          document.removeEventListener('keydown', onKey);
          resolve(ok);
        };
        const onKey = e => { if (e.key === 'Escape') finish(false); };

        $('btn-allow').onclick = () => finish(true);
        $('btn-deny').onclick = () => finish(false);
        document.addEventListener('keydown', onKey);
      });
    },
  };

  // ---------- 窗口按钮 ----------
  //
  // 只在 Electron 里有意义。浏览器里打开时整组隐藏 ——
  // 留着三个点不动的按钮比没有更糟。
  // 判断 **AgentBridge** 而不是在 bridge.js 里包一层:后者要等 bridge.js 执行,
  // 而脚本顺序是 app.js → bridge.js —— 于是这里永远走 else,按钮被整组隐藏。
  // (实测踩到:按钮压根不出现。AgentBridge 由 preload 注入,页面脚本执行前就有)
  if (window.AgentBridge) {
    const w = window.AgentBridge;
    $('btn-min').addEventListener('click', () => w.minimize());
    $('btn-close').addEventListener('click', () => w.close());

    const maxBtn = $('btn-max');
    // 图标随状态切换:E922 是「最大化」,E923 是「还原」。
    // 不切的话最大化之后按钮仍显示「最大化」,用户不知道点了会发生什么
    const syncMaxIcon = maximized => {
      maxBtn.textContent = maximized ? '' : '';
      maxBtn.title = maximized ? '还原' : '最大化';
    };
    maxBtn.addEventListener('click', async () => {
      syncMaxIcon(await w.toggleMaximize());
    });
    // 双击标题栏也能最大化(系统习惯),状态要跟着变
    document.querySelector('.bar').addEventListener('dblclick', async e => {
      if (e.target.closest('.win-btns, .icon-btn')) return;
      syncMaxIcon(await w.toggleMaximize());
    });
    void w.isMaximized().then(syncMaxIcon);
  } else {
    const btns = document.querySelector('.win-btns');
    if (btns) btns.hidden = true;
  }

  // ---------- 配置抽屉 ----------
  const drawer = $('drawer');
  const mask = $('drawer-mask');
  const openCfg = () => { drawer.hidden = false; mask.hidden = false; };
  const closeCfg = () => { drawer.hidden = true; mask.hidden = true; };

  $('btn-config').addEventListener('click', openCfg);
  $('btn-close-config').addEventListener('click', closeCfg);
  mask.addEventListener('click', closeCfg);

  // shell 的实际生效是三个条件的合成(shell.enabled && workspace && allowDangerousTools)。
  // 界面上是三个开关,所以必须把「你开了但没生效」说出来 —— 否则用户只会觉得开关坏了
  function syncShellHint() {
    const on = $('cfg-shell').checked;
    const ok = $('cfg-danger').checked && !!$('cfg-workspace').value;
    $('shell-hint').textContent = on && !ok
      ? '(需同时勾选「允许危险工具」并选好工作区才会生效)'
      : '';
  }
  ['cfg-shell', 'cfg-danger'].forEach(id =>
    $(id).addEventListener('change', syncShellHint));

  // 「需要重建会话」的提示原先只在选工作区时露出来(applyWorkspace 里)。
  // 但**每一项**都要重建会话才生效 —— 运行参数尤其看不出来:
  // 改了 maxSteps 却以为立刻生效,下一轮还是旧预算,而这没有任何反馈。
  // 用 input 而非 change:数字框里边打字边看到提示,不必等失焦
  ['cfg-maxtokens', 'cfg-maxsteps'].forEach(id =>
    $(id).addEventListener('input', () => { $('restart-hint').hidden = false; }));
  ['cfg-thinking', 'cfg-python', 'cfg-danger', 'cfg-shell', 'cfg-subagent', 'cfg-memory']
    .forEach(id =>
      $(id).addEventListener('change', () => { $('restart-hint').hidden = false; }));

  $('btn-pick').addEventListener('click', async () => {
    // **不能用 window.prompt()**:Electron 刻意没实现它 —— 调用后什么都不发生
    // 且不报错,表现成「按钮点了没反应」(实测踩到,这里原先就是 prompt)。
    //
    // 原生对话框还顺带解决了纯网页拿不到绝对路径这个问题
    // (webkitdirectory 只给相对路径、showDirectoryPicker 只给 handle),
    // 而 workspace 必须是绝对路径 —— 填错的后果是所有文件类工具静默全拒
    const picked = await window.AgentBridge?.pickDirectory();
    if (!picked) return;      // 用户取消
    $('cfg-workspace').value = picked;
    applyWorkspace(picked);
    syncShellHint();
  });

  function applyWorkspace(p) {
    els.wsLabel.textContent = p || '未选择工作区';
    $('ws-warn').hidden = !!p;
    $('restart-hint').hidden = false;
  }

  /**
   * 数值输入框 → 存储值
   *
   * 空 = null(删掉这一项,回落到 .env / 默认),不是 0 ——
   * 0 是个合法数字,存进去会被当成「用户就要 0」,而 maxSteps=0
   * 表现成「主循环一步不走就返回 max_steps」,看起来像卡死。
   *
   * 非法输入(number 输入框仍可粘进文字)也回落 null,由后端校验兜底:
   * 这里返回 NaN 的话 JSON 序列化会变成 null,行为一样但意图不明确
   */
  function numOrNull(id) {
    const raw = $(id).value.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  $('btn-save').addEventListener('click', async () => {
    const patch = {
      apiKey: $('cfg-key').value || undefined,   // 留空 = 不修改
      baseURL: $('cfg-baseurl').value,
      model: $('cfg-model').value,
      visionModel: $('cfg-vision').value,
      workspace: $('cfg-workspace').value,
      pythonEnabled: $('cfg-python').checked,
      allowDangerousTools: $('cfg-danger').checked,
      shellEnabled: $('cfg-shell').checked,
      subAgentEnabled: $('cfg-subagent').checked,
      memoryEnabled: $('cfg-memory').checked,
      maxTokens: numOrNull('cfg-maxtokens'),
      maxSteps: numOrNull('cfg-maxsteps'),
      enableThinking: $('cfg-thinking').checked,
    };

    // 保存要重建会话(检依赖、起工具桥)。禁用按钮不只是为了好看:
    // 重复点会并发触发多次装配 —— 那正是「两个 chromium 抢同一个 profile」
    // 那个 bug 的触发条件
    const btn = $('btn-save');
    btn.disabled = true;

    try {
      await window.AgentConfigApi?.save(patch);
      $('cfg-key').value = '';    // 明文不留在 DOM 里
      closeCfg();
      // 结果留在消息流里,不做按钮上的临时文字:重建现在很快
      // (浏览器已提到进程级、不再重启 chromium),按钮上那行字一闪而过看不见
      streamNote('配置已更新,会话已重建。');
    } catch (e) {
      // 失败必须说出来:静默的话用户以为存上了,而实际跑的还是旧配置
      streamNote(`配置保存失败: ${e && e.message ? e.message : String(e)}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 历史侧边栏 ----------
  let activeSessionId = null;

  /** 清空对话区,回到「空会话」的样子 */
  function clearStream() {
    els.stream.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'empty';
    hint.textContent = '描述你要做的事,agent 会自己决定用什么工具。';
    els.stream.appendChild(hint);
    // 清空后必须同步按钮:内容从「很长且翻在中间」变成一句提示,
    // 而 scroll 事件在内容缩短时不保证触发 —— 漏掉就是空会话上挂着一个
    // 点了没反应的「回到底部」
    syncToBottomBtn();
  }

  /** 把一份历史画进对话区 */
  function showHistory(sessionId, turns) {
    activeSessionId = sessionId;
    els.stream.textContent = '';
    if (!turns || turns.length === 0) {
      clearStream();
    } else {
      for (const t of turns) renderHistoryTurn(t);
      // 打开历史落在最新一轮:那是用户要接着聊的地方,而不是几十轮之前
      scrollToBottom();
    }
    markActive();
  }

  function markActive() {
    for (const el of els.sideList.querySelectorAll('.side-item')) {
      el.classList.toggle('active', el.dataset.id === activeSessionId);
    }
  }

  /** 刷新侧边栏列表 */
  async function refreshSidebar() {
    const api = window.AgentHistory;
    if (!api) return;

    let list = [];
    try {
      list = await api.list();
    } catch {
      // 列不出来不影响聊天,只是侧边栏空着
    }

    els.sideList.textContent = '';
    if (list.length === 0) {
      const p = document.createElement('div');
      p.className = 'side-empty';
      p.textContent = '还没有历史对话';
      els.sideList.appendChild(p);
      return;
    }

    for (const s of list) {
      const item = document.createElement('button');
      item.className = 'side-item';
      item.dataset.id = s.sessionId;
      item.title = s.title;
      item.textContent = s.title;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${s.turnCount} 轮 · ${fmtTime(s.updatedAt)}`;
      item.appendChild(meta);

      item.addEventListener('click', async () => {
        if (busy || s.sessionId === activeSessionId) return;
        // 换会话要重建 agent(起 chromium、建 venv),几秒 —— 先给个反馈
        item.classList.add('active');
        const r = await api.open(s.sessionId);
        showHistory(r.sessionId, r.turns);
      });

      els.sideList.appendChild(item);
    }
    markActive();
  }

  /** 相对时间。侧边栏空间小,「3 分钟前」比完整时间戳有用 */
  function fmtTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    return new Date(ms).toLocaleDateString('zh-CN');
  }

  $('btn-new').addEventListener('click', async () => {
    const api = window.AgentHistory;
    if (!api || busy) return;
    const r = await api.newSession();
    showHistory(r.sessionId, []);
    await refreshSidebar();
  });

  // ---------- 启动 ----------
  window.AgentApp = {
    /** 由 transport 在拿到会话信息后调用,填充界面 */
    hydrate(info) {
      applyWorkspace(info.workspace || '');
      $('restart-hint').hidden = true;
      $('cfg-baseurl').value = info.baseURL || '';
      $('cfg-model').value = info.model || '';
      $('cfg-vision').value = info.visionModel || '';
      $('cfg-workspace').value = info.workspace || '';
      $('cfg-python').checked = !!info.pythonEnabled;
      $('cfg-danger').checked = !!info.allowDangerousTools;
      // 回填**用户勾的那个原始值**,不是合成后的生效值。
      // 用 shellEnabled(合成值)的话会静默丢配置:勾了 shell 但没勾
      // 「允许危险工具」时,面板显示未勾选,用户下次保存就把自己存的
      // true 写成了 false —— 而这个过程没有任何提示
      $('cfg-shell').checked = info.shellConfigured !== undefined
        ? !!info.shellConfigured
        : !!info.shellEnabled;   // 兼容旧的 info(只有合成值那份)
      $('cfg-subagent').checked = !!info.subAgentEnabled;
      $('cfg-memory').checked = !!info.memoryEnabled;
      $('cfg-key').placeholder = info.apiKeyMasked || '(未配置)';

      // 运行参数回填的是**实际生效值**,而 placeholder 写的是默认值 ——
      // 两者要能区分:输入框有值 = 显式配过,空 = 走默认。
      // maxTokens 未配时 info 里是 undefined(不是 0),所以用 != null:
      // 真值判断会把合法的 0 也当成没配,而那正是最该看见的错值
      $('cfg-maxtokens').value = info.maxTokens != null ? info.maxTokens : '';
      $('cfg-maxsteps').value = info.maxSteps != null ? info.maxSteps : '';
      $('cfg-thinking').checked = info.enableThinking !== false;   // 默认开

      syncShellHint();
    },

    /** 装配期告警 —— 与 CLI 的 session.notices 同一份东西 */
    notices(list) {
      for (const n of list || []) {
        const wrap = document.createElement('div');
        wrap.className = 'msg';
        note(wrap, n.hint ? `${n.message}  ${n.hint}` : n.message, n.level === 'error');
        els.stream.appendChild(wrap);
      }
    },

    /**
     * 载入当前会话的历史并刷新侧边栏
     *
     * 由 bridge.js 在会话就绪 / 会话切换后调用。放在这里而不是让 bridge
     * 直接操作 DOM —— 渲染归 app.js,传输归 bridge.js
     */
    async loadHistory() {
      const api = window.AgentHistory;
      if (!api) return;
      try {
        const r = await api.current();
        // 只在真有历史时重画:空会话保留「描述你要做的事」那句提示,
        // 也避免把用户刚发出的第一条消息擦掉
        if (r.turns && r.turns.length > 0) showHistory(r.sessionId, r.turns);
        else activeSessionId = r.sessionId;
      } catch {
        // 读不出来不影响聊天
      }
      await refreshSidebar();
    },

    /** 一轮结束后刷新列表 —— 新会话的第一轮之后才会出现在里面 */
    refreshSidebar,
  };

  clearStream();
  els.input.focus();
})();
