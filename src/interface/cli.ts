// ============================================
// Interface 层:CLI(调试壳)
// ============================================
//
// 全部业务接线在 core/session.ts。这里只做三件事:
// 读 stdin → 调 session.run() → 渲染。
//
// 从 937 行降到这个规模不是整理癖:架构文档第一条要求「交互层只做
// 输入→文本与结果→展示,零业务逻辑」,而抽出 session 之前那条不成立
// (21 段装配逻辑全在这个文件里)。
//
// **客户端与本文件是同级消费者**,不是「客户端调 CLI」——
// 后者等于终端模拟器,而且会让每次改动都要同步两处。
// 这个项目已经在「同一份事实写两处」上栽过四次。
//
// 用法:
//   npm run cli                  交互模式
//   npm run cli -- "任务描述"     单发模式,跑完即退
// ============================================

import 'dotenv/config';
import readline from 'readline';
import path from 'path';
import { formatConfirm } from './confirm-format.js';
import type { TraceSummary } from '../platform/index.js';
import {
  createAgentSession,
  DIMENSION_LABELS,
  messageToText,
  type AgentSession,
  type AgentEvent,
} from '../core/index.js';

const HELP = `
可用命令：
  /stats     显示上下文与 token 统计
  /trace     显示最近一次 LLM 调用的摘要与文件路径
  /calls     列出本次会话所有 LLM 调用
  /context   打印当前发送给模型的消息结构
  /memory    查看长期记忆（用户特征）；/memory clear 全部清空
  /help      显示本帮助
  /exit      退出（Ctrl+C 亦可）

直接输入文字即为向 Agent 提问。
`.trim();

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }

function fmtTokens(n?: number): string {
  if (n === undefined) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * 流式渲染器
 *
 * 三件事只有展示层知道怎么做,所以放在这里而不是 core:
 *
 * ① **reset 要能真的擦掉**。重试时模型会从头再说一遍,不擦用户看到两个半截
 *    回答拼在一起。终端里只能靠 ANSI 回退,而回退多少行取决于**终端宽度**——
 *    core 不该知道 process.stdout.columns。
 * ② **推理与正文分色**。推理是过程,正文是结论;同色混排读不出哪句是答案。
 * ③ **换行时机**。正文首字到达前要先收掉推理段,否则两段黏在一行。
 */
function createRenderer() {
  let printed = '';          // 本步已输出的字符(用于 reset 时算回退量)
  let mode: 'idle' | 'reasoning' | 'content' = 'idle';
  // 本轮是否真的流出过正文。必须是**每轮一个**渲染器的局部状态:
  // 提到模块作用域就会跨轮泄漏 —— 上一轮流过,下一轮即使一个字没流出来
  // 也会被判成「已经显示过了」,于是回答整段消失
  let streamed = false;

  /** 已打印内容占多少终端行 —— 宽字符按 1 算,只求够用不求精确 */
  const rows = (s: string) => {
    const width = process.stdout.columns || 80;
    return s.split('\n').reduce(
      (n, line) => n + Math.max(1, Math.ceil(line.length / width)),
      0,
    );
  };

  const write = (s: string) => {
    printed += s;
    process.stdout.write(s);
  };

  return {
    reasoning(text: string) {
      if (mode !== 'reasoning') {
        write(`${DIM}思考 `);
        mode = 'reasoning';
      }
      write(text);
    },

    content(text: string) {
      if (mode !== 'content') {
        // 从推理切到正文:先关掉 dim 并换行,否则正文继承灰色
        write(mode === 'reasoning' ? `${RESET}\n\n` : '');
        mode = 'content';
      }
      streamed = true;
      write(text);
    },

    /** 重试:擦掉本步所有已输出内容 */
    reset() {
      if (!printed) return;
      const up = rows(printed) - 1;
      // \r 回行首 → 上移 → 清到屏幕底部
      process.stdout.write(`\r${up > 0 ? `\x1b[${up}A` : ''}\x1b[0J`);
      process.stdout.write(dim('(重试,重新生成…)\n'));
      printed = '';
      mode = 'idle';
    },

    /** 一步结束(要调工具了,或本轮完了)—— 收掉未闭合的样式 */
    endStep() {
      if (mode === 'reasoning') process.stdout.write(RESET);
      if (mode !== 'idle') process.stdout.write('\n');
      printed = '';
      mode = 'idle';
    },

    /** 本轮是否真的流出过正文 —— 决定末尾要不要再打一遍完整回答 */
    get streamedContent() { return streamed; },
    markStreamed() { streamed = true; },
  };
}

/** 一次 LLM 调用的单行摘要 */
function fmtCall(s: TraceSummary): string {
  const parts = [
    dim(`#${s.callIndex}`),
    s.label.padEnd(24).slice(0, 24),
    `${String(s.durationMs).padStart(6)}ms`,
    `in ${fmtTokens(s.promptTokens).padStart(6)}`,
    `out ${fmtTokens(s.completionTokens).padStart(5)}`,
  ];
  if (s.cachedTokens) parts.push(dim(`cache ${fmtTokens(s.cachedTokens)}`));
  if (s.attempts && s.attempts > 1) parts.push(`${YELLOW}重试 ${s.attempts - 1} 次${RESET}`);
  if (s.toolCalls.length > 0) parts.push(`${CYAN}→ ${s.toolCalls.join(', ')}${RESET}`);
  if (s.hasReasoning) parts.push(dim('reasoning'));
  if (s.failed) parts.push(`${RED}失败: ${s.errorMessage ?? ''}${RESET}`);
  return '  ' + parts.join('  ');
}

/** 启动横幅 —— 全部取自 session.info,壳不重算任何事实 */
function printBanner(session: AgentSession): void {
  const { info, config } = session;
  const ctx = config.context;

  console.log(bold('\nBaseAgent'));
  console.log(dim(`  模型      ${info.model}  @ ${info.baseURL}`));
  console.log(dim(`  会话      ${session.sessionId}`));
  console.log(dim(`  窗口      ${fmtTokens(ctx.windowSize)} tokens,压缩阈值 ${
    ctx.compressionThreshold * 100}%,保留最近 ${ctx.recentTurnsToKeep} 轮`));
  console.log(dim(`  压缩预算  ${fmtTokens(info.compression.budget)} tokens (${
    info.compression.source}),工具结果截断 ${ctx.compressionClip.toolResult} 字`));
  console.log(dim(`  留痕      ${
    config.trace.enabled ? session.recorder.traceDir : '已关闭'}`));
  // 授权范围必须可见:用户得知道 agent 到底能碰哪些目录、哪些只读
  console.log(dim(`  授权范围  ${
    config.security.fsGrants.length > 0
      ? config.security.fsGrants.map(g => `${g.path} [${g.mode}]`).join('\n            ')
      : '(未配置 WORKSPACE,文件工具与代码执行均不可用)'
  }`));
  console.log(dim(`  危险工具  ${
    config.security.allowDangerousTools ? '已启用(需确认)' : '已禁用'}`));
  console.log(dim(`  子 agent  ${config.subAgent.enabled
    ? `已启用,最多 ${config.subAgent.maxCount} 个,各 ${config.subAgent.maxSteps} 步`
    : '已禁用'}`));
  console.log(dim(`  代码执行  ${info.sandboxPython
    ? `已启用 ${info.sandboxPython},stdout 上限 ${
        Math.round(config.python.maxStdoutBytes / 1024)}KB,写边界=工作区`
    : '已禁用 (PYTHON_ENABLED=true 开启)'}`));

  if (config.python.enabled) {
    // venv 状态必须可见:用户得知道模型装的包会落在哪儿。
    // 「新建了」和「已就绪」要区分 —— 首次启动多等几秒,不说会以为卡住了
    console.log(dim(`  沙箱 venv ${!info.venv.enabled
      ? '已关闭 (SANDBOX_VENV=false;模型装的包会进全局环境)'
      : info.venv.ok
        ? `${info.venv.created ? '已创建' : '已就绪'} ${info.venv.dir} (装的包只落在这里)`
        : '不可用,已回落到全局解释器 (见上方警告)'}`));
    // 基线依赖的实况:提示词声称「已预装」,这行是那句话的事实核对
    console.log(dim(`  基线依赖  ${info.deps?.ok
      ? '齐备 (来自系统环境)'
      : info.deps?.error
        ? `检测失败 (${info.deps.error})`
        : `缺 ${info.deps?.missing.join(', ')} —— 见上方安装命令`}`));
  }

  console.log(dim(`  视觉插件  ${info.visionModel
    ? `已启用 ${info.visionModel} (图不进主上下文,只回文字观察)`
    : '未配置 (设 VISION_MODEL 开启)'}`));
  // 外部命令是唯一没有机制边界的能力,安全性全靠用户那次确认 —— 必须可见
  console.log(dim(`  外部命令  ${info.shellEnabled
    ? `已启用 run_command (每次需确认${
        info.pythonDir ? `,PATH 前置 ${info.pythonDir}` : ''})`
    : config.shell.enabled && !config.security.allowDangerousTools
      ? '已配置但未生效 (还需 ALLOW_DANGEROUS_TOOLS=true)'
      : '已禁用 (SHELL_ENABLED=true 开启)'}`));

  if (config.python.enabled) {
    console.log(dim(`  代码装包  ${config.python.blockPipInstall
      ? `已禁止 (pip 不查索引;装包走 ${info.shellEnabled ? 'run_command' : '用户手动'})`
      : '允许 (模型可在代码里静默装包)'}`));
    console.log(dim(`  浏览器    profile=${info.browserProfileDir} (已加入读黑名单)`));
  }
  // 只报条数不报清单:十几条会把横幅撑爆,用户要确认的是「这层开着」
  console.log(dim(`  读黑名单  ${info.readDenyCount} 条凭证路径 ` +
    `(私钥/云凭证/token/cookie/.env;fs 工具与代码同一份)`));
  console.log(dim(`  长期记忆  ${session.memory
    ? `${session.memory.list().length} 条用户特征 (/memory 查看,/memory clear 清空)`
    : '已关闭 (MEMORY_ENABLED=true 开启)'}`));
  if (info.bridgedTools.length > 0) {
    console.log(dim(`  ${info.bridgedTools.join(' / ')} 只在 execute_python 的代码里可调`));
  }
  console.log();
}

async function main() {
  const singleShot = process.argv.slice(2).join(' ').trim();

  // 确认回调:复用主 rl 会有循环依赖(rl 要先建),所以先留个可替换的槽。
  // 没有默认放行的实现 —— run_command 的安全性全部来自用户读那一行原样命令
  let confirmFn: (prompt: string) => Promise<boolean> = async () => false;

  const session = await createAgentSession({
    idPrefix: 'cli',
    onConfirm: req => confirmFn(formatConfirm(req)),
  });

  // 装配期的告警由壳呈现 —— session 不做任何输出
  for (const n of session.notices) {
    const tag = n.level === 'warn' ? `${YELLOW}警告${RESET}` : dim('提示');
    console.log(`${tag} ${n.message}`);
    if (n.hint) console.log(dim(`        ${n.hint}`));
  }

  printBanner(session);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  confirmFn = (prompt: string) =>
    new Promise<boolean>(resolve => {
      rl.question(`${prompt} [y/N] `, answer => {
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });

  const runTurn = async (input: string) => {
    const callsBefore = session.recorder.count();
    const statsBefore = session.context.getStats();
    const startedAt = Date.now();

    // 每轮一个渲染器:它带本轮状态(已输出多少、流没流出正文),
    // 复用一个会让上一轮的状态泄漏到下一轮
    const render = createRenderer();

    const onEvent = (ev: AgentEvent) => {
      switch (ev.type) {
        case 'reasoning': render.reasoning(ev.text); break;
        case 'content':   render.content(ev.text);   break;
        case 'reset':     render.reset();            break;
        case 'step':
          // 第一步不报:刚敲完回车就跳「第 1/25 步」是噪音
          if (ev.step > 1) console.log(dim(`\n[第 ${ev.step}/${ev.maxSteps} 步]`));
          break;
        case 'tool_start':
          // 工具要开始了,先收掉上面流出来的推理/正文
          render.endStep();
          console.log(`${CYAN}▸${RESET} ${ev.name} ${dim('执行中…')}`);
          break;
        case 'tool_end':
          console.log(`  ${ev.ok ? '✓' : `${RED}✗${RESET}`} ${dim(ev.summary)}`);
          break;
        case 'done':
          render.endStep();
          break;
      }
    };

    try {
      const run = await session.run(input, onEvent);

      const elapsed = Date.now() - startedAt;
      const statsAfter = session.context.getStats();
      const newCalls = session.recorder.since(callsBefore);

      // 流出来过就不再整段重复一遍 —— 用户刚刚一个字一个字看完了。
      // 但**必须留兜底**:收尾调用(wrapUp)不走流式、no_response 没有正文,
      // 这两条路径下 run.answer 是唯一的答案来源
      if (render.streamedContent) {
        console.log();
      } else {
        console.log(`\n${bold('回答')}\n${run.answer}\n`);
      }

      // 退出原因单独渲染,不混进回答正文
      if (run.stopReason === 'max_steps') {
        console.log(
          `${YELLOW}注意${RESET} 达到 ${session.config.execution.maxSteps} 步上限后收尾,` +
          `结论可能不完整(见回答中自述的未完成部分)`
        );
      } else if (run.stopReason === 'no_response') {
        console.log(`${RED}注意${RESET} 模型未返回有效内容`);
      }

      console.log(dim('─── 本轮 LLM 调用 ───'));
      if (newCalls.length === 0) {
        console.log(dim('  (无)'));
      } else {
        newCalls.forEach(c => console.log(fmtCall(c)));
      }

      // 用真实压缩计数判断,不靠 turns 数量反推
      const compressedTimes = statsAfter.compressions - statsBefore.compressions;
      console.log(dim('─── 上下文 ───'));
      console.log(
        `  轮次 ${statsAfter.turns}` +
        `  消息 ${statsAfter.messages}` +
        `  主题 ${statsAfter.topics}` +
        `  当前上下文 ${fmtTokens(statsAfter.tokens.total_prompt)} tokens` +
        `  缓存命中 ${(statsAfter.tokens.cache_hit_rate * 100).toFixed(1)}%` +
        `  累计输出 ${fmtTokens(statsAfter.tokens.total_completion)}`
      );
      console.log(
        `  LLM 调用 ${newCalls.length} 次` +
        `  耗时 ${(elapsed / 1000).toFixed(1)}s` +
        (compressedTimes > 0 ? `  ${YELLOW}压缩已触发 ${compressedTimes} 次${RESET}` : '')
      );
      if (session.config.trace.enabled && newCalls.length > 0) {
        console.log(dim(`  trace: ${newCalls[0].file} … (共 ${newCalls.length} 个文件)`));
      }
      console.log();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`\n${RED}执行失败${RESET} ${msg}`);
      const failed = session.recorder.since(callsBefore);
      if (failed.length > 0) {
        console.error(dim('  相关调用:'));
        failed.forEach(c => console.error(fmtCall(c)));
        console.error(dim(`  请求体见: ${failed[failed.length - 1].file}`));
      }
      console.log();
    }
  };

  const handleCommand = async (cmd: string): Promise<boolean> => {
    const name = cmd.slice(1).trim().toLowerCase();

    if (name === 'exit' || name === 'quit') return false;

    if (name === 'help') {
      console.log(HELP + '\n');
      return true;
    }

    // 记忆必须**能看见和能推翻**:模型拿到概括性输入后会判定「已经足够明确」
    // 然后照着复述、不去核实(见 context.ts 那条实测)—— 一条错的特征
    // 长得和对的一样权威,而它每轮都在注入
    if (name === 'memory' || name === 'memory clear') {
      const memory = session.memory;
      if (!memory) {
        console.log(dim('  长期记忆已关闭 (MEMORY_ENABLED=false)\n'));
        return true;
      }

      if (name === 'memory clear') {
        memory.clear();
        console.log(dim('  长期记忆已清空。注意本次会话的系统提示已经发出,') +
          dim('下次启动才完全生效\n'));
        return true;
      }

      const entries = memory.list();
      if (entries.length === 0) {
        console.log(dim('  还没有记录任何用户特征\n'));
        return true;
      }

      console.log(dim(`─── 长期记忆(${entries.length} 条)───`));
      for (const key of Object.keys(DIMENSION_LABELS) as Array<keyof typeof DIMENSION_LABELS>) {
        const inDim = entries.filter(e => e.dimension === key);
        if (inDim.length === 0) continue;
        console.log(`  ${bold(DIMENSION_LABELS[key])}`);
        for (const e of inDim) {
          // hits 要显示:它是淘汰依据,用户看到「确认 1 次」就知道这条还不稳
          console.log(`    ${e.text} ${dim(`(确认 ${e.hits} 次)`)}`);
        }
      }
      console.log(dim(`  存储: ${session.config.memory.dbPath}`));
      console.log(dim('  /memory clear 可全部清空\n'));
      return true;
    }

    if (name === 'stats') {
      const s = session.context.getStats();
      const ctx = session.config.context;
      console.log(dim('─── 统计 ───'));
      console.log(`  轮次 ${s.turns}   消息 ${s.messages}`);
      console.log(`  当前上下文 ${fmtTokens(s.tokens.total_prompt)} tokens` +
        ` / 窗口 ${fmtTokens(ctx.windowSize)}` +
        ` (${((s.tokens.total_prompt / ctx.windowSize) * 100).toFixed(2)}%)`);
      console.log(`  压缩阈值 ${fmtTokens(ctx.windowSize * ctx.compressionThreshold)} tokens` +
        `   已压缩 ${s.compressions} 次   主题 ${s.topics} 个`);
      console.log(`  累计输出 ${fmtTokens(s.tokens.total_completion)}   累计缓存 ${
        fmtTokens(s.tokens.total_cached)}`);
      console.log(`  缓存命中率 ${(s.tokens.cache_hit_rate * 100).toFixed(1)}%`);
      console.log(`  LLM 调用总数 ${session.recorder.count()}\n`);
      return true;
    }

    if (name === 'trace') {
      const last = session.recorder.last();
      if (!last) {
        console.log(dim('  还没有 LLM 调用\n'));
        return true;
      }
      console.log(dim('─── 最近一次调用 ───'));
      console.log(fmtCall(last));
      console.log(dim(`  完整请求/响应: ${last.file}\n`));
      return true;
    }

    if (name === 'calls') {
      const all = session.recorder.since(0);
      if (all.length === 0) {
        console.log(dim('  还没有 LLM 调用\n'));
        return true;
      }
      console.log(dim(`─── 全部 ${all.length} 次调用 ───`));
      all.forEach(c => console.log(fmtCall(c)));
      console.log(dim(`  目录: ${session.recorder.traceDir}\n`));
      return true;
    }

    if (name === 'context') {
      // 用只读快照:preparePrompt() 会触发 Mid-Turn 压缩,
      // 「看一眼上下文」不该改变上下文
      const messages = session.context.peekMessages();
      console.log(dim(`─── 当前消息结构(${messages.length} 条)───`));
      messages.forEach((m, i) => {
        const tc = m.role === 'assistant' && m.toolCalls?.length
          ? ` ${CYAN}[tool_calls: ${m.toolCalls.map(t => t.name).join(', ')}]${RESET}`
          : '';
        // 图片折成 [图片 xxx] 占位:base64 直接打出来会糊满整个终端
        const preview = messageToText(m.content ?? '').replace(/\s+/g, ' ').slice(0, 70);
        console.log(`  ${String(i).padStart(3)} ${m.role.padEnd(9)}${tc} ${dim(preview)}`);
      });
      console.log();
      return true;
    }

    console.log(dim(`  未知命令 ${cmd},输入 /help 查看可用命令\n`));
    return true;
  };

  if (singleShot) {
    console.log(`${bold('提问')} ${singleShot}`);
    await runTurn(singleShot);
    rl.close();
    await session.dispose();
    return;
  }

  console.log(dim('输入问题开始对话,/help 查看命令,/exit 退出\n'));
  rl.setPrompt('> ');
  rl.prompt();

  // 串行队列:readline 的 'line' 事件是同步派发的,async 处理器不会让它等待。
  // 管道输入(printf ... | npm run cli)会一次性吐出所有行,若不排队则:
  //   ① 多轮请求并发打到同一个 Context 上,消息顺序错乱
  //   ② /exit 抢先执行 process.exit(),把还在飞的 LLM 调用直接掐死
  let queue: Promise<void> = Promise.resolve();
  let closing = false;

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      if (closing) return;

      const input = line.trim();
      if (!input) return;

      if (input.startsWith('/')) {
        const keepGoing = await handleCommand(input);
        if (!keepGoing) {
          closing = true;
          rl.close();
          return;
        }
      } else {
        await runTurn(input);
      }

      if (!closing) rl.prompt();
    });
  });

  // 队列跑完后再收尾,避免管道输入时 close 早于最后一轮完成
  rl.on('close', () => {
    queue.then(async () => {
      const s = session.context.getStats();
      console.log(dim(`\n会话结束: ${s.turns} 轮,${session.recorder.count()} 次 LLM 调用`));
      if (session.config.trace.enabled && session.recorder.count() > 0) {
        console.log(dim(`留痕目录: ${path.resolve(session.recorder.traceDir)}`));
      }
      await session.dispose();
      process.exit(0);
    });
  });

  // Ctrl+C 走的是 SIGINT,不一定触发 rl 的 close。
  // 漏掉这条会留下孤儿 chromium —— 而 lock 文件的清理只在下次启动时生效,
  // 中间这段时间 profile 一直是锁着的
  process.on('SIGINT', () => {
    void session.dispose().finally(() => process.exit(0));
  });
}

main().catch(error => {
  console.error('CLI 启动失败:', error);
  process.exit(1);
});
