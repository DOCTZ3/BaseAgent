// ============================================
// Interface 层:CLI(本地效果测试入口)
// ============================================
//
// 职责：
// 1. 读 stdin 的多轮输入 → 交给 Orchestrator → 展示结果（壳，零业务逻辑）
// 2. 每轮回显可观测数值：token / 压缩是否触发 / 主题数 / 工具调用 / 耗时
// 3. 原始上下文和响应由 TraceRecorder 落盘，终端只给摘要 + 文件路径
//
// 关键设计：
// - 多轮共享同一个 ContextManager：反复调 orchestrator.run() 即可，
//   第二轮起只传单条 user 消息，会接到同一个 Context 上（压缩因此能真正触发）
// - 危险工具走真实终端确认，不再无条件放行（交互式测试与跑脚本的本质区别）
// - 空白名单会让所有 fs 工具被拒，启动时显式告警而不是让模型撞墙
//
// 用法：
//   npm run cli                  交互模式（REPL）
//   npm run cli -- "任务描述"     单发模式，跑完即退
//
// 斜杠命令见 HELP 常量。配置参数见 .env.example
// ============================================

import 'dotenv/config';
import readline from 'readline';
import path from 'path';
import {
  ConsoleLogger,
  LogLevel,
  loadConfig,
  TraceRecorder,
  type TraceSummary,
} from '../platform/index.js';
import { ToolRegistry, ToolRunner } from '../tools/index.js';
import { ContextManager, DeepSeekAdapter, Orchestrator } from '../core/index.js';
import {
  EchoTool,
  GetCurrentTimeTool,
  ReadFileTool,
  ListFilesTool,
  SearchFilesTool,
  WriteFileTool,
} from '../tools/builtin/index.js';

const HELP = `
可用命令：
  /stats     显示上下文与 token 统计
  /trace     显示最近一次 LLM 调用的摘要与文件路径
  /calls     列出本次会话所有 LLM 调用
  /context   打印当前发送给模型的消息结构
  /help      显示本帮助
  /exit      退出（Ctrl+C 亦可）

直接输入文字即为向 Agent 提问。
`.trim();

// ---------- 展示辅助 ----------

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

async function main() {
  const singleShot = process.argv.slice(2).join(' ').trim();

  // ---------- 配置 ----------
  const config = loadConfig();

  const logLevel = ({
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
  } as const)[config.logLevel] ?? LogLevel.INFO;

  const logger = new ConsoleLogger(logLevel);
  const modelConfig = config.models.main;
  const sessionId = `cli-${Date.now()}`;

  if (!modelConfig.apiKey) {
    console.error(`${RED}未设置 DEEPSEEK_API_KEY,无法调用真实 API${RESET}`);
    process.exit(1);
  }

  // 空白名单 = 所有 fs 工具都会被拒绝，模型会一路试路径撞墙并白烧 token。
  // 这是踩过的坑，必须显式告警。
  if (config.security.fsSandboxPaths.length === 0) {
    console.warn(
      `${YELLOW}警告: FS_SANDBOX_PATHS 未配置,文件类工具将全部被拒绝。${RESET}\n` +
      `${DIM}      在 .env 里设置,例如: FS_SANDBOX_PATHS=${process.cwd()}${RESET}`
    );
  }

  // ---------- 留痕 ----------
  const recorder = new TraceRecorder({
    sessionId,
    logger,
    baseDir: config.trace.dir,
    enabled: config.trace.enabled,
  });

  // ---------- 工具 ----------
  const registry = new ToolRegistry(logger);
  registry.register(new EchoTool());
  registry.register(new GetCurrentTimeTool());
  registry.register(new ReadFileTool());
  registry.register(new ListFilesTool());
  registry.register(new SearchFilesTool());
  registry.register(new WriteFileTool());

  const abortController = new AbortController();

  // 危险工具的真实终端确认（复用主 rl，避免两个 readline 抢 stdin）
  let confirmFn: (prompt: string) => Promise<boolean>;

  const runner = new ToolRunner(registry, {
    sessionId,
    logger,
    signal: abortController.signal,
    onConfirmRequired: async (req) => {
      const detail = JSON.stringify(req.args);
      return confirmFn(`${YELLOW}需要确认${RESET} ${req.toolName} ${dim(detail)}`);
    },
    allowDangerousTools: config.security.allowDangerousTools,
    fsSandboxPaths: config.security.fsSandboxPaths,
  });

  // ---------- LLM + 上下文 ----------
  const llmClient = new DeepSeekAdapter({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL!,
    model: modelConfig.model,
    enableThinking: modelConfig.enableThinking ?? true,
    retry: config.retry,
    onTrace: recorder.sink,
    logger,
  });

  const context = new ContextManager(
    {
      sessionId,
      windowSize: config.context.windowSize,
      compressionThreshold: config.context.compressionThreshold,
      recentTurnsToKeep: config.context.recentTurnsToKeep,
      maxTopicsInContext: config.context.maxTopicsInContext,
      // 高水位兜底：窗口快满但轮次门槛卡住时，突破门槛强制压缩
      highWaterRatio: config.context.highWaterRatio,
      // 压缩用的是同一个主模型，输出预算默认跟随它（避免硬编码值找不到）
      compressionMaxTokens: config.context.compressionMaxTokens,
      modelMaxTokens: modelConfig.maxTokens,
      compressionClip: config.context.compressionClip,
      retry: config.retry,
      logger,
    },
    llmClient
  );
  await context.initialize();

  const orchestrator = new Orchestrator(llmClient, runner, registry, {
    maxSteps: config.execution.maxSteps,
    logger,
    context,
  });

  // 系统提示只在会话开始时加一次。后续每轮只传 user 消息，
  // 让 ContextManager 把它们接到同一个 Turn 序列上（压缩才能真正生效）。
  context.addSystemMessage(
    '你是 BaseAgent，一个可以调用工具完成任务的 AI 助手。' +
    '需要读写文件、查询时间等操作时使用提供的工具，不要臆测工具结果。' +
    '工具返回错误时，说明原因而不是反复重试同一路径。'
  );

  // ---------- 启动信息 ----------
  console.log(bold('\nBaseAgent CLI'));
  console.log(dim(`  模型      ${modelConfig.model}  @ ${modelConfig.baseURL}`));
  console.log(dim(`  会话      ${sessionId}`));
  console.log(dim(`  窗口      ${fmtTokens(config.context.windowSize)} tokens,压缩阈值 ${config.context.compressionThreshold * 100}%,保留最近 ${config.context.recentTurnsToKeep} 轮`));

  // 压缩预算来源要能直接看见：之前是硬编码常量，改配置时根本找不到在哪
  const compBudget = config.context.compressionMaxTokens ?? modelConfig.maxTokens ?? 4000;
  const compSource = config.context.compressionMaxTokens ? '显式配置'
    : modelConfig.maxTokens ? '跟随主模型' : '内置兜底';
  console.log(dim(`  压缩预算  ${fmtTokens(compBudget)} tokens (${compSource}),工具结果截断 ${config.context.compressionClip.toolResult} 字`));
  console.log(dim(`  留痕      ${config.trace.enabled ? recorder.traceDir : '已关闭'}`));
  console.log(dim(`  沙箱      ${config.security.fsSandboxPaths.join(', ') || '(空)'}`));
  console.log(dim(`  危险工具  ${config.security.allowDangerousTools ? '已启用(需确认)' : '已禁用'}`));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  confirmFn = (prompt: string) =>
    new Promise<boolean>(resolve => {
      rl.question(`${prompt} [y/N] `, answer => {
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });

  // ---------- 单轮执行 + 回显 ----------
  const runTurn = async (input: string) => {
    const callsBefore = recorder.count();
    const statsBefore = context.getStats();
    const startedAt = Date.now();

    try {
      const result = await orchestrator.run([{ role: 'user', content: input }]);

      const elapsed = Date.now() - startedAt;
      const statsAfter = context.getStats();
      const newCalls = recorder.since(callsBefore);

      console.log(`\n${bold('回答')}\n${result}\n`);

      // 可观测回显：这一轮实际发生了什么
      console.log(dim('─── 本轮 LLM 调用 ───'));
      if (newCalls.length === 0) {
        console.log(dim('  (无)'));
      } else {
        newCalls.forEach(c => console.log(fmtCall(c)));
      }

      // 用真实压缩计数判断，不靠 turns 数量反推
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
      if (config.trace.enabled && newCalls.length > 0) {
        console.log(dim(`  trace: ${newCalls[0].file} … (共 ${newCalls.length} 个文件)`));
      }
      console.log();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`\n${RED}执行失败${RESET} ${msg}`);
      const failed = recorder.since(callsBefore);
      if (failed.length > 0) {
        console.error(dim('  相关调用:'));
        failed.forEach(c => console.error(fmtCall(c)));
        console.error(dim(`  请求体见: ${failed[failed.length - 1].file}`));
      }
      console.log();
    }
  };

  // ---------- 斜杠命令 ----------
  const handleCommand = async (cmd: string): Promise<boolean> => {
    const name = cmd.slice(1).trim().toLowerCase();

    if (name === 'exit' || name === 'quit') return false;

    if (name === 'help') {
      console.log(HELP + '\n');
      return true;
    }

    if (name === 'stats') {
      const s = context.getStats();
      console.log(dim('─── 统计 ───'));
      console.log(`  轮次 ${s.turns}   消息 ${s.messages}`);
      console.log(`  当前上下文 ${fmtTokens(s.tokens.total_prompt)} tokens` +
        ` / 窗口 ${fmtTokens(config.context.windowSize)}` +
        ` (${((s.tokens.total_prompt / config.context.windowSize) * 100).toFixed(2)}%)`);
      console.log(`  压缩阈值 ${fmtTokens(config.context.windowSize * config.context.compressionThreshold)} tokens` +
        `   已压缩 ${s.compressions} 次   主题 ${s.topics} 个`);
      console.log(`  累计输出 ${fmtTokens(s.tokens.total_completion)}   累计缓存 ${fmtTokens(s.tokens.total_cached)}`);
      console.log(`  缓存命中率 ${(s.tokens.cache_hit_rate * 100).toFixed(1)}%`);
      console.log(`  LLM 调用总数 ${recorder.count()}\n`);
      return true;
    }

    if (name === 'trace') {
      const last = recorder.last();
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
      const all = recorder.since(0);
      if (all.length === 0) {
        console.log(dim('  还没有 LLM 调用\n'));
        return true;
      }
      console.log(dim(`─── 全部 ${all.length} 次调用 ───`));
      all.forEach(c => console.log(fmtCall(c)));
      console.log(dim(`  目录: ${recorder.traceDir}\n`));
      return true;
    }

    if (name === 'context') {
      // 用只读快照：preparePrompt() 会触发 Mid-Turn 压缩，
      // 「看一眼上下文」不该改变上下文
      const messages = context.peekMessages();
      console.log(dim(`─── 当前消息结构(${messages.length} 条)───`));
      messages.forEach((m, i) => {
        const tc = m.role === 'assistant' && m.toolCalls?.length
          ? ` ${CYAN}[tool_calls: ${m.toolCalls.map(t => t.name).join(', ')}]${RESET}`
          : '';
        const preview = (m.content ?? '').replace(/\s+/g, ' ').slice(0, 70);
        console.log(`  ${String(i).padStart(3)} ${m.role.padEnd(9)}${tc} ${dim(preview)}`);
      });
      console.log();
      return true;
    }

    console.log(dim(`  未知命令 ${cmd},输入 /help 查看可用命令\n`));
    return true;
  };

  // ---------- 单发模式 ----------
  if (singleShot) {
    console.log(`${bold('提问')} ${singleShot}`);
    await runTurn(singleShot);
    rl.close();
    context.dispose();
    return;
  }

  // ---------- 交互模式 ----------
  console.log(dim('输入问题开始对话,/help 查看命令,/exit 退出\n'));

  rl.setPrompt('> ');
  rl.prompt();

  // 串行队列：readline 的 'line' 事件是同步派发的，async 处理器不会让它等待。
  // 管道输入（printf ... | npm run cli）会一次性吐出所有行，若不排队则：
  //   1. 多轮请求并发打到同一个 Context 上，消息顺序错乱
  //   2. /exit 抢先执行 process.exit()，把还在飞的 LLM 调用直接掐死
  // 所以这里把每行串成一条链，逐个 await。
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

  // 队列跑完后再收尾，避免管道输入时 close 早于最后一轮完成
  const finish = () => {
    queue.then(() => {
      const s = context.getStats();
      console.log(dim(`\n会话结束: ${s.turns} 轮,${recorder.count()} 次 LLM 调用`));
      if (config.trace.enabled && recorder.count() > 0) {
        console.log(dim(`留痕目录: ${path.resolve(recorder.traceDir)}`));
      }
      context.dispose();
      process.exit(0);
    });
  };

  rl.on('close', finish);
}

main().catch(error => {
  console.error('CLI 启动失败:', error);
  process.exit(1);
});
