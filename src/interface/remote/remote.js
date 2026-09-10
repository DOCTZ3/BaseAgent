(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const MAX_ENABLED_SKILLS = 20;
  const state = {
    endpoint: localStorage.getItem('baseagent.remote.endpoint') || location.origin,
    token: localStorage.getItem('baseagent.remote.token') || '',
    eventAbort: null,
    currentRunId: '',
    currentAssistant: null,
    currentAnswer: null,
    currentAnswerRaw: '',
    currentReasoning: null,
    busy: false,
    pendingHistoryReload: false,
    activeSessionId: null,
    historyLoaded: false,
    configLoaded: false,
    skills: [],
    secrets: [],
    deletedSecrets: new Set(),
    mcpServers: [],
  };
  const md = window.AgentMarkdown ?? createFallbackMarkdown();

  $('endpoint').value = state.endpoint;

  function toast(text, isError = false) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 5200 : 2600);
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  function apiUrl(path) {
    return state.endpoint.replace(/\/+$/, '') + path;
  }

  async function request(path, options = {}) {
    const headers = {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(apiUrl(path), { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function pair() {
    const endpoint = $('endpoint').value.trim().replace(/\/+$/, '');
    const code = $('pair-code').value.replace(/\D/g, '').slice(0, 6);
    if (!endpoint || code.length !== 6) {
      toast('请填写电脑地址和 6 位配对码', true);
      return;
    }

    $('btn-pair').disabled = true;
    try {
      const res = await fetch(endpoint + '/pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, label: navigator.userAgent.slice(0, 80) }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || '配对失败');

      state.endpoint = endpoint || data.endpoint;
      state.token = data.token;
      localStorage.setItem('baseagent.remote.endpoint', state.endpoint);
      localStorage.setItem('baseagent.remote.token', state.token);
      $('endpoint').value = state.endpoint;
      $('pair-code').value = '';
      await connect();
    } catch (e) {
      toast(errorText(e), true);
    } finally {
      $('btn-pair').disabled = false;
    }
  }

  async function connect() {
    if (!state.token) return;
    $('pair-panel').hidden = true;
    $('app-panel').hidden = false;
    $('btn-disconnect').hidden = false;
    setStatus('正在连接...');

    await Promise.allSettled([loadInfo(), loadHistory(), loadHistoryList(), loadSkills()]);
    startEvents();
  }

  function disconnect() {
    state.eventAbort?.abort();
    state.eventAbort = null;
    state.token = '';
    state.activeSessionId = null;
    localStorage.removeItem('baseagent.remote.token');
    $('pair-panel').hidden = false;
    $('app-panel').hidden = true;
    $('btn-disconnect').hidden = true;
    setStatus('未连接');
  }

  async function loadInfo() {
    const info = await request('/api/info');
    setStatus(`${info.model || 'agent'} · ${info.workspace || '未选择工作区'}`);
  }

  async function loadHistory() {
    const data = await request('/api/history/current');
    renderCurrentHistory(data.sessionId, data.turns || []);
  }

  function renderCurrentHistory(sessionId, turns) {
    state.activeSessionId = sessionId || null;
    const stream = $('stream');
    stream.textContent = '';
    if (!turns.length) {
      appendTo(stream, 'div', 'msg system', '还没有对话。');
      scrollToBottom();
      highlightActiveHistory();
      return;
    }

    for (const turn of turns) {
      const user = userTextOfTurn(turn);
      const answer = answerTextOfTurn(turn);
      if (user) appendMessage('user', user);
      if (answer) appendMarkdownMessage('assistant', answer);
    }
    scrollToBottom();
    highlightActiveHistory();
  }

  async function loadHistoryList() {
    const box = $('history-list');
    if (!box) return;
    const list = await request('/api/history/list').catch(e => {
      box.textContent = '';
      appendTo(box, 'div', 'msg system', `历史读取失败: ${errorText(e)}`);
      return [];
    });
    state.historyLoaded = true;
    if (!Array.isArray(list)) return;
    renderHistoryList(list);
  }

  function renderHistoryList(list) {
    const box = $('history-list');
    box.textContent = '';
    if (!list.length) {
      appendTo(box, 'div', 'msg system', '还没有历史会话');
      return;
    }

    for (const item of list) {
      const btn = appendTo(box, 'button', 'history-item', '');
      btn.dataset.id = item.sessionId || '';
      appendTo(btn, 'span', 'history-title', item.title || item.sessionId || '未命名会话');
      appendTo(btn, 'span', 'history-meta', `${item.turnCount || 0} 轮 · ${fmtTime(item.updatedAt)}`);
      btn.addEventListener('click', async () => {
        if (state.busy || !item.sessionId || item.sessionId === state.activeSessionId) return;
        btn.disabled = true;
        try {
          const data = await request('/api/history/open', {
            method: 'POST',
            body: JSON.stringify({ sessionId: item.sessionId }),
          });
          renderCurrentHistory(data.sessionId, data.turns || []);
          switchTab('chat');
          await loadHistoryList();
        } catch (e) {
          toast(`打开历史失败: ${errorText(e)}`, true);
        } finally {
          btn.disabled = false;
        }
      });
    }
    highlightActiveHistory();
  }

  function highlightActiveHistory() {
    document.querySelectorAll('.history-item').forEach(item => {
      item.classList.toggle('active', !!state.activeSessionId && item.dataset.id === state.activeSessionId);
    });
  }

  async function newSession() {
    if (state.busy) return;
    $('btn-new-session').disabled = true;
    try {
      const data = await request('/api/history/new', { method: 'POST', body: '{}' });
      renderCurrentHistory(data.sessionId, data.turns || []);
      await loadHistoryList();
      switchTab('chat');
      toast('已新建会话');
    } catch (e) {
      toast(`新建会话失败: ${errorText(e)}`, true);
    } finally {
      $('btn-new-session').disabled = false;
    }
  }

  async function loadSkills() {
    const data = await request('/api/skills/list').catch(e => ({ ok: false, error: e.message }));
    const box = $('skills');
    box.textContent = '';
    if (!data.ok) {
      appendTo(box, 'div', 'msg system', data.error || '技能库不可用');
      return;
    }

    state.skills = data.skills || [];
    renderSkills();
  }

  function renderSkills() {
    const box = $('skills');
    box.textContent = '';
    const skills = state.skills || [];
    if (skills.length === 0) {
      appendTo(box, 'div', 'msg system', '还没有技能。完成复杂任务后，系统会沉淀待审批技能。');
      return;
    }

    const enabledCount = skills.filter(s => !s.pending && s.enabled !== false).length;
    const summary = appendTo(box, 'div', 'skill-limit', `已启用 ${enabledCount}/${MAX_ENABLED_SKILLS}`);
    if (enabledCount >= MAX_ENABLED_SKILLS) {
      summary.textContent += '，已到上限，启用新技能前需要先停用一个。';
    }

    const groups = [
      { title: '待审批', items: skills.filter(s => s.pending) },
      { title: '已启用', items: skills.filter(s => !s.pending && s.enabled !== false) },
      { title: '已停用', items: skills.filter(s => !s.pending && s.enabled === false) },
    ];

    for (const group of groups) {
      if (group.items.length === 0) continue;
      const wrap = appendTo(box, 'div', 'skill-group');
      appendTo(wrap, 'h3', '', `${group.title} · ${group.items.length}`);
      for (const skill of group.items) wrap.appendChild(renderSkillCard(skill));
    }
  }

  function renderSkillCard(skill) {
    const card = document.createElement('div');
    card.className = 'skill-card'
      + (skill.pending ? ' pending' : '')
      + (!skill.pending && skill.enabled === false ? ' disabled' : '');

    const title = appendTo(card, 'div', 'skill-name', skill.name || '未命名技能');
    const pendingChange = skill.pending
      ? (skill.pendingChange || (skill.createdAt !== skill.updatedAt ? 'updated' : 'added'))
      : '';
    if (pendingChange) {
      appendTo(title, 'span', pendingChange === 'updated' ? 'skill-tag upd' : 'skill-tag new',
        pendingChange === 'updated' ? '更新' : '新增');
    } else if (skill.enabled === false) {
      appendTo(title, 'span', 'skill-tag off', '停用');
    }

    appendTo(card, 'div', 'skill-desc', skill.description || '无描述');

    const detail = renderSkillDetail(skill);
    detail.hidden = !skill.pending;
    card.appendChild(detail);

    const meta = [];
    if (skill.pending && pendingChange === 'updated') meta.push(`更新于 ${fmtTime(skill.updatedAt)}`);
    meta.push(`沉淀于 ${fmtTime(skill.createdAt)}`);
    if (!skill.pending || pendingChange === 'updated') meta.unshift(`已取用 ${skill.hits || 0} 次`);
    appendTo(card, 'div', 'skill-meta', meta.join(' · '));

    const actions = appendTo(card, 'div', 'skill-actions');
    if (skill.pending) {
      actions.append(
        button('通过', 'primary', () => void approveSkill(skill.name)),
        button('丢弃', 'ghost danger', () => void rejectSkill(skill.name)),
      );
    } else {
      const more = button(detail.hidden ? '查看完整' : '收起', 'ghost', () => {
        detail.hidden = !detail.hidden;
        more.textContent = detail.hidden ? '查看完整' : '收起';
      });
      actions.append(more, skillToggleButton(skill));
    }

    return card;
  }

  function renderSkillDetail(skill) {
    const detail = document.createElement('div');
    detail.className = 'skill-detail';

    const steps = Array.isArray(skill.steps) ? skill.steps : [];
    if (steps.length > 0) {
      const ol = appendTo(detail, 'ol', 'skill-steps');
      for (const step of steps) {
        const li = appendTo(ol, 'li', '', step.goal || '');
        if (step.how) appendTo(li, 'span', 'how', step.how);
      }
    }

    const pitfalls = Array.isArray(skill.pitfalls) ? skill.pitfalls : [];
    if (pitfalls.length > 0) {
      const ul = appendTo(detail, 'ul', 'skill-pit');
      for (const text of pitfalls) appendTo(ul, 'li', '', text);
    }

    if (skill.note) appendTo(detail, 'div', 'skill-note', skill.note);
    if (!detail.childNodes.length) appendTo(detail, 'div', 'skill-note', '没有更多细节。');
    return detail;
  }

  async function approveSkill(name) {
    if (enabledSkillCount() >= MAX_ENABLED_SKILLS) {
      toast(`最多只能启用 ${MAX_ENABLED_SKILLS} 个技能，请先停用一个已启用技能。`, true);
      return;
    }
    try {
      const result = await request('/api/skills/approve', { method: 'POST', body: JSON.stringify({ name }) });
      if (result.skills) {
        state.skills = result.skills;
        renderSkills();
      } else {
        await loadSkills();
      }
      toast('已通过，重启当前会话后进入提示词索引。');
    } catch (e) {
      toast(`通过失败: ${errorText(e)}`, true);
    }
  }

  async function rejectSkill(name) {
    try {
      const result = await request('/api/skills/reject', { method: 'POST', body: JSON.stringify({ name }) });
      if (result.skills) {
        state.skills = result.skills;
        renderSkills();
      } else {
        await loadSkills();
      }
      toast('已丢弃');
    } catch (e) {
      toast(`丢弃失败: ${errorText(e)}`, true);
    }
  }

  function skillToggleButton(skill) {
    const enabled = skill.enabled !== false;
    const btn = button(enabled ? '停用' : '启用', enabled ? 'ghost' : 'primary', async () => {
      const next = !enabled;
      if (next && enabledSkillCount() >= MAX_ENABLED_SKILLS) {
        toast(`最多只能启用 ${MAX_ENABLED_SKILLS} 个技能，请先停用一个已启用技能。`, true);
        return;
      }
      btn.disabled = true;
      try {
        const result = await request('/api/skills/set-enabled', {
          method: 'POST',
          body: JSON.stringify({ name: skill.name, enabled: next }),
        });
        if (result.skills) {
          state.skills = result.skills;
          renderSkills();
        } else {
          await loadSkills();
        }
        toast(next ? '已启用，重启当前会话后进入提示词索引。' : '已停用');
      } catch (e) {
        toast(`${next ? '启用' : '停用'}失败: ${errorText(e)}`, true);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  function enabledSkillCount() {
    return (state.skills || []).filter(s => !s.pending && s.enabled !== false).length;
  }

  async function loadConfig() {
    const box = $('secret-list');
    if (!box) return;
    try {
      const cfg = await request('/api/config');
      state.configLoaded = true;
      state.deletedSecrets = new Set();
      state.secrets = (cfg.secrets || []).map(secretRow);
      state.mcpServers = (cfg.mcpServers || []).map(mcpRow);
      renderConfig();
    } catch (e) {
      box.textContent = '';
      appendTo(box, 'div', 'msg error', `配置读取失败: ${errorText(e)}`);
    }
  }

  function renderConfig() {
    renderSecrets();
    renderMcpServers();
  }

  function secretRow(data = {}) {
    return {
      uid: `s${Date.now()}${Math.random().toString(36).slice(2)}`,
      existing: !!data.name,
      name: normalizeSecretName(data.name || ''),
      description: data.description || '',
      hasValue: !!data.hasValue,
      value: '',
    };
  }

  function mcpRow(data = {}) {
    return {
      uid: `m${Date.now()}${Math.random().toString(36).slice(2)}`,
      enabled: data.enabled !== false,
      serverId: data.id || '',
      name: data.name || data.id || '',
      description: data.description || '',
      url: data.url || '',
      bearerSecret: normalizeSecretName(data.bearerSecret || ''),
      testing: false,
      describing: false,
      testResult: null,
    };
  }

  function normalizeSecretName(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
  }

  function availableSecrets() {
    return state.secrets
      .map(row => ({
        name: normalizeSecretName(row.name),
        description: row.description || '',
        hasValue: row.hasValue || !!row.value,
      }))
      .filter(row => row.name && !state.deletedSecrets.has(row.name));
  }

  function renderSecrets() {
    const box = $('secret-list');
    box.textContent = '';
    if (state.secrets.length === 0) {
      appendTo(box, 'div', 'msg system', '暂无 Secret。可以新增空槽后在这里填写值。');
      return;
    }

    for (const row of state.secrets) {
      const card = appendTo(box, 'div', 'config-card');
      const head = appendTo(card, 'div', 'config-head');
      const name = input('text', 'SECRET_NAME', row.name);
      name.readOnly = row.existing;
      name.addEventListener('input', () => {
        row.name = normalizeSecretName(name.value);
        name.value = row.name;
        renderMcpServers();
      });
      const status = appendTo(head, 'span', row.hasValue || row.value ? 'badge ok' : 'badge warn',
        row.hasValue || row.value ? '已填写' : '未填写');
      const del = button('删除', 'ghost danger', () => {
        const normalized = normalizeSecretName(row.name);
        if (row.existing && normalized) state.deletedSecrets.add(normalized);
        state.secrets = state.secrets.filter(item => item.uid !== row.uid);
        renderConfig();
      });
      head.append(name, status, del);

      const desc = input('text', '用途说明', row.description);
      desc.maxLength = 200;
      desc.addEventListener('input', () => { row.description = desc.value; });

      const value = input('password', row.existing ? '(留空则沿用旧值)' : 'Secret value', '');
      value.addEventListener('input', () => {
        row.value = value.value;
        renderMcpServers();
      });

      card.append(desc, value);
    }
  }

  function renderMcpServers() {
    const box = $('mcp-list');
    box.textContent = '';
    if (state.mcpServers.length === 0) {
      appendTo(box, 'div', 'msg system', '暂无 MCP Server。');
      return;
    }

    for (const row of state.mcpServers) {
      const card = appendTo(box, 'div', 'config-card');
      const head = appendTo(card, 'div', 'config-head');
      const enabledLabel = appendTo(head, 'label', 'inline-check', '');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = row.enabled;
      enabled.addEventListener('change', () => { row.enabled = enabled.checked; });
      enabledLabel.append(enabled, document.createTextNode('启用'));

      const serverId = input('text', 'server_id', row.serverId);
      serverId.addEventListener('input', () => {
        row.serverId = serverId.value.trim();
        if (!row.name) row.name = row.serverId;
      });
      const del = button('删除', 'ghost danger', () => {
        state.mcpServers = state.mcpServers.filter(item => item.uid !== row.uid);
        renderMcpServers();
      });
      head.append(serverId, del);

      const grid = appendTo(card, 'div', 'field-grid');
      const name = labeledInput('名称', '显示名称', row.name);
      name.input.addEventListener('input', () => { row.name = name.input.value; });
      const url = labeledInput('URL', 'https://example.com/mcp', row.url);
      url.input.addEventListener('input', () => { row.url = url.input.value; });
      const desc = labeledInput('用途说明', '这个 MCP 适合什么任务', row.description);
      desc.input.maxLength = 240;
      desc.input.addEventListener('input', () => { row.description = desc.input.value; });

      const secretWrap = document.createElement('label');
      secretWrap.textContent = 'Bearer Secret';
      const secretLine = appendTo(secretWrap, 'div', 'config-inline');
      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '不使用';
      select.appendChild(none);
      const secrets = availableSecrets();
      for (const item of secrets) {
        const option = document.createElement('option');
        option.value = item.name;
        option.textContent = item.description ? `${item.name} - ${item.description}` : item.name;
        select.appendChild(option);
      }
      if (row.bearerSecret && !secrets.some(item => item.name === row.bearerSecret)) {
        const missing = document.createElement('option');
        missing.value = row.bearerSecret;
        missing.textContent = `${row.bearerSecret} (Secret 不存在)`;
        select.appendChild(missing);
      }
      select.value = row.bearerSecret || '';
      select.addEventListener('change', () => {
        row.bearerSecret = select.value;
        renderMcpServers();
      });
      secretLine.append(select, button('新建槽位', 'ghost', () => ensureSecretSlotForMcp(row)));
      secretWrap.appendChild(authBadge(row));

      grid.append(name.label, url.label, desc.label, secretWrap);

      const actions = appendTo(card, 'div', 'config-actions');
      actions.append(
        button(row.testing ? '测试中...' : '测试', 'ghost', () => void testMcp(row), row.testing || row.describing),
        button(row.describing ? '生成中...' : '生成说明', 'ghost', () => void describeMcp(row), row.testing || row.describing),
      );

      if (row.testResult) card.appendChild(renderMcpResult(row.testResult));
    }
  }

  function ensureSecretSlotForMcp(row) {
    const secretName = suggestedSecretNameForMcp(row);
    if (!state.secrets.some(s => normalizeSecretName(s.name) === secretName)) {
      state.secrets.push(secretRow({
        name: secretName,
        description: `${row.name || row.serverId || 'MCP'} Bearer token`,
        hasValue: false,
      }));
    }
    state.deletedSecrets.delete(secretName);
    row.bearerSecret = secretName;
    renderConfig();
  }

  function suggestedSecretNameForMcp(row) {
    const base = String(row.serverId || row.name || 'MCP')
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
      .slice(0, 52);
    return `${base || 'MCP'}_TOKEN`;
  }

  function authBadge(row) {
    const name = normalizeSecretName(row.bearerSecret);
    if (!name) return badge('不使用认证', 'muted');
    const secret = availableSecrets().find(item => item.name === name);
    if (!secret) return badge('Secret 不存在', 'err');
    if (!secret.hasValue) return badge('Secret 未填写', 'warn');
    return badge('认证已配置', 'ok');
  }

  function badge(text, tone) {
    return appendTo(document.createElement('span'), 'span', `badge ${tone}`, text);
  }

  function mcpServerPatch(row) {
    return {
      id: row.serverId.trim(),
      name: row.name.trim() || row.serverId.trim(),
      description: row.description.trim() || undefined,
      url: row.url.trim(),
      enabled: row.enabled !== false,
      bearerSecret: row.bearerSecret.trim() || undefined,
    };
  }

  function collectSecretPatches() {
    const patches = [];
    for (const name of state.deletedSecrets) patches.push({ name, delete: true });
    for (const row of state.secrets) {
      const name = normalizeSecretName(row.name);
      if (!name) continue;
      if (row.value || !row.existing || row.description !== undefined) {
        patches.push({
          name,
          value: row.value || undefined,
          description: row.description || '',
        });
      }
    }
    return patches;
  }

  function collectMcpServers() {
    return state.mcpServers
      .map(mcpServerPatch)
      .filter(server => server.id || server.url);
  }

  async function saveConfig() {
    const btn = $('btn-save-config');
    btn.disabled = true;
    try {
      const result = await request('/api/config/save', {
        method: 'POST',
        body: JSON.stringify({
          patch: {
            secrets: collectSecretPatches(),
            mcpServers: collectMcpServers(),
          },
        }),
      });
      for (const row of state.secrets) {
        if (row.value) row.hasValue = true;
        row.value = '';
        row.existing = true;
      }
      state.deletedSecrets = new Set();
      renderConfig();
      toast(result.hotReloaded ? '配置已保存并热刷新' : '配置已保存');
      await loadInfo();
    } catch (e) {
      toast(`保存失败: ${errorText(e)}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function testMcp(row) {
    row.testing = true;
    row.testResult = { ok: true, message: '正在测试连接...' };
    renderMcpServers();
    try {
      row.testResult = await request('/api/config/test-mcp', {
        method: 'POST',
        body: JSON.stringify({ server: mcpServerPatch(row), secrets: collectSecretPatches() }),
      });
    } catch (e) {
      row.testResult = { ok: false, error: errorText(e) };
    } finally {
      row.testing = false;
      renderMcpServers();
    }
  }

  async function describeMcp(row) {
    row.describing = true;
    row.testResult = { ok: true, message: '正在读取工具并生成说明...' };
    renderMcpServers();
    try {
      const result = await request('/api/config/describe-mcp', {
        method: 'POST',
        body: JSON.stringify({ server: mcpServerPatch(row), secrets: collectSecretPatches() }),
      });
      row.description = result.description || row.description;
      row.testResult = { ok: true, message: '说明已生成，请检查后保存。' };
    } catch (e) {
      row.testResult = { ok: false, error: errorText(e) };
    } finally {
      row.describing = false;
      renderMcpServers();
    }
  }

  function renderMcpResult(result) {
    const box = appendTo(document.createElement('div'), 'div', 'config-test' + (result.ok ? '' : ' error'), '');
    if (!result.ok) {
      box.textContent = result.error || '测试失败';
      return box;
    }
    if (result.message) {
      box.textContent = result.message;
      return box;
    }
    appendTo(box, 'div', '', `连接成功，发现 ${result.toolCount || 0} 个工具`);
    for (const tool of result.tools || []) {
      const item = appendTo(box, 'details', 'tool-detail', '');
      appendTo(item, 'summary', '', tool.description ? `${tool.name} - ${tool.description}` : tool.name);
      appendTo(item, 'pre', '', JSON.stringify(tool.inputSchema || {}, null, 2));
    }
    return box;
  }

  async function send(text) {
    if (state.busy) return;
    state.busy = true;
    state.currentRunId = `remote-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    appendMessage('user', text);
    state.currentAssistant = appendMessage('assistant', '');
    state.currentAnswer = appendTo(state.currentAssistant, 'div', 'answer', '');
    state.currentAnswerRaw = '';
    syncBusy();
    try {
      const result = await request('/api/agent/run', {
        method: 'POST',
        body: JSON.stringify({ runId: state.currentRunId, input: text }),
      });
      if (state.currentAnswer) {
        const finalText = state.currentAnswerRaw || result.answer || '';
        if (finalText) {
          md.into(state.currentAnswer, finalText);
          state.currentAnswer.classList.add('md');
        }
      } else if (result.answer && state.currentAssistant) {
        state.currentAnswer = appendTo(state.currentAssistant, 'div', 'answer md', '');
        md.into(state.currentAnswer, result.answer);
      }
      await loadHistory();
      await loadHistoryList();
      state.pendingHistoryReload = false;
    } catch (e) {
      appendMessage('error', errorText(e));
    } finally {
      state.busy = false;
      state.currentRunId = '';
      state.currentAssistant = null;
      state.currentAnswer = null;
      state.currentAnswerRaw = '';
      state.currentReasoning = null;
      syncBusy();
      if (state.pendingHistoryReload) {
        state.pendingHistoryReload = false;
        void Promise.allSettled([loadHistory(), loadHistoryList()]);
      }
    }
  }

  async function stop() {
    await request('/api/agent/abort', { method: 'POST', body: '{}' }).catch(() => {});
  }

  async function startEvents() {
    state.eventAbort?.abort();
    const ac = new AbortController();
    state.eventAbort = ac;

    try {
      const res = await fetch(apiUrl('/events'), {
        headers: { authorization: `Bearer ${state.token}` },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`事件流连接失败 HTTP ${res.status}`);
      setStatus('已连接');
      await readSse(res.body, event => handleRemoteEvent(event));
    } catch {
      if (!ac.signal.aborted) {
        setStatus('连接断开');
        setTimeout(() => {
          if (state.token) void startEvents();
        }, 1800);
      }
    }
  }

  async function readSse(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore bad frame */ }
        }
      }
    }
  }

  function handleRemoteEvent(message) {
    const { type, payload } = message || {};
    if (type === 'agent:event') {
      const { runId, event } = payload || {};
      if (runId === state.currentRunId) applyAgentEvent(event);
      return;
    }
    if (type === 'agent:session-changed') {
      if (state.busy) state.pendingHistoryReload = true;
      else void Promise.allSettled([loadHistory(), loadHistoryList()]);
    }
    if (type === 'agent:skills-changed') void loadSkills();
    if (type === 'agent:config-changed') {
      void loadInfo();
      if (state.configLoaded) void loadConfig();
    }
  }

  function applyAgentEvent(event) {
    if (!state.currentAssistant || !event) return;
    if (event.type === 'content') {
      if (!state.currentAnswer) {
        state.currentAnswer = appendTo(state.currentAssistant, 'div', 'answer', '');
      }
      state.currentAnswerRaw += event.text || '';
      state.currentAnswer.textContent += event.text || '';
    } else if (event.type === 'reasoning') {
      if (!state.currentReasoning) {
        state.currentReasoning = appendTo(state.currentAssistant, 'div', 'reasoning', '');
      }
      state.currentReasoning.textContent += event.text || '';
    } else if (event.type === 'tool_start') {
      appendTo(state.currentAssistant, 'div', 'tool', `调用工具: ${event.name}`);
    } else if (event.type === 'tool_end') {
      appendTo(state.currentAssistant, 'div', 'tool', `${event.ok ? '完成' : '失败'}: ${event.summary || event.name}`);
    } else if (event.type === 'error') {
      appendTo(state.currentAssistant, 'div', 'msg error', event.message || '执行失败');
    }
    scrollToBottom();
  }

  function appendMessage(kind, text) {
    return appendTo($('stream'), 'div', `msg ${kind}`, text || '');
  }

  function appendMarkdownMessage(kind, text) {
    const msg = appendTo($('stream'), 'div', `msg ${kind}`, '');
    const body = appendTo(msg, 'div', 'md', '');
    md.into(body, text || '');
    return msg;
  }

  function userTextOfTurn(turn) {
    const messages = Array.isArray(turn?.messages) ? turn.messages : [];
    return messages.length > 0 ? textOf(messages[0].content) : '';
  }

  function answerTextOfTurn(turn) {
    const messages = Array.isArray(turn?.messages) ? turn.messages : [];
    const finals = messages.filter(m =>
      m?.role === 'assistant' && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0));
    const last = finals[finals.length - 1];
    return last ? textOf(last.content) : '';
  }

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.input_text === 'string') return part.input_text;
        if (typeof part.content === 'string') return part.content;
        return '';
      }).filter(Boolean).join('\n');
    }
    return String(content);
  }

  function appendTo(parent, tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function input(type, placeholder, value) {
    const el = document.createElement('input');
    el.type = type;
    el.placeholder = placeholder;
    el.value = value || '';
    return el;
  }

  function labeledInput(labelText, placeholder, value) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const el = input('text', placeholder, value);
    label.appendChild(el);
    return { label, input: el };
  }

  function button(text, className, onClick, disabled = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className || '';
    btn.textContent = text;
    btn.disabled = !!disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  }

  function syncBusy() {
    $('btn-send').disabled = state.busy;
    $('btn-stop').hidden = !state.busy;
    $('btn-new-session').disabled = state.busy;
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === name);
    });
    document.querySelectorAll('.tab-body').forEach(item => { item.hidden = true; });
    $(`tab-${name}`).hidden = false;
    if (name === 'history') void loadHistoryList();
    if (name === 'skills') void loadSkills();
    if (name === 'config' && !state.configLoaded) void loadConfig();
  }

  function fmtTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '未知时间';
    const diff = Date.now() - n;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(n).toLocaleDateString('zh-CN');
  }

  function errorText(e) {
    return e && e.message ? e.message : String(e);
  }

  function createFallbackMarkdown() {
    const SAFE_LINK = /^(https?:|mailto:)/i;
    const FENCE = /^```(\w*)\s*$/;
    const HEADER = /^(#{1,6})\s+(.*)$/;
    const UL = /^\s*[-*+]\s+(.*)$/;
    const OL = /^\s*(\d+)[.)]\s+(.*)$/;
    const QUOTE = /^>\s?(.*)$/;
    const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
    const TABLE_SEP = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/;

    function into(node, text) {
      node.textContent = '';
      node.appendChild(render(text));
      return node;
    }

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
        const fence = FENCE.exec(line);
        if (fence) {
          flushPara();
          const body = [];
          const lang = fence[1];
          i++;
          while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
          i++;
          const pre = document.createElement('pre');
          pre.className = 'md-code';
          if (lang) pre.dataset.lang = lang;
          const code = document.createElement('code');
          code.textContent = body.join('\n');
          pre.appendChild(code);
          frag.appendChild(pre);
          continue;
        }

        if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
          flushPara();
          const table = document.createElement('table');
          table.className = 'md-table';
          const thead = document.createElement('thead');
          const tr = document.createElement('tr');
          for (const cell of splitTableRow(line)) {
            const th = document.createElement('th');
            inline(th, cell);
            tr.appendChild(th);
          }
          thead.appendChild(tr);
          table.appendChild(thead);
          i += 2;
          const tbody = document.createElement('tbody');
          while (i < lines.length && lines[i].includes('|')) {
            const row = document.createElement('tr');
            for (const cell of splitTableRow(lines[i])) {
              const td = document.createElement('td');
              inline(td, cell);
              row.appendChild(td);
            }
            tbody.appendChild(row);
            i++;
          }
          table.appendChild(tbody);
          frag.appendChild(table);
          continue;
        }

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

        if (RULE.test(line)) {
          flushPara();
          frag.appendChild(document.createElement('hr'));
          i++;
          continue;
        }

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

    function inline(target, text) {
      if (!text) return;
      const patterns = [
        { re: /\[([^\]]*)\]\(([^)\s]+)\)/, kind: 'link' },
        { re: /`([^`]+)`/, kind: 'code' },
        { re: /\*\*([^*]+)\*\*/, kind: 'strong' },
        { re: /__([^_]+)__/, kind: 'strong' },
        { re: /\*([^*\n]+)\*(?!\*)/, kind: 'em' },
        { re: /~~([^~]+)~~/, kind: 'del' },
      ];
      let best = null;
      for (const item of patterns) {
        const m = item.re.exec(text);
        if (m && (!best || m.index < best.m.index)) best = { ...item, m };
      }
      if (!best) {
        target.appendChild(document.createTextNode(text));
        return;
      }
      if (best.m.index > 0) target.appendChild(document.createTextNode(text.slice(0, best.m.index)));
      if (best.kind === 'link') {
        const [, label, href] = best.m;
        if (SAFE_LINK.test(href)) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noreferrer noopener';
          a.textContent = label || href;
          target.appendChild(a);
        } else {
          target.appendChild(document.createTextNode(best.m[0]));
        }
      } else {
        const el = document.createElement(best.kind);
        if (best.kind === 'code') el.textContent = best.m[1];
        else inline(el, best.m[1]);
        target.appendChild(el);
      }
      inline(target, text.slice(best.m.index + best.m[0].length));
    }

    function splitTableRow(line) {
      return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
        .split('|').map(cell => cell.trim());
    }

    return { into, render };
  }

  $('btn-pair').addEventListener('click', pair);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-stop').addEventListener('click', stop);
  $('btn-refresh-skills').addEventListener('click', () => void loadSkills());
  $('btn-new-session').addEventListener('click', () => void newSession());
  $('btn-save-config').addEventListener('click', () => void saveConfig());
  $('btn-add-secret').addEventListener('click', () => {
    state.secrets.push(secretRow());
    renderConfig();
  });
  $('btn-add-mcp').addEventListener('click', () => {
    state.mcpServers.push(mcpRow());
    renderMcpServers();
  });
  $('pair-code').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    void send(text);
  });
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  if (state.token) void connect();
})();
