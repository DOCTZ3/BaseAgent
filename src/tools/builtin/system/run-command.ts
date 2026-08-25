// ============================================
// 系统工具:run_command(调用机器上的外部程序,每次请用户确认)
// ============================================
//
// 存在的唯一理由是**让危险操作变得可读**。
//
// 此前模型在 execute_python 里写:
//   subprocess.run([sys.executable, "-m", "pip", "install", "-q", "rapidocr_onnxruntime"])
// 返回码 0、静默成功,顺带升级了用户全局环境里的 onnxruntime,
// 用户是**事后翻 trace** 才发现的。
//
// execute_python 本来就是危险工具、也在逐次确认 —— 但那是一屏 40 行代码里的
// 第 23 行,人不会看清包名。而单独一行 `pip install rapidocr_onnxruntime`
// 用户会真的读清。这个差别就是本工具的全部价值:
// typosquatting(抢注近似包名,`pip install` 在**安装期**执行 setup.py,
// 等于远程代码执行)的整个攻击面就是一两个字符的差别,
// 只有「原样命令单独呈现」才拦得住。写边界拦不住它 ——
// pip 的构建隔离恰好在放行的 TEMP 目录里跑。
//
// 代价(明确接受):安全性**完全来自人工确认**,没有任何机制边界。
// Python 的写边界(audit hook)对这里无效 —— 那是进程内的钩子,
// shell 起的进程根本不经过它。同类工具(Claude Code / Codex)也是这个形状。
//
// 所以有两条设计约束,少一条这个工具就失去意义:
// ① 确认里显示**原样命令**,不摘要(见 cli.ts 的 onConfirmRequired)
// ② 调用量必须低 —— 确认疲劳是真的:模型拿它去 ls/cat/git status,
//    用户点二十次之后就变条件反射,那个拼错一个字母的 pip 也会一起过。
//    收敛之后日常操作本来就在 Python 里,description 里再把这条讲明。
// ============================================

import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../../contract.js';
import type { ShellExecutor } from '../../../executors/index.js';

export class RunCommandTool implements Tool {
  name = 'run_command';

  /**
   * @param shellName 实际使用的 shell(如 cmd.exe / /bin/sh),写进 description
   *
   * 必须告知:Windows 上 `shell: true` 用的是 cmd.exe,
   * 模型若按 bash 习惯写 `ls`、`grep`、`$VAR` 会直接失败 ——
   * 而那种失败看起来像「工具坏了」,很难让它自己纠偏。
   */
  constructor(private shellName = '系统默认 shell') {
    this.description = [
      `调用机器上已安装的外部程序。命令交给 ${shellName} 执行(支持管道与 && )。`,
      '',
      '**每次调用都会请用户确认**,他会看到原样命令。所以:',
      '  · 只在需要调用外部程序时用 —— pip / git / ffmpeg / npm 这一类',
      '  · 查时间、读写文件、列目录、解析文档、处理数据一律写 execute_python,',
      '    不要用这个工具做那些事(每次都打断用户,调多了确认就变成走过场)',
      '  · 能合并的合并成一条,不要拆成好几次调用',
      '',
      '最常见的用途是装第三方库:代码里装不了(pip 被配置为不查索引,',
      'subprocess 跑 pip install 会拿到「No matching distribution found」),',
      '这里是唯一的正式通道。',
      '装包前请在调用理由里写清**为什么需要这个包**,并确认包名拼写正确 ——',
      '用户是靠你给的这一行做判断的。',
      '',
      '注意 import 名和安装名常常不同:',
      '  import cv2     → pip install opencv-python',
      '  import PIL     → pip install pillow',
      '  import sklearn → pip install scikit-learn',
      '不确定安装名时,先说明你要装什么、让用户确认,不要凭猜测装 ——',
      '猜错的名字可能是别人抢注的恶意包。',
      '',
      '返回 stdout / stderr / 退出码。失败时按 stderr 改,不要反复重试同一条命令。',
    ].join('\n');
  }

  description: string;

  parameters = z.object({
    command: z
      .string()
      .min(1)
      .describe('要执行的完整命令行,例如 pip install pillow。会原样展示给用户确认'),
    reason: z
      .string()
      .optional()
      .describe('为什么要跑这条命令。会展示给用户,帮他判断该不该批准'),
    timeout_ms: z
      .number()
      .optional()
      .describe('超时(毫秒)。装大包(如 torch)可以调大'),
  });

  needs = ['shell'] as const;

  // 这是本工具的核心性质,不是可选项:安全性全部来自这次确认。
  // execute_python 反过来是 danger:false —— 它有写边界兜着不可逆操作,
  // 而这里什么机制边界都没有
  danger = true;

  async run(
    args: { command: string; reason?: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const shell = ctx.executors.shell as ShellExecutor | undefined;

    if (!shell) {
      return { ok: false, error: 'Shell 执行器未初始化(未配置工作区或 SHELL_ENABLED=false)' };
    }

    ctx.logger.info('执行外部命令', { command: args.command, reason: args.reason });

    try {
      const result = await shell.run(args.command, { timeout: args.timeout_ms });

      if (result.timedOut) {
        return {
          ok: false,
          error:
            `命令超时(${result.durationMs}ms),进程树已终止。\n` +
            '装大包可以用 timeout_ms 调大。\n' +
            (result.stdout ? `超时前输出:\n${clip(result.stdout, 1000)}` : ''),
        };
      }

      if (!result.ok) {
        return {
          ok: false,
          error:
            `退出码 ${result.exitCode}。\n` +
            (result.stderr.trim() ? `stderr:\n${clip(result.stderr, 2000)}\n` : '') +
            (result.stdout.trim() ? `stdout:\n${clip(result.stdout, 1000)}` : ''),
        };
      }

      return {
        ok: true,
        data: {
          stdout: clip(result.stdout, 4000),
          // 成功但有 stderr 是常态(pip 的 warning 都走 stderr),要让模型看见
          ...(result.stderr.trim() ? { stderr: clip(result.stderr, 1000) } : {}),
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          // 截断了要说:否则模型会以为看到了全部输出
          ...(result.stdoutTruncated
            ? { note: `输出共 ${result.stdoutBytes} 字节,已截断` }
            : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '命令执行失败',
      };
    }
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(已截断)` : text;
}
