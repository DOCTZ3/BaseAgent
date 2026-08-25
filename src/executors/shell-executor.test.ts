// ============================================
// Shell 执行器 —— 外部命令通道的三条前提
// ============================================
//
// 这批测试盯的是「不做就等于前面白做」的三件事:
// ① PATH 前置 venv:不做的话 shell 从 PATH 找到的是**全局** pip,
//    装回用户机器上 —— venv 隔离白做(实测事故:模型装 rapidocr
//    顺带升级了全局 onnxruntime)
// ② env 白名单与 Python 共用:Python 那侧费劲不继承 DEEPSEEK_API_KEY,
//    一句 `echo $DEEPSEEK_API_KEY` 就能把凭证隔离还回去
// ③ **不设** PIP_NO_INDEX:这里是装包的正式通道,pip 必须能联网
// ============================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ShellExecutor, type ShellExecutorConfig } from './shell-executor.js';
import { PIP_BLOCKED_ENV } from './sandbox-env.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const workDir = os.tmpdir();

function makeExecutor(overrides: Partial<ShellExecutorConfig> = {}) {
  return new ShellExecutor({
    workDir,
    timeout: 20_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
    logger: silentLogger,
    ...overrides,
  });
}

// 用 node -e 打印,而不是 shell 的 echo:`echo %VAR%` 与 `echo $VAR` 两个平台
// 语法不同,而 node 在本项目里必然存在
const printEnv = (key: string) =>
  `node -e "console.log(process.env.${key} || 'MISSING')"`;

describe('基本执行', () => {
  it('跑通一条命令并回收 stdout 与退出码', async () => {
    const r = await makeExecutor().run('node -e "console.log(1+1)"');

    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('2');
  });

  it('非零退出码判失败,stderr 带回去', async () => {
    const r = await makeExecutor().run(
      'node -e "console.error(\'boom\'); process.exit(3)"',
    );

    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it('CRLF 归一成 LF —— Windows 上不归一会满屏 \\r\\n,纯噪声还占 token', async () => {
    const r = await makeExecutor().run('node -e "console.log(\'a\');console.log(\'b\')"');

    expect(r.stdout).not.toContain('\r\n');
    expect(r.stdout).toBe('a\nb\n');
  });

  it('超时杀掉进程树并标记 timedOut', async () => {
    const r = await makeExecutor({ timeout: 400 }).run(
      'node -e "setTimeout(()=>{},30000)"',
    );

    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 15_000);

  it('输出超上限截断,但**不判失败** —— npm install 刷几百行是常态', async () => {
    const r = await makeExecutor({ maxStdoutBytes: 64 }).run(
      'node -e "console.log(\'x\'.repeat(5000))"',
    );

    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdoutBytes).toBeGreaterThan(64);
    // 关键:命令本身成功了,ok 仍为 true(与 Python 执行器刻意不同)
    expect(r.ok).toBe(true);
  });
});

describe('凭证隔离(与 Python 执行器共用同一份白名单)', () => {
  const FAKE = 'BASEAGENT_TEST_FAKE_SECRET';

  beforeAll(() => {
    process.env[FAKE] = 'super-secret-value';
    process.env.DEEPSEEK_API_KEY ??= 'sk-test-should-not-leak';
  });
  afterAll(() => {
    delete process.env[FAKE];
  });

  it('白名单外的变量不进子进程', async () => {
    const r = await makeExecutor().run(printEnv(FAKE));

    expect(r.stdout.trim()).toBe('MISSING');
    expect(r.stdout).not.toContain('super-secret-value');
  });

  it('DEEPSEEK_API_KEY 拿不到 —— 否则 echo 一下就把凭证隔离还回去了', async () => {
    const r = await makeExecutor().run(printEnv('DEEPSEEK_API_KEY'));

    expect(r.stdout.trim()).toBe('MISSING');
  });

  it('PATH 一类运行必需项照常继承', async () => {
    const r = await makeExecutor().run(printEnv('PATH'));

    expect(r.stdout.trim()).not.toBe('MISSING');
  });
});

describe('PATH 前置(venv 隔离能否成立的前提)', () => {
  it('pathPrepend 排在 PATH 最前面', async () => {
    const venvDir = path.join(workDir, 'baseagent-fake-venv-scripts');
    const r = await makeExecutor({ pathPrepend: [venvDir] }).run(printEnv('PATH'));

    const first = r.stdout.trim().split(path.delimiter)[0];
    // 必须是第一个:排在后面的话 `pip` 仍解析到全局解释器那个,
    // 装回用户机器上 —— 正是本次要修的东西
    expect(path.resolve(first)).toBe(path.resolve(venvDir));
  });

  it('相对路径会被解析成绝对路径 —— 子进程 cwd 与父进程不同,相对路径会指错', async () => {
    const r = await makeExecutor({ pathPrepend: ['./rel-venv/Scripts'] }).run(
      printEnv('PATH'),
    );

    const first = r.stdout.trim().split(path.delimiter)[0];
    expect(path.isAbsolute(first)).toBe(true);
  });

  it('不给 pathPrepend 时 PATH 不变', async () => {
    const r = await makeExecutor().run(printEnv('PATH'));
    const first = r.stdout.trim().split(path.delimiter)[0];

    expect(first).toBe((process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)[0]);
  });
});

describe('装包通道的性质', () => {
  it('shell 侧**不设** PIP_NO_INDEX —— 这里是正式通道,pip 要能联网', async () => {
    const r = await makeExecutor().run(printEnv('PIP_NO_INDEX'));

    expect(r.stdout.trim()).toBe('MISSING');
    // 反过来说明:那个键只该出现在 Python 执行器那侧
    expect(PIP_BLOCKED_ENV.PIP_NO_INDEX).toBe('1');
  });

  it('shell 模式保留管道与 && —— 模型写的是给人看的命令行,切分 argv 必然切错', async () => {
    const r = await makeExecutor().run(
      'node -e "console.log(\'first\')" && node -e "console.log(\'second\')"',
    );

    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('first');
    expect(r.stdout).toContain('second');
  });
});
