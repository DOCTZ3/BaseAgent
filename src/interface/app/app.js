// ============================================
// 客户端渲染层 —— 把 AgentEvent 流画成界面
// ============================================
//
// **这份代码是最终要用的那份**,不是一次性的 mockup。它只依赖一个东西:
// 一个能吐 AgentEvent 的传输。原型阶段由 mock.js 提供假事件流(file:// 双击可看),
// 接上 server 之后换成 SSE —— 下面的渲染代码一行不改。
//
// app 渲染只处理 DOM,不承接终端式擦除/样式复位逻辑。
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

  /** 距底 80px 以内算「贴着底部」。给余量是因为流式期间高度一直在变 */
  const BOTTOM_SLACK = 80;
  const THINK_SLACK = 24;
  let activeThinkBox = null;

  const onNextFrame = fn => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
    else setTimeout(fn, 0);
  };

  const atScrollEnd = (node, slack) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= slack;

  const atBottom = () => atScrollEnd(els.stream, BOTTOM_SLACK);

  function currentThinkBox() {
    if (activeThinkBox && !activeThinkBox.isConnected) activeThinkBox = null;
    return activeThinkBox;
  }

  function scrollElementToBottom(node) {
    node.scrollTop = node.scrollHeight;
    onNextFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }

  function scrollStreamToBottom() {
    scrollElementToBottom(els.stream);
    syncToBottomBtn();
    onNextFrame(syncToBottomBtn);
  }

  /** 无条件滚到底,并同步按钮 */
  function scrollToBottom() {
    const box = currentThinkBox();
    if (box) scrollElementToBottom(box);
    scrollStreamToBottom();
  }

  /** 只在用户本来就贴着底部时才跟随。调用方要传入 DOM 更新前的快照。 */
  function follow(wasAtBottom = atBottom()) {
    if (wasAtBottom) scrollStreamToBottom();
    else syncToBottomBtn();
  }

  function activeThinkBehind() {
    const box = currentThinkBox();
    return !!box && !atScrollEnd(box, THINK_SLACK);
  }

  /** 按钮只在往上翻走之后出现:贴底时它没用,常驻会挡住右下角的正文 */
  function syncToBottomBtn() {
    if (els.toBottom) els.toBottom.hidden = atBottom() && !activeThinkBehind();
  }

  /** 推理块自己也是滚动区,不能只滚外层 .stream。详见 pitfalls.md。 */
  function followThink(box, wasAtBottom = atScrollEnd(box, THINK_SLACK)) {
    if (wasAtBottom) scrollElementToBottom(box);
  }

  els.stream.addEventListener('scroll', syncToBottomBtn);
  els.toBottom?.addEventListener('click', () => {
    scrollToBottom();
  });

  // ---------- 一轮的渲染状态 ----------
  function newTurn() {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    els.stream.appendChild(wrap);

    // 一轮一份状态;推理按步分块,否则会错置推理与工具调用的因果顺序。
    let think = null;      // 当前步的推理块 { el, sum, body, node, text }
    let answer = null;     // 正文节点
    let answerText = null; // 流式期间只追加文本节点,避免长回答反复重写整段 DOM
    let buf = '';          // 正文原文。done 时用它做一次性 Markdown 渲染
    const tools = new Map();   // id → 标签节点

    /** 短推理的字数上限 —— 到此为止不给折叠块 */
    const THINK_FLAT = 80;

    /** 收掉当前推理块:工具开始、正文开始、进入下一步、本轮结束时都要调。 */
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
      if (activeThinkBox === think.body) activeThinkBox = null;
      think = null;   // 置空是关键:下一段推理会新建块,于是顺序天然对上
    }

    return {
      reasoning(text) {
        const wasStreamAtBottom = atBottom();
        let wasThinkAtBottom = true;
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
          body.addEventListener('scroll', syncToBottomBtn);
          const node = document.createTextNode('');
          body.appendChild(node);
          el.append(sum, body);
          wrap.appendChild(el);
          think = { el, sum, body, node, text: '' };
          activeThinkBox = body;
        } else {
          wasThinkAtBottom = atScrollEnd(think.body, THINK_SLACK);
        }
        think.text += text;
        think.node.appendData(text);
        // 两个滚动区都要跟:外层 .stream 和推理块**自己**那个 300px 的窗口。
        // 只跟外层就是「还在跑却滚不下去」那个 bug(见 followThink 的注释)
        followThink(think.body, wasThinkAtBottom);
        follow(wasStreamAtBottom);
      },

      content(text) {
        const wasStreamAtBottom = atBottom();
        if (!answer) {
          // 正文开始 = 本步推理结束,先把上面那块收掉
          closeThink();
          answer = document.createElement('div');
          answer.className = 'answer streaming';
          answerText = document.createTextNode('');
          answer.appendChild(answerText);
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
        answerText.appendData(text);
        follow(wasStreamAtBottom);
      },

      /** 重试:丢弃本步已收到的全部增量 */
      reset() {
        const wasStreamAtBottom = atBottom();
        // 整块删掉而不是清空文本:重试会从头再说一遍,留着空块
        // 会在页面上攒下一串空壳
        if (think) {
          if (activeThinkBox === think.body) activeThinkBox = null;
          think.el.remove();
          think = null;
        }
        // buf 必须跟着清:不清的话重试后的正文会拼在上一次那半截后面,
        // 而 done 渲染的是 buf —— 用户看到同一段话说了两遍
        buf = '';
        if (answer) { answer.remove(); answer = null; answerText = null; }
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = '(重试,重新生成…)';
        wrap.appendChild(n);
        follow(wasStreamAtBottom);
      },

      step(step, maxSteps) {
        const wasStreamAtBottom = atBottom();
        // 新的一步开始 —— 上一步的推理块到此为止(哪怕没有工具调用)
        closeThink();
        // 第一步不报:刚点发送就跳「第 1 步」是噪音
        if (step <= 1) {
          follow(wasStreamAtBottom);
          return;
        }
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = `第 ${step} / ${maxSteps} 步`;
        wrap.appendChild(n);
        follow(wasStreamAtBottom);
      },

      toolStart(id, name) {
        const wasStreamAtBottom = atBottom();
        // 工具要跑了 —— 本步的推理和正文都到此结束。
        // **这一处是顺序正确的关键**:推理块在工具标签之前收口,
        // 于是「这段推理 → 这次工具调用」的先后关系在 DOM 里成立
        closeThink();
        if (answer) {
          answer.classList.remove('streaming');
          answer = null;
          answerText = null;
        }

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
        follow(wasStreamAtBottom);
      },

      toolEnd(id, ok, summary) {
        const wasStreamAtBottom = atBottom();
        const tag = tools.get(id);
        if (!tag) return;   // 没配上就跳过,不要让展示层的意外影响别的渲染
        tag.className = `tool ${ok ? 'ok' : 'fail'}`;
        tag.querySelector('.dot').textContent = ok ? '✓' : '✕';
        const sm = tag.querySelector('.sum');
        sm.textContent = summary || (ok ? '完成' : '失败');
        sm.title = summary || '';   // 截断了,悬停看全文
        follow(wasStreamAtBottom);
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
          answerText = null;
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
        answerText = null;
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
    lockSwitching(v);
    if (!v) els.input.focus();
  }

  /**
   * 执行期间锁住所有会重建会话的入口
   *
   * 为什么这不只是"体验问题":switchSession() / restart() 都会
   * dispose() 掉当前会话 —— 关掉 DB 句柄、停掉工具桥 —— 而
   * agent:run 刻意持有局部的 session 引用,那一轮会继续跑在被拆掉的
   * 实例上,表现成任务半途开始报一串莫名的工具失败。
   *
   * 原先侧边栏和"新对话"是 `if (busy) return` 静默拦下(所以现象是
   * 点了没反应),而保存按钮**压根没拦** —— 那是真正暴露这条路的口子。
   *
   * 用 class 而不是 disabled 属性:侧边栏那些会话是 <button>,
   * 逐个 disabled 要在每次 refreshSidebar() 之后重新打一遍标记,
   * 漏一次就又能点进去了。挂在容器上则天然覆盖后来渲染的子项。
   */
  function lockSwitching(v) {
    els.sideList.classList.toggle('locked', v);
    $('btn-new').classList.toggle('locked', v);
    $('busy-lock-hint').hidden = !v;

    // 保存会走 restart() → 同一套 dispose()
    $('btn-save').disabled = v;
    $('save-busy-hint').hidden = !v;
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

  $('btn-open-data').addEventListener('click', async () => {
    await window.AgentBridge?.openUserDataDir?.();
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

  // ---------- 技能库 ----------
  //
  // 这个面板只做一件事:让用户在一条技能进入提示词索引**之前**读清它。
  //
  // 为什么必须人工过一遍:抽取模型写出「知乎相关操作」这种描述时,这条技能
  // 等于不存在 —— 模型永远不会选它,而没有任何自动信号能发现这件事。
  // 更糟的是描述写得响亮但轨迹是错的:它会被选中,然后误导模型。
  // 两种坏结果都只有人读一眼才能发现,所以审批不能省、也不能做成
  // 消息流里随手点过的卡片。

  const skillDrawer = $('skill-drawer');
  const skillMask = $('skill-mask');
  const skillBody = $('skill-body');
  const skillBadge = $('skill-badge');

  /** 上一次拉到的列表。开抽屉时先画它,避免面板空一下再跳出内容 */
  let skillCache = [];

  const openSkills = () => {
    skillDrawer.hidden = false;
    skillMask.hidden = false;
    void refreshSkills();   // 开的时候拉一次:后台可能刚沉淀了新的
  };
  const closeSkills = () => {
    skillDrawer.hidden = true;
    skillMask.hidden = true;
    // 生效提示只属于「刚审批完」这个时刻。留着的话下次打开抽屉它还挂在那儿,
    // 而那时你什么都没审 —— 一条不对应任何动作的提示比没有更让人疑惑
    $('skill-apply-hint').hidden = true;
  };

  $('btn-skills').addEventListener('click', openSkills);
  $('btn-close-skills').addEventListener('click', closeSkills);
  skillMask.addEventListener('click', closeSkills);

  /**
   * 角标 = **待审批**条数,不是总条数
   *
   * 显示总数的话已启用的技能会让角标永远亮着,而角标的唯一意义是
   * 「有东西等你处理」—— 常亮就等于没有。
   */
  function syncSkillBadge() {
    const n = skillCache.filter(s => s.pending).length;
    skillBadge.hidden = n === 0;
    skillBadge.textContent = String(n);
  }

  /** 一行灰字。技能库没启用、拉不到、空库都走它 —— 空面板会让人以为界面坏了 */
  function skillEmpty(text) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = text;
    return p;
  }

  function renderSkillCard(s) {
    const card = document.createElement('div');
    card.className = 'skill-card' + (s.pending ? ' pending' : '');

    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = s.name;

    // 新增 / 更新 必须分得出来。
    //
    // 不标的话待审列表里「在已有轨迹上改出来的」和「全新的」长得一模一样,
    // 于是看到相似的两条只能猜、然后干脆都不批(实测就是这样:
    // 用户以为只有新建机制,把一条更新当成了重复条目)。
    //
    // createdAt !== updatedAt 即更新:新条目这两个值由 mergeSkillExtraction
    // 用同一个 now 写入,而更新分支只动 updatedAt、保留原本的 createdAt
    const isUpdate = s.createdAt !== s.updatedAt;
    const tag = document.createElement('span');
    tag.className = 'skill-tag ' + (isUpdate ? 'upd' : 'new');
    tag.textContent = isUpdate ? '更新' : '新增';
    tag.title = isUpdate
      ? '在已有轨迹上改写,原条目的取用次数已保留'
      : '这是一条新轨迹';
    name.appendChild(tag);

    card.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = s.description;
    card.appendChild(desc);

    // 步骤:goal 与 how 分层显示。
    // 混成一段的话审批时读不出「这一步要达成什么」和「当时怎么做的」——
    // 而 how 会过期、goal 不会,失效时模型正是据 goal 重新找路。
    // 所以 goal 写得含糊就是这条技能报废的信号,必须一眼能看出来。
    if (s.steps && s.steps.length) {
      const ol = document.createElement('ol');
      ol.className = 'skill-steps';
      for (const step of s.steps) {
        const li = document.createElement('li');
        li.textContent = step.goal;
        if (step.how) {
          const how = document.createElement('span');
          how.className = 'how';
          how.textContent = step.how;
          li.appendChild(how);
        }
        ol.appendChild(li);
      }
      card.appendChild(ol);
    }

    // 坑往往比正确路径值钱,所以不折叠
    if (s.pitfalls && s.pitfalls.length) {
      const ul = document.createElement('ul');
      ul.className = 'skill-pit';
      for (const p of s.pitfalls) {
        const li = document.createElement('li');
        li.textContent = p;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (s.note) {
      const note = document.createElement('div');
      note.className = 'skill-note';
      note.textContent = s.note;
      card.appendChild(note);
    }

    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    // hits 对**待审的更新条目**尤其要显示 —— 原先只给已启用的显示,
    // 而那恰好漏掉了最需要它的那一类:一条被取用过 12 次的轨迹改了内容,
    // 「12 次」正是你该不该批的主要依据(它证明模型真在用这条路)。
    //
    // 已启用条目的 hits 则是另一个信号:0 次且沉淀很久 = 描述没能让模型选中它,
    // 这是判断「该不该改描述」唯一的可见线索
    const parts = [];
    if (isUpdate) parts.push(`更新于 ${fmtTime(s.updatedAt)}`);
    parts.push(`沉淀于 ${fmtTime(s.createdAt)}`);
    if (!s.pending || isUpdate) parts.unshift(`已取用 ${s.hits} 次`);
    meta.textContent = parts.join(' · ');
    card.appendChild(meta);

    if (s.pending) card.appendChild(skillActions(s.name));
    return card;
  }

  /**
   * 通过 / 丢弃
   *
   * 「丢弃」用 danger 样式且写「丢弃」不写「删除」:reject 是把这条从库里
   * 抹掉、不可撤销(没有回收站),而它旁边就是「通过」—— 手滑的代价不对称。
   */
  function skillActions(name) {
    const acts = document.createElement('div');
    acts.className = 'skill-acts';

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '通过';

    const no = document.createElement('button');
    no.className = 'btn danger';
    no.textContent = '丢弃';

    // 两个按钮一起禁用:approve 会重画整个列表,期间再点另一个
    // 会对着一个即将被替换掉的 DOM 节点发第二次 IPC
    const run = async (fn, verb) => {
      ok.disabled = no.disabled = true;
      try {
        const r = await fn(name);
        if (r && r.ok === false) {
          streamNote(`技能${verb}失败: ${r.error}`, true);
          return;
        }
        // changed:false = 名字对不上或它本来就不是待审状态。
        // 不说出来的话用户只看到列表刷新了却什么都没变,以为点了没反应
        if (r && r.changed === false) {
          streamNote(`技能「${name}」状态已变,未做改动。`);
        }
        // 通过之后必须说清「什么时候才真的生效」。
        //
        // 技能索引在会话装配时拼进 system 消息就冻住了,之后没有任何路径
        // 会重算它 —— 而这是刻意的:system 消息是 prompt cache 前缀里最稳定的
        // 部分(实测命中率 60~77%),为一次审批重写它会让整段缓存失效。
        //
        // 不说的话表现成「审批通过了、界面显示已启用,模型却完全不用它」——
        // 而库里数据是对的、load_skill 也是通的,查起来会怀疑抽取、审批、
        // 权限所有环节,唯独不会怀疑那个静态字符串。
        //
        // 只在**通过**时提示:丢弃不涉及「何时生效」
        if (fn === window.AgentSkills.approve) {
          $('skill-apply-hint').hidden = false;
        }

        // 审批接口把新列表当返回值带回来了,直接用,省一次往返
        if (r && r.skills) applySkills(r.skills);
        else await refreshSkills();
      } catch (e) {
        streamNote(`技能${verb}失败: ${e && e.message ? e.message : String(e)}`, true);
      } finally {
        // 列表重画后这两个节点可能已经不在文档里了,解禁是给「没重画」那条路兜底
        ok.disabled = no.disabled = false;
      }
    };

    ok.addEventListener('click', () => void run(window.AgentSkills.approve, '通过'));
    no.addEventListener('click', () => void run(window.AgentSkills.reject, '丢弃'));

    acts.append(ok, no);
    return acts;
  }

  /** 把一份列表画进抽屉并同步角标 */
  function applySkills(list) {
    skillCache = list || [];
    syncSkillBadge();

    skillBody.textContent = '';
    if (skillCache.length === 0) {
      skillBody.appendChild(skillEmpty(
        '还没有技能。完成一个用了较多工具调用(或中途出过错)的任务后,会自动沉淀一条待审批的轨迹。',
      ));
      return;
    }

    // 待审批排在前面:那是唯一需要动作的一组
    const groups = [
      { title: '待审批', items: skillCache.filter(s => s.pending) },
      { title: '已启用', items: skillCache.filter(s => !s.pending) },
    ];

    for (const g of groups) {
      if (g.items.length === 0) continue;
      const box = document.createElement('div');
      box.className = 'skill-group';
      const h = document.createElement('h3');
      h.textContent = `${g.title} · ${g.items.length}`;
      box.appendChild(h);
      for (const s of g.items) box.appendChild(renderSkillCard(s));
      skillBody.appendChild(box);
    }
  }

  /** 拉一次技能列表。抽屉关着时也要拉 —— 角标得更新 */
  async function refreshSkills() {
    const api = window.AgentSkills;
    if (!api) return;   // mock 环境:没有这个能力

    let r;
    try {
      r = await api.list();
    } catch (e) {
      skillBadge.hidden = true;
      if (!skillDrawer.hidden) {
        skillBody.textContent = '';
        skillBody.appendChild(skillEmpty(
          `技能列表读取失败: ${e && e.message ? e.message : String(e)}`,
        ));
      }
      return;
    }

    // ok:false 是**正常状态**(用户没开这个功能),不是故障 ——
    // 所以呈现成一句说明,不走红色的错误样式
    if (r && r.ok === false) {
      skillBadge.hidden = true;
      if (!skillDrawer.hidden) {
        skillBody.textContent = '';
        skillBody.appendChild(skillEmpty(r.error || '技能库未启用'));
      }
      return;
    }

    applySkills(r && r.skills);
  }

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
      $('cfg-data-dir').value = info.userDataDir || '';
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

    /** 装配期告警 —— 来自 session.notices,壳只负责呈现 */
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

    /**
     * 刷新技能列表与角标
     *
     * 必须导出:bridge.js 收到 agent:skills-changed 推送时要调它,
     * 而沉淀是异步的(run() 返回之后才结束)—— 没有这条推送,
     * 刚沉淀的技能要等到下次开窗口才会出现在角标上。
     */
    refreshSkills,
  };

  clearStream();
  els.input.focus();
})();
