// ============================================
// Executors 层:沙箱 venv 的自动准备(启动时)
// ============================================
//
// 为什么要框架管、不让用户自己建:
// 「照文档跑一条命令」这件事在每台新机器上都会重来一次,而做错的三种方式
// 都不报错在正确的地方 ——
//   ① 忘了建 → PYTHON_PATH 指向不存在的解释器 → **每次** execute_python
//      都是 spawn ENOENT,模型以为是自己代码错了(实测踩到过一次)
//   ② 忘了 --system-site-packages → 预装库(playwright/pandas)全部消失,
//      而代码里的 pip 已被禁,模型装不回来 → 沙箱直接瘫
//   ③ 路径写成 Scripts/ 却在 Linux 上跑(或反之)→ 同 ①
// 这三件都是可推导的,没有理由交给人。
//
// venv 存在的理由(与「装包要不要确认」是两件事):
//   确认管的是**授权** —— 这个包该不该装;venv 管的是**爆炸半径** ——
//   授权之后影响落在哪里。确认有一件事结构上做不到:它没法把**连带影响**
//   给你看。实测事故里用户批准的是 `pip install rapidocr_onnxruntime`,
//   实际发生的是 onnxruntime 被升级 —— 那不在用户读的那行字里,
//   是 pip 在点下同意**之后**解析依赖树才算出来的。而 pip 没有 undo。
//   有 venv,那次批准的后果就限定在项目内,删掉重建即可撤销。
//
// 关键设计：
// - **venv 目录必须在工作区之外**。放进去的话模型的代码能改 venv 自身
//   (含将来可能放进去的任何约束),隔离就自己交出去了。默认放项目根下,
//   在工作区内时**降级为不使用 venv** 并告警 —— 宁可没有隔离,
//   不可给一个假的隔离
// - **带 `--system-site-packages`**:干净 venv 会让预装库全丢,
//   而代码里的 pip 已被禁(BLOCK_PIP_INSTALL),模型装不回来
// - **失败不阻塞启动**:回落到基础解释器并告警。沙箱能用但没有隔离,
//   比 CLI 起不来好 —— 后者用户完全没法干活
// - 解释器子路径按平台推导(Scripts/python.exe vs bin/python),不进配置:
//   写进 .env 就会跟着机器漂移,而它是可推导的
//
// 已知代价(摩擦,不是污染):`--system-site-packages` 下 pip 可能把系统里
// 已有的包判为 already satisfied 而不装进 venv,于是要的版本没到手。
// 装的动作始终落在 venv 的 site-packages 里,不会回头污染全局。
// ============================================

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

interface VenvLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EnsureVenvOptions {
  /** venv 目录(应在工作区之外)。相对路径按项目根解析 */
  venvDir: string;
  /** 建 venv 用的基础解释器(通常是 PATH 上的 python) */
  baseInterpreter: string;
  /**
   * 工作区。只用于**校验** venv 不在它里面 ——
   * 在里面的话模型的代码能改 venv 自身
   */
  workspace?: string;
  /** 创建超时(ms)。建 venv 通常几秒,给宽一点 */
  timeout?: number;
  logger: VenvLogger;
}

export interface EnsureVenvResult {
  /** 该用的解释器路径(绝对)。失败时是基础解释器 */
  pythonPath: string;
  /** venv 是否可用 */
  ok: boolean;
  /** 本次是否新建了 venv(用于启动信息措辞) */
  created: boolean;
  /** ok:false 时的原因,展示给用户 */
  reason?: string;
}

/**
 * venv 内解释器的相对位置 —— 按平台推导,不进配置
 *
 * 写进 .env 的后果是「换个系统就 ENOENT」,而它完全可推导。
 */
export function venvInterpreterPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/**
 * 确保沙箱 venv 存在,返回该用的解释器路径
 *
 * 幂等:已存在且可用就直接返回,不重复创建。
 * 任何失败都回落到基础解释器 + 告警,不抛异常 —— 沙箱没有隔离仍能干活,
 * 而 CLI 起不来的话用户什么都干不了。
 */
export async function ensureSandboxVenv(
  opts: EnsureVenvOptions,
): Promise<EnsureVenvResult> {
  const venvDir = path.resolve(opts.venvDir);
  const interpreter = venvInterpreterPath(venvDir);
  const fallback: Omit<EnsureVenvResult, 'reason'> = {
    pythonPath: opts.baseInterpreter,
    ok: false,
    created: false,
  };

  // venv 在工作区内 = 模型的代码能改 venv 自身,隔离形同虚设。
  // 宁可明说「没有隔离」,也不给一个假的
  if (opts.workspace && isInside(venvDir, path.resolve(opts.workspace))) {
    const reason =
      `venv 目录在工作区内(${venvDir}),模型的代码能改动它 —— 已跳过。` +
      '请把 SANDBOX_VENV_DIR 指到工作区之外(默认的项目根目录即可)。';
    opts.logger.warn('沙箱 venv 位置不安全,已跳过', { venv_dir: venvDir });
    return { ...fallback, reason };
  }

  // 已经可用就别动:重复跑 venv 虽幂等,但每次启动多等几秒没必要
  if (await exists(interpreter)) {
    opts.logger.debug('沙箱 venv 已存在', { python: interpreter });
    return { pythonPath: interpreter, ok: true, created: false };
  }

  opts.logger.info('沙箱 venv 不存在,正在创建', {
    venv_dir: venvDir,
    base: opts.baseInterpreter,
  });

  // --system-site-packages 是必须的:干净 venv 会让 playwright/pandas 全丢,
  // 而代码里的 pip 已被禁,模型装不回来 —— 沙箱直接瘫
  const created = await runVenvCreate(
    opts.baseInterpreter,
    ['-m', 'venv', '--system-site-packages', venvDir],
    opts.timeout ?? 120_000,
  );

  if (!created.ok) {
    const reason =
      `创建失败:${created.error}。` +
      `已回落到 ${opts.baseInterpreter}(能跑代码,但模型装的包会进全局环境)。` +
      `手动创建:${opts.baseInterpreter} -m venv --system-site-packages ${venvDir}`;
    opts.logger.warn('沙箱 venv 创建失败,回落到基础解释器', { error: created.error });
    return { ...fallback, reason };
  }

  // 建完必须验一次:目录建出来了但解释器跑不起来的话,
  // 后面**每次** execute_python 都失败,而错误信息指向的是模型的代码
  if (!(await exists(interpreter))) {
    const reason =
      `创建后未找到解释器(${interpreter})。已回落到 ${opts.baseInterpreter}。`;
    opts.logger.warn('沙箱 venv 创建后解释器缺失', { expected: interpreter });
    return { ...fallback, reason };
  }

  opts.logger.info('沙箱 venv 已创建', { python: interpreter });
  return { pythonPath: interpreter, ok: true, created: true };
}

/** 起子进程建 venv。不抛异常,失败以 ok:false + error 返回 */
function runVenvCreate(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ ok: false, error: `超时(${timeout}ms)` });
    }, timeout);

    child.stderr?.on('data', (c: Buffer) => {
      // 只留尾部:venv 的报错通常在最后几行
      stderr = (stderr + c.toString('utf-8')).slice(-2000);
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 最常见的是 ENOENT:基础解释器不在 PATH 上
      resolve({ ok: false, error: err.message });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, error: `退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}` },
      );
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** child 是否在 parent 里(或就是 parent) */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
