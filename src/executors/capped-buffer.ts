// ============================================
// Executors 层:带上限的字节缓冲(子进程输出兜底)
// ============================================
//
// 从 python-executor 抽出来,给 Python 与 Shell 两个执行器共用。
// 抽出来的理由是**已经踩过的坑**:CRLF 归一和「截断劈开多字节字符」两处修复
// 只改一份会漂移,而漂移的表现是「换个执行器输出就满屏 \r\n」。
// ============================================

/**
 * 带上限的字节缓冲:超限后丢弃新数据,但记账总量
 *
 * 记账是为了给模型量化提示（"你打印了 1.8MB"比"输出过大"有用得多）。
 * 按字节而非字符截断,再在末尾切掉可能被劈开的多字节字符。
 */
export class CappedBuffer {
  private chunks: Buffer[] = [];
  private kept = 0;
  totalBytes = 0;
  overflowed = false;

  constructor(private limit: number) {}

  push(chunk: Buffer) {
    this.totalBytes += chunk.length;

    if (this.kept >= this.limit) {
      this.overflowed = true;
      return;
    }

    const room = this.limit - this.kept;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, room));
      this.kept = this.limit;
      this.overflowed = true;
    }
  }

  toString(): string {
    // 截断可能把一个 UTF-8 字符劈成两半,末尾会出现替换字符;去掉它
    const text = Buffer.concat(this.chunks).toString('utf-8');
    const clean = this.overflowed ? text.replace(/�+$/, '') : text;

    // CRLF 归一成 LF：Windows 上 print 每行都产出 \r\n,进了 JSON 就是满屏
    // "第一行\r\n第二行\r\n" —— 纯噪声,还占 token。
    //
    // 代价:模型若想检查文件真实的行尾符,看到的会是归一后的结果。
    // 这种需求应该用 repr() / 读字节,而不是靠 print 的原样透传,所以接受
    return clean.replace(/\r\n/g, '\n');
  }
}
