// ============================================
// Interface 层:危险工具的确认文案
// ============================================
//
// 单独一个模块而不是留在 cli.ts:cli.ts 在模块级调 main(),
// 从测试里 import 它会把整个 CLI 跑起来。而这段**值得测** ——
// 它是 run_command 唯一的安全机制所在(见下)。
// ============================================

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';

const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;

/**
 * 危险工具的确认文案
 *
 * `run_command` 单独排版、不用 JSON —— 这不是审美问题:
 * 这个工具**唯一的安全机制**就是用户读那一行命令并判断。而 JSON.stringify
 * 会把 Windows 路径的反斜杠双写(`C:\foo` → `C:\\foo`)、还把整条命令
 * 和其他字段挤成一行。命令必须原样、独占一行、最显眼 ——
 * typosquatting 的整个攻击面就是一两个字符的差别(见 run-command.ts)。
 *
 * 其余工具保持 JSON:它们的入参是结构化的,JSON 反而更清楚。
 */
export function formatConfirm(req: {
  toolName: string;
  args: Record<string, unknown>;
}): string {
  if (req.toolName === 'run_command' && typeof req.args.command === 'string') {
    const reason = typeof req.args.reason === 'string' ? req.args.reason : undefined;
    const timeout =
      typeof req.args.timeout_ms === 'number' ? req.args.timeout_ms : undefined;

    return [
      `${YELLOW}需要确认${RESET} 执行外部命令`,
      // 原样、独占一行、加粗 —— 用户真正要读的就是这一行
      `  ${bold(req.args.command)}`,
      ...(reason ? [dim(`  理由: ${reason}`)] : []),
      ...(timeout ? [dim(`  超时: ${Math.round(timeout / 1000)}s`)] : []),
      '  执行?',
    ].join('\n');
  }

  return `${YELLOW}需要确认${RESET} ${req.toolName} ${dim(JSON.stringify(req.args))}`;
}
