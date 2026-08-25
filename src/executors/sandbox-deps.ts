// ============================================
// Executors 层:沙箱基线依赖的启动检测
// ============================================
//
// 为什么要检测:提示词里写着「沙箱已预装 playwright、pandas、pypdf…」——
// 那句话在开发机上碰巧是真的,在一台新机器上是**假的**。
// 模型会照着一个不存在的前提写代码,撞 ImportError;而代码里的 pip 已被禁
// (BLOCK_PIP_INSTALL),它**自己修不了**,只能反复试或者放弃。
// 与其让模型在运行时踩,不如启动时一次说清。
//
// 为什么**只检测、不自动装**:
// - 基线依赖装进的是**系统环境**(共享资源),自动往里装等于替用户决定
//   要不要升级他别的项目在用的包 —— 这正是本轮要避免的冲突
// - playwright 的 chromium 上百 MB,启动时静默拉几分钟是很差的体验
// - 而「模型中途要的临时依赖」走 run_command,每次经用户确认、落进 venv。
//   两条路各自对应「谁做的决定」,不该混
//
// 依赖清单的**单一来源**是 sandbox-requirements.txt:
// 这里的表只多存一样东西 —— **import 名**。因为 import 名和安装名常常不同
// (python-docx→docx、beautifulsoup4→bs4),而这个不一致正是 typosquatting
// 的着力点(见 run-command.ts)。两处都手写必然漂移,所以有一个测试断言
// 本表的每个包名都出现在 requirements 文件里。
// ============================================

import { spawn } from 'child_process';
import * as path from 'path';

interface DepsLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 基线依赖:import 名 → 安装名
 *
 * 顺序即告警里的展示顺序,按重要性排:playwright 缺了浏览器整块没了,
 * requests/bs4 缺了只影响少数场景。
 */
export const SANDBOX_DEPS: ReadonlyArray<{ importName: string; packageName: string }> = [
  { importName: 'playwright', packageName: 'playwright' },
  { importName: 'docx', packageName: 'python-docx' },
  { importName: 'openpyxl', packageName: 'openpyxl' },
  { importName: 'pypdf', packageName: 'pypdf' },
  { importName: 'pandas', packageName: 'pandas' },
  { importName: 'requests', packageName: 'requests' },
  { importName: 'bs4', packageName: 'beautifulsoup4' },
];

/** 依赖清单文件名(单一来源,版本下限写在里面) */
export const REQUIREMENTS_FILE = 'sandbox-requirements.txt';

export interface CheckDepsResult {
  /** 全部就位 */
  ok: boolean;
  /** 缺失的**安装名**(可直接拼进 pip 命令) */
  missing: string[];
  /** 检测本身失败时的原因(解释器跑不起来等);此时 missing 为空 */
  error?: string;
  /** 给用户照抄的安装命令。ok 时为 undefined */
  hint?: string;
}

/**
 * 检测沙箱解释器能否 import 基线依赖
 *
 * 用 `importlib.util.find_spec` 而不是真 import:后者会真加载,
 * 一次 `import pandas` 要一两秒、还触发上千次文件访问 —— 启动时不该付这个成本。
 *
 * 不抛异常:检测失败以 ok:false + error 返回。检测本身不该阻塞启动。
 */
export async function checkSandboxDeps(
  pythonPath: string,
  logger: DepsLogger,
  timeout = 30_000,
): Promise<CheckDepsResult> {
  const imports = SANDBOX_DEPS.map(d => d.importName);

  // 一次子进程查全部,不是每个库起一次:后者在 Windows 上光进程启动就要几秒
  const probe =
    'import importlib.util as u\n' +
    `for m in ${JSON.stringify(imports)}:\n` +
    '    print(m if u.find_spec(m) is None else "")\n';

  const run = await runProbe(pythonPath, probe, timeout);

  if (!run.ok) {
    logger.warn('沙箱依赖检测失败', { error: run.error });
    return { ok: false, missing: [], error: run.error };
  }

  const missingImports = new Set(
    run.stdout.split('\n').map(s => s.trim()).filter(Boolean),
  );

  const missing = SANDBOX_DEPS.filter(d => missingImports.has(d.importName)).map(
    d => d.packageName,
  );

  if (missing.length === 0) {
    logger.debug('沙箱基线依赖齐备', { count: SANDBOX_DEPS.length });
    return { ok: true, missing: [] };
  }

  logger.warn('沙箱基线依赖缺失', { missing });

  // 提示装到**系统环境**(基线依赖的归属),而不是 venv ——
  // venv 是 --system-site-packages 建的,系统装好就借过来了,不必装两份
  const hint =
    `请装到你的 Python 环境(一次即可):\n` +
    `        python -m pip install -r ${REQUIREMENTS_FILE}` +
    (missing.includes('playwright')
      ? `\n        python -m playwright install chromium   # chromium 需单独一步`
      : '');

  return { ok: false, missing, hint };
}

/** 起子进程跑探测脚本。不抛异常 */
function runProbe(
  pythonPath: string,
  code: string,
  timeout: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise(resolve => {
    // -c 足够:这段探测是框架自己写的固定短代码,没有多行中文与转义问题
    // (模型的代码才必须走临时文件,见 python-executor.ts)
    const child = spawn(pythonPath, ['-X', 'utf8', '-c', code], {
      windowsHide: true,
      // cwd 用项目根:探测不碰工作区,也不该受它影响
      cwd: path.resolve('.'),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ ok: false, stdout: '', error: `检测超时(${timeout}ms)` });
    }, timeout);

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf-8')).slice(-1000);
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 最常见的是 ENOENT:解释器路径不对
      resolve({ ok: false, stdout: '', error: err.message });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true, stdout }
          : {
              ok: false,
              stdout: '',
              error: `退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
            },
      );
    });
  });
}
