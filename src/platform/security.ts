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
  private baseDir: string;

  /**
   * @param grants 授权列表。裸字符串按 rw 处理(兼容旧的 fsSandboxPaths 形态)
   * @param deniedPaths 黑名单,优先于授权列表
   * @param baseDir 相对路径的解析基准,应为**工作区**。缺省退回 process.cwd()
   *
   * 为什么基准必须是工作区、而不是进程 cwd:Python 子进程的 cwd 就是工作区,
   * 于是模型在代码里写 `view_image(path="chart.png")` 时,文件确实在那儿
   * (`os.path.exists` 为 True),但经工具桥回到 TS 后按进程 cwd(项目目录)解析,
   * 就变成了另一个文件 —— 实测被拒。两边基准必须同源。
   */
  constructor(
    grants: ReadonlyArray<FsGrant | string>,
    deniedPaths: readonly string[] = [],
    baseDir?: string,
  ) {
    this.baseDir = path.resolve(baseDir || process.cwd());
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

  /**
   * 断言可访问,否则抛出带可执行建议的错误(会回流给模型)
   *
   * **返回检查时用的那个绝对路径,调用方必须拿它去做实际 IO。**
   * 否则「检查路径 A、读取路径 B」——相对路径两次解析基准不同、
   * 或中途符号链接被替换,都会变成绕过检查的读写。
   */
  assertFsAccess(targetPath: string, mode: FsMode): string {
    const verdict = this.evaluate(targetPath, mode);
    if (!verdict.allowed) {
      throw new Error(verdict.reason);
    }
    return verdict.resolved;
  }

  /**
   * 授权快照
   *
   * 给两个地方用:客户端启动信息(让用户看见 agent 到底能碰哪些目录),
   * 以及 Python 侧的边界注入(两边必须同源,否则会出现
   * 「fs 工具读得到、Python 读不到」这类不报错的错位)。
   */
  listGrants(): ReadonlyArray<Grant> {
    return this.grants;
  }

  private evaluate(
    targetPath: string,
    mode: FsMode,
  ): { allowed: boolean; reason: string; resolved: string } {
    const target = this.normalize(targetPath);

    for (const denied of this.denied) {
      if (this.contains(denied, target)) {
        return {
          allowed: false,
          resolved: target,
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
          resolved: target,
          reason:
            `写入被拒绝: "${targetPath}" 所在目录 "${grant.root}" 是只读授权。\n` +
            `可以读取,但不能写入或删除。请改写到工作区内。`,
        };
      }
      return { allowed: true, reason: '', resolved: target };
    }

    const rw = this.grants.filter(g => g.mode === 'rw').map(g => g.root);
    const ro = this.grants.filter(g => g.mode === 'ro').map(g => g.root);
    return {
      allowed: false,
      resolved: target,
      reason:
        `访问被拒绝: "${targetPath}" 不在已授权的范围内(${mode === 'write' ? '写入' : '读取'})。\n` +
        `可读写: ${rw.join(', ') || '(无)'}\n` +
        (ro.length ? `只读  : ${ro.join(', ')}\n` : '') +
        `需要访问其他位置时,请说明用途并请用户授权该目录。`,
    };
  }

  /**
   * 规范化路径(解析相对路径与符号链接)
   *
   * 相对路径按 baseDir(工作区)解析,**不用 process.cwd()** ——
   * Python 子进程的 cwd 是工作区,两边基准不同就会出现
   * 「代码里 os.path.exists 为 True,经桥调工具却被拒」这种错位(实测)。
   */
  private normalize(targetPath: string): string {
    const absolute = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.baseDir, targetPath);

    try {
      return fs.realpathSync(absolute);
    } catch {
      // 文件不存在时 realpathSync 抛错(如写入新文件),退回 resolve。
      // 此时父目录可能是符号链接 —— 但要借此逃逸得先在授权范围内建链接,
      // 而建链接本身是写操作、会被这里拦住
      return path.resolve(absolute);
    }
  }

  /** parent 是否包含 target(或两者相同) */
  private contains(parent: string, normalizedTarget: string): boolean {
    const relative = path.relative(parent, normalizedTarget);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}
