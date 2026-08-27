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

  const els = {
    stream: $('stream'),
    input: $('input'),
    send: $('btn-send'),
    stop: $('btn-stop'),
    wsLabel: $('ws-label'),
  };

  // ---------- 一轮的渲染状态 ----------
  //
  // 每轮新建。**不能提到模块作用域** —— 上一轮的 answer 节点留着,
  // 下一轮的正文就会续写到上一轮的气泡里(CLI 那边我刚踩过同类的坑:
  // streamed 标志泄漏导致回答整段消失)。
  function newTurn() {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    els.stream.appendChild(wrap);

    let think = null;      // <details> 思考过程
    let thinkBody = null;
    let answer = null;     // 正文节点
    const tools = new Map();   // id → 标签节点

    const atBottom = () =>
      els.stream.scrollHeight - els.stream.scrollTop - els.stream.clientHeight < 80;

    // 只在用户本来就贴着底部时才跟随。否则用户往上翻看历史会被一直拽回来
    const follow = () => { if (atBottom()) els.stream.scrollTop = els.stream.scrollHeight; };

    return {
      reasoning(text) {
        if (!think) {
          think = document.createElement('details');
          think.className = 'think';
          const sum = document.createElement('summary');
          sum.textContent = '思考过程';
          thinkBody = document.createElement('div');
          thinkBody.className = 'body';
          think.append(sum, thinkBody);
          wrap.appendChild(think);
        }
        thinkBody.textContent += text;
        // 展开时让思考内容自己也滚到底,否则要手动拖
        if (think.open) thinkBody.scrollTop = thinkBody.scrollHeight;
        follow();
      },

      content(text) {
        if (!answer) {
          answer = document.createElement('div');
          answer.className = 'answer streaming';
          wrap.appendChild(answer);
        }
        // textContent 而非 innerHTML:模型的输出是不可信文本,
        // 里面完全可能有 <script> 或从网页抓来的 HTML 片段
        answer.textContent += text;
        follow();
      },

      /** 重试:丢弃本步已收到的全部增量 */
      reset() {
        if (thinkBody) thinkBody.textContent = '';
        if (answer) { answer.remove(); answer = null; }
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = '(重试,重新生成…)';
        wrap.appendChild(n);
        follow();
      },

      step(step, maxSteps) {
        // 第一步不报:刚点发送就跳「第 1 步」是噪音
        if (step <= 1) return;
        const n = document.createElement('div');
        n.className = 'step-sep';
        n.textContent = `第 ${step} / ${maxSteps} 步`;
        wrap.appendChild(n);
        follow();
      },

      toolStart(id, name) {
        // 工具要跑了 —— 本步的正文到此结束,收掉光标
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
        if (answer) answer.classList.remove('streaming');

        if (!answer && finalAnswer) {
          const n = document.createElement('div');
          n.className = 'answer';
          n.textContent = finalAnswer;
          wrap.appendChild(n);
        }

        if (stopReason === 'max_steps') {
          note(wrap, '达到步数上限后收尾,结论可能不完整。');
        } else if (stopReason === 'no_response') {
          note(wrap, '模型未返回有效内容。', true);
        }
        els.stream.scrollTop = els.stream.scrollHeight;
      },

      fail(message) {
        if (answer) answer.classList.remove('streaming');
        note(wrap, message, true);
        els.stream.scrollTop = els.stream.scrollHeight;
      },
    };
  }

  function note(parent, text, isError) {
    const n = document.createElement('div');
    n.className = 'notice' + (isError ? ' error' : '');
    n.textContent = text;
    parent.appendChild(n);
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

  $('btn-pick').addEventListener('click', async () => {
    // 原型阶段先用输入框顶着。接上 server 后换成 /dirs 目录浏览:
    // 纯网页拿不到绝对路径(webkitdirectory 只给相对路径、
    // showDirectoryPicker 只给 handle),而 workspace 必须是绝对路径 ——
    // 所以由 Node 侧列目录、前端点着选
    const v = prompt('工作区绝对路径', $('cfg-workspace').value || '');
    if (v !== null) {
      $('cfg-workspace').value = v.trim();
      applyWorkspace(v.trim());
      syncShellHint();
    }
  });

  function applyWorkspace(p) {
    els.wsLabel.textContent = p || '未选择工作区';
    $('ws-warn').hidden = !!p;
    $('restart-hint').hidden = false;
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
    };
    await window.AgentConfigApi?.save(patch);
    $('cfg-key').value = '';    // 明文不留在 DOM 里
    closeCfg();
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
      $('cfg-shell').checked = !!info.shellEnabled;
      $('cfg-subagent').checked = !!info.subAgentEnabled;
      $('cfg-memory').checked = !!info.memoryEnabled;
      $('cfg-key').placeholder = info.apiKeyMasked || '(未配置)';
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
  };

  const hint = document.createElement('div');
  hint.className = 'empty';
  hint.textContent = '描述你要做的事,agent 会自己决定用什么工具。';
  els.stream.appendChild(hint);
  els.input.focus();
})();
