// ============================================
// 读黑名单 —— 清单生成
// ============================================
//
// 这里只测「清单里有什么」。**实际拦不拦得住**在 write-guard.test.ts
// (Python audit hook)和 security.test.ts(fs 工具)里测 ——
// 清单对了但没接上,是这个功能最可能的失败形态。
// ============================================

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { defaultReadDenyPaths } from './read-deny.js';

const HOME = path.resolve('/tmp/fake-home');
const PROJ = path.resolve('/tmp/fake-proj');

const make = (over: Partial<Parameters<typeof defaultReadDenyPaths>[0]> = {}) =>
  defaultReadDenyPaths({
    projectDir: PROJ,
    homeDir: HOME,
    platform: 'linux',
    env: {},
    ...over,
  });

describe('读黑名单清单', () => {
  it('含本框架的 .env —— 里面是 DEEPSEEK_API_KEY / VISION_API_KEY', () => {
    expect(make()).toContain(path.join(PROJ, '.env'));
  });

  it('**不含 .env.example** —— 判定按路径前缀,不按文件名', () => {
    // 这条决定了工作区里用户自己项目的 .env 不受影响:
    // 那可能正是模型要处理的对象,一并拦掉会误伤正常任务
    const list = make();
    expect(list).not.toContain(path.join(PROJ, '.env.example'));
    expect(list.some(p => p.endsWith('.env.example'))).toBe(false);
  });

  it('含私钥与云凭证目录', () => {
    const list = make();
    for (const rel of ['.ssh', '.gnupg', '.aws', '.kube']) {
      expect(list).toContain(path.join(HOME, rel));
    }
    expect(list).toContain(path.join(HOME, '.config', 'gcloud'));
  });

  it('含 token 类文件', () => {
    const list = make();
    for (const rel of ['.git-credentials', '.netrc', '.npmrc', '.pypirc']) {
      expect(list).toContain(path.join(HOME, rel));
    }
  });

  it('extra 会被吸收并转成绝对路径', () => {
    const list = make({ extra: ['.browser-profile'] });
    expect(list).toContain(path.resolve('.browser-profile'));
  });

  it('去重 —— 同一项进来两次不该在错误信息里出现两遍', () => {
    const list = make({ extra: [path.join(PROJ, '.env')] });
    expect(list.filter(p => p === path.join(PROJ, '.env'))).toHaveLength(1);
    expect(new Set(list).size).toBe(list.length);
  });

  it('全部是绝对路径 —— 相对路径在两侧解析基准不同,会静默错位', () => {
    for (const p of make({ extra: ['rel/dir'] })) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });
});

describe('按平台取浏览器 profile(cookie = 活凭证)', () => {
  it('Windows 用 LOCALAPPDATA / APPDATA', () => {
    const list = defaultReadDenyPaths({
      projectDir: PROJ,
      homeDir: HOME,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' },
    });

    expect(list).toContain(path.resolve('C:\\L', 'Google', 'Chrome', 'User Data'));
    expect(list).toContain(path.resolve('C:\\L', 'Microsoft', 'Edge', 'User Data'));
    expect(list).toContain(path.resolve('C:\\R', 'Mozilla', 'Firefox'));
  });

  it('Windows 缺 LOCALAPPDATA 时退回 AppData/Local,不产生半截路径', () => {
    const list = defaultReadDenyPaths({
      projectDir: PROJ,
      homeDir: HOME,
      platform: 'win32',
      env: {},
    });

    expect(list).toContain(
      path.join(HOME, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    );
    expect(list.every(p => p.length > 0)).toBe(true);
  });

  it('macOS 取 Application Support 与 Keychains', () => {
    const list = defaultReadDenyPaths({
      projectDir: PROJ,
      homeDir: HOME,
      platform: 'darwin',
      env: {},
    });

    expect(list).toContain(
      path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
    );
    expect(list).toContain(path.join(HOME, 'Library', 'Keychains'));
  });

  it('Linux 取 .config/google-chrome 与 .mozilla', () => {
    const list = make();
    expect(list).toContain(path.join(HOME, '.config', 'google-chrome'));
    expect(list).toContain(path.join(HOME, '.mozilla'));
  });
});

describe('刻意不含的东西', () => {
  it('不含归档目录与 traces —— 归档要让模型读(压缩后回溯早期对话)', () => {
    const list = make();
    expect(list.some(p => p.includes('traces'))).toBe(false);
    expect(list.some(p => /archive/i.test(p))).toBe(false);
  });

  it('不含工作区 —— 那是模型正常干活的地方', () => {
    const list = make({ projectDir: PROJ });
    expect(list).not.toContain(PROJ);
  });
});
