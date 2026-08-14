// ============================================
// 安全模块:沙箱权限检查
// ============================================

import * as path from 'path';
import * as fs from 'fs';

export class SecurityGuard {
  constructor(private allowedPaths: string[]) {}

  /**
   * 检查文件路径是否在沙箱白名单内
   * @param targetPath 要访问的路径
   * @returns true=允许访问, false=拒绝
   */
  checkFsAccess(targetPath: string): boolean {
    // 规范化路径(解析相对路径、符号链接)
    let normalizedTarget: string;
    try {
      normalizedTarget = fs.realpathSync(targetPath);
    } catch {
      // 文件不存在时,realpathSync 会抛错,用 resolve 替代
      normalizedTarget = path.resolve(targetPath);
    }

    // 检查是否在任意白名单路径内
    for (const allowed of this.allowedPaths) {
      const normalizedAllowed = path.resolve(allowed);

      // 检查 target 是否在 allowed 目录下(或就是 allowed 本身)
      const relative = path.relative(normalizedAllowed, normalizedTarget);

      // relative 不以 '..' 开头 => target 在 allowed 内部
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 断言路径可访问,否则抛出错误
   */
  assertFsAccess(targetPath: string): void {
    if (!this.checkFsAccess(targetPath)) {
      throw new Error(
        `访问被拒绝: 路径 "${targetPath}" 不在沙箱白名单内。\n` +
        `允许的路径: ${this.allowedPaths.join(', ')}`
      );
    }
  }
}
