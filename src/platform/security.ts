// ============================================
// 安全模块:沙箱权限检查
// ============================================

import * as path from 'path';
import * as fs from 'fs';

export class SecurityGuard {
  /**
   * @param allowedPaths 白名单:只有这些目录内的路径可访问
   * @param deniedPaths  黑名单:优先于白名单,即使在白名单内也拒绝。
   *                     用于存放「活凭证」的目录(如浏览器 profile) —— 里面的 cookie
   *                     等价于登录态,被 read_file 读进上下文后会跟着 trace 落盘
   */
  constructor(
    private allowedPaths: string[],
    private deniedPaths: string[] = [],
  ) {}

  /**
   * 检查文件路径是否在沙箱白名单内
   * @param targetPath 要访问的路径
   * @returns true=允许访问, false=拒绝
   */
  checkFsAccess(targetPath: string): boolean {
    return this.evaluate(targetPath).allowed;
  }

  /**
   * 断言路径可访问,否则抛出错误
   */
  assertFsAccess(targetPath: string): void {
    const verdict = this.evaluate(targetPath);
    if (!verdict.allowed) {
      throw new Error(verdict.reason);
    }
  }

  /**
   * 判定单个路径,同时给出可回流给模型的拒绝原因
   * 黑名单先判:它是白名单之上的例外,顺序反了就失效
   */
  private evaluate(targetPath: string): { allowed: boolean; reason: string } {
    const normalizedTarget = this.normalize(targetPath);

    for (const denied of this.deniedPaths) {
      if (this.contains(denied, normalizedTarget)) {
        return {
          allowed: false,
          reason:
            `访问被拒绝: 路径 "${targetPath}" 位于受保护目录 "${denied}" 内。\n` +
            `该目录存放凭证类数据,不允许通过文件工具读写。`,
        };
      }
    }

    for (const allowed of this.allowedPaths) {
      if (this.contains(allowed, normalizedTarget)) {
        return { allowed: true, reason: '' };
      }
    }

    return {
      allowed: false,
      reason:
        `访问被拒绝: 路径 "${targetPath}" 不在沙箱白名单内。\n` +
        `允许的路径: ${this.allowedPaths.join(', ')}`,
    };
  }

  /** 规范化路径(解析相对路径、符号链接) */
  private normalize(targetPath: string): string {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      // 文件不存在时,realpathSync 会抛错,用 resolve 替代
      return path.resolve(targetPath);
    }
  }

  /** parent 是否包含 target(或两者相同) */
  private contains(parent: string, normalizedTarget: string): boolean {
    const normalizedParent = path.resolve(parent);
    const relative = path.relative(normalizedParent, normalizedTarget);
    // relative 不以 '..' 开头 => target 在 parent 内部
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}
