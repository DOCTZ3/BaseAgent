// ============================================
// Executors 层:进程树回收(Python 与 Shell 共用)
// ============================================
//
// 抽出来是因为这段有平台分叉、而且**踩过坑**:
// 只杀直接子进程会留下孤儿 chromium(Playwright 拉起的),它还锁着 profile 目录,
// 导致下一轮 launch_persistent_context 直接失败。
// shell 那侧同理 —— `npm install` / `pip install` 都会拉起子进程。
// 两处各写一份必然漂移,而漂移的表现是「换个执行器就留孤儿进程」。
// ============================================

import { spawn } from 'child_process';

/**
 * 杀掉整个进程树
 *
 * @param pid 直接子进程的 pid。undefined(spawn 失败)时无操作
 *
 * 前提:POSIX 下调用方必须用 `detached: true` 起进程,子进程才自成进程组、
 * 负 pid 才能杀整组。Windows 没有进程组,借 taskkill /T 递归。
 */
export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }

  try {
    // detached 让子进程自成进程组,负 pid = 杀整组
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出了
    }
  }
}
