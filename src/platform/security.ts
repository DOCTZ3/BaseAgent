// ============================================
// 安全模块:文件系统授权检查
// ============================================
//
// 三档判定(「授权才有权限」):
//   ① deny 列表  —— 优先于一切,即使落在授权范围内也拒绝(存放活凭证的目录)
//   ② 授权路径   —— rw 可读写 / ro 只读
//   ③ 其余       —— 读和写都拒绝
//
// **未授权也不可读**是刻意的:能读任意文件是 prompt 注入的主要入口
// (读到 .ssh / .env 再借浏览器发出去),而外发这条路在本地形态下拦不住,
// 所以只能在入口侧收紧。
//
// 读写必须分开判,不能共用一次检查:归档目录要让模型**读**(压缩后回溯早期
// 对话),但绝不能让它**写** —— 否则模型可以覆盖自己的归档。同理,用户临时
// 指定一份文档通常只需要读权限,不该顺带给写。
//
// 因此 mode 是**必填参数**、不给默认值:默认值会让漏传的调用点静默落到
// 宽松的一侧,而这类疏漏不会报错,只会变成安全缺口。

import * as path from 'path';
import * as fs from 'fs';

/** 本次访问的意图 */
export type FsMode = 'read' | 'write';

/** 授权级别 */
export type FsPermission = 'ro' | 'rw';

export interface FsGrant {
  path: string;
  mode: FsPermission;
}

interface Grant {
  root: string;
  mode: FsPermission;
}

export class SecurityGuard {
  private grants: Grant[];
  private denied: string[];

  /**
   * @param grants 授权列表。裸字符串按 rw 处理(兼容旧的 fsSandboxPaths 形态)
   * @param deniedPaths 黑名单,优先于授权列表
   */
  constructor(
    grants: ReadonlyArray<FsGrant | string>,
    deniedPaths: readonly string[] = [],
  ) {
    this.grants = grants
      .map(g =>
        typeof g === 'string'
          ? { root: path.resolve(g), mode: 'rw' as FsPermission }
          : { root: path.resolve(g.path), mode: g.mode },
      )
      // 长路径优先。同时授权 D:\a(rw) 和 D:\a\sub(ro) 时,sub 下的文件
      // 必须按更具体的那条判,否则外层 rw 会把内层 ro 淹掉
      .sort((a, b) => b.root.length - a.root.length);

    this.denied = deniedPaths.map(p => path.resolve(p));
  }

  checkFsAccess(targetPath: string, mode: FsMode): boolean {
    return this.evaluate(targetPath, mode).allowed;
  }

  /** 断言可访问,否则抛出带可执行建议的错误(会回流给模型) */
  assertFsAccess(targetPath: string, mode: FsMode): void {
    const verdict = this.evaluate(targetPath, mode);
    if (!verdict.allowed) {
      throw new Error(verdict.reason);
    }
  }

  /**
   * 授权快照
   *
   * 给两个地方用:CLI 启动横幅(让用户看见 agent 到底能碰哪些目录),
   * 以及 Python 侧的边界注入(两边必须同源,否则会出现
   * 「fs 工具读得到、Python 读不到」这类不报错的错位)。
   */
  listGrants(): ReadonlyArray<Grant> {
    return this.grants;
  }

  private evaluate(
    targetPath: string,
    mode: FsMode,
  ): { allowed: boolean; reason: string } {
    const target = this.normalize(targetPath);

    for (const denied of this.denied) {
      if (this.contains(denied, target)) {
        return {
          allowed: false,
          reason:
            `访问被拒绝: "${targetPath}" 位于受保护目录 "${denied}" 内。\n` +
            `该目录存放凭证类数据,不允许通过文件工具读写。`,
        };
      }
    }

    // 已排序,首个命中即最具体的那条授权
    for (const grant of this.grants) {
      if (!this.contains(grant.root, target)) continue;

      if (mode === 'write' && grant.mode === 'ro') {
        return {
          allowed: false,
          reason:
            `写入被拒绝: "${targetPath}" 所在目录 "${grant.root}" 是只读授权。\n` +
            `可以读取,但不能写入或删除。请改写到工作区内。`,
        };
      }
      return { allowed: true, reason: '' };
    }

    const rw = this.grants.filter(g => g.mode === 'rw').map(g => g.root);
    const ro = this.grants.filter(g => g.mode === 'ro').map(g => g.root);
    return {
      allowed: false,
      reason:
        `访问被拒绝: "${targetPath}" 不在已授权的范围内(${mode === 'write' ? '写入' : '读取'})。\n` +
        `可读写: ${rw.join(', ') || '(无)'}\n` +
        (ro.length ? `只读  : ${ro.join(', ')}\n` : '') +
        `需要访问其他位置时,请说明用途并请用户授权该目录。`,
    };
  }

  /** 规范化路径(解析相对路径与符号链接) */
  private normalize(targetPath: string): string {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      // 文件不存在时 realpathSync 抛错(如写入新文件),退回 resolve。
      // 此时父目录可能是符号链接 —— 但要借此逃逸得先在授权范围内建链接,
      // 而建链接本身是写操作、会被这里拦住
      return path.resolve(targetPath);
    }
  }

  /** parent 是否包含 target(或两者相同) */
  private contains(parent: string, normalizedTarget: string): boolean {
    const relative = path.relative(parent, normalizedTarget);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}
