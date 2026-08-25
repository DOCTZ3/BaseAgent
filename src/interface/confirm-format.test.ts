// ============================================
// 确认文案 —— run_command 唯一的安全机制
// ============================================
//
// 为什么这段值得测:run_command 没有任何机制边界(见 shell-executor.ts),
// 它**全部的**安全性就是「用户读那一行命令并判断」。文案坏了,
// 边界就等于没了 —— 而且坏得无声无息:命令照跑,只是用户看到的不是真的。
//
// 已经踩过的具体形态:JSON.stringify 把 Windows 路径反斜杠双写
// (`C:\foo` → `C:\\foo`),用户看到的那行**不等于**将要执行的那行。
// typosquatting 的整个攻击面就是一两个字符的差别,而这里差的正是字符。
// ============================================

import { describe, it, expect } from 'vitest';
import { formatConfirm } from './confirm-format.js';

/** 去掉 ANSI 转义,只看用户实际读到的字 */
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, '');

describe('run_command 的确认文案', () => {
  it('命令原样呈现 —— Windows 路径的反斜杠不能被双写', () => {
    // 这就是那个 bug:JSON.stringify 会输出 C:\\Users\\me\\x.py
    const command = 'python C:\\Users\\me\\scripts\\x.py --out D:\\tmp\\a.txt';
    const text = plain(formatConfirm({ toolName: 'run_command', args: { command } }));

    expect(text).toContain(command);
    expect(text).not.toContain('\\\\');
  });

  it('命令独占一行 —— 不能和其他字段挤在一起', () => {
    const command = 'pip install pandas';
    const text = plain(
      formatConfirm({
        toolName: 'run_command',
        args: { command, reason: '需要做数据清洗', timeout_ms: 120_000 },
      }),
    );

    const line = text.split('\n').find(l => l.includes(command));
    expect(line).toBeDefined();
    // 该行除了命令本身只允许缩进 —— 理由、超时都各自成行
    expect(line!.trim()).toBe(command);
  });

  it('引号、空格、& 一类字符不做任何转义 —— 转义过的命令是另一条命令', () => {
    // shell:true 下这些字符有真实语义(见 shell-executor.ts:不切 argv)。
    // 显示时改动它们,用户判断的就不是将要执行的那条
    const command = `git commit -m "fix: 别 & 转义" && echo 'done'`;
    const text = plain(formatConfirm({ toolName: 'run_command', args: { command } }));

    expect(text.split('\n').some(l => l.trim() === command)).toBe(true);
  });

  it('带上理由和超时', () => {
    const text = plain(
      formatConfirm({
        toolName: 'run_command',
        args: { command: 'npm ci', reason: '装依赖', timeout_ms: 300_000 },
      }),
    );

    expect(text).toContain('装依赖');
    expect(text).toContain('300s');
  });

  it('没给理由/超时时不留空行、不显示 undefined', () => {
    const text = plain(
      formatConfirm({ toolName: 'run_command', args: { command: 'ls' } }),
    );

    expect(text).not.toContain('undefined');
    expect(text).not.toContain('理由');
    expect(text).not.toContain('超时');
    expect(text.split('\n').every(l => l.trim().length > 0)).toBe(true);
  });

  it('字段类型不对时退回 JSON,而不是打印 undefined', () => {
    // 参数已过 Zod 校验,正常不会到这;但文案不该在异常输入上骗人
    const text = plain(formatConfirm({ toolName: 'run_command', args: { command: 42 } }));

    expect(text).toContain('run_command');
    expect(text).not.toContain('undefined');
  });
});

describe('其余工具', () => {
  it('保持 JSON —— 结构化入参用 JSON 更清楚', () => {
    const text = plain(
      formatConfirm({ toolName: 'write_file', args: { path: 'a.txt', content: 'hi' } }),
    );

    expect(text).toContain('write_file');
    expect(text).toContain('"path"');
    expect(text).toContain('"a.txt"');
  });

  it('无参数时也不报错', () => {
    expect(() => formatConfirm({ toolName: 'echo', args: {} })).not.toThrow();
  });
});
