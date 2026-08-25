// ============================================
// 文件系统执行器
// ============================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { SecurityGuard } from '../platform/security.js';

export class FsDriver {
  constructor(
    private securityGuard: SecurityGuard
  ) {}

  /**
   * 读取文件内容
   *
   * 用 assertFsAccess 返回的**已解析路径**去读,不用入参 —— 否则就是
   * 「检查路径 A、读取路径 B」:相对路径两次解析基准不同时会读到别的文件。
   * 下面每个方法同理。
   */
  async readFile(filePath: string): Promise<string> {
    const resolved = this.securityGuard.assertFsAccess(filePath, 'read');
    return await fs.readFile(resolved, 'utf-8');
  }

  /**
   * 读取文件原始字节
   *
   * 图片等二进制文件不能走 readFile 的 utf-8 解码 —— 那会把字节流破坏成
   * 替换字符，base64 编码出来的东西服务端根本认不出格式。
   */
  async readFileBytes(filePath: string): Promise<Buffer> {
    const resolved = this.securityGuard.assertFsAccess(filePath, 'read');
    return await fs.readFile(resolved);
  }

  /**
   * 列出目录内容
   */
  async listDirectory(dirPath: string): Promise<string[]> {
    const resolved = this.securityGuard.assertFsAccess(dirPath, 'read');
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    return entries.map(entry => {
      const name = entry.name;
      return entry.isDirectory() ? `${name}/` : name;
    });
  }

  /**
   * 递归搜索匹配模式的文件
   * @param baseDir 搜索起始目录
   * @param pattern 匹配模式(支持 * 和 **)
   * @param maxDepth 最大递归深度
   */
  async searchFiles(
    baseDir: string,
    pattern: string,
    maxDepth: number
  ): Promise<string[]> {
    const resolved = this.securityGuard.assertFsAccess(baseDir, 'read');

    const results: string[] = [];
    const regex = this.patternToRegex(pattern);

    await this.searchRecursive(resolved, resolved, regex, maxDepth, 0, results);

    return results;
  }

  /**
   * 写入文件(会自动创建父目录)
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    // 走 write 检查：只读授权（如归档目录）到这里会被拒
    const resolved = this.securityGuard.assertFsAccess(filePath, 'write');

    // 确保父目录存在
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(resolved, content, 'utf-8');
  }

  // ============================================
  // 私有辅助方法
  // ============================================

  /**
   * 递归搜索实现
   */
  private async searchRecursive(
    baseDir: string,
    currentDir: string,
    regex: RegExp,
    maxDepth: number,
    currentDepth: number,
    results: string[]
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        // 递归子目录
        await this.searchRecursive(
          baseDir,
          fullPath,
          regex,
          maxDepth,
          currentDepth + 1,
          results
        );
      } else if (entry.isFile()) {
        // 检查文件名是否匹配
        if (regex.test(relativePath.replace(/\\/g, '/'))) {
          results.push(relativePath);
        }
      }
    }
  }

  /**
   * 将 glob 模式转换为正则表达式
   * 支持:
   *   * 匹配单段(不跨目录)
   *   ** 匹配任意深度
   */
  private patternToRegex(pattern: string): RegExp {
    // 转义正则特殊字符(保留 * 不转义)
    let regex = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    // ** 替换为匹配任意路径
    regex = regex.replace(/\*\*/g, '.*');

    // * 替换为匹配单段(不含 /)
    regex = regex.replace(/\*/g, '[^/]*');

    return new RegExp(`^${regex}$`);
  }
}
