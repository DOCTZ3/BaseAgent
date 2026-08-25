// ============================================
// 沙箱基线依赖检测 —— 清单同源 + 检测正确性
// ============================================
//
// 最重要的一条是**同源**:包名同时出现在
//   ① sandbox-requirements.txt(用户装的东西)
//   ② SANDBOX_DEPS(框架检测 + 提示词里说「已预装」的那串)
// 两处漂移的后果很隐蔽 —— 比如往 requirements 里加了个库却忘了加进表,
// 于是它缺失时启动不告警、提示里也不提,模型 import 就炸;
// 反过来则是提示里声称有、requirements 里根本没让用户装。
//
// 本项目已在「同一份事实写两处」上栽过三次(visionAnalyzer / pythonExecutor /
// models.vision),所以这条用测试钉住。
// ============================================

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  checkSandboxDeps,
  SANDBOX_DEPS,
  REQUIREMENTS_FILE,
} from './sandbox-deps.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('清单同源(requirements ↔ SANDBOX_DEPS)', () => {
  it('每个包都在 requirements 文件里 —— 否则提示里声称有、却没让用户装', async () => {
    const text = await fs.readFile(path.resolve(REQUIREMENTS_FILE), 'utf-8');
    // 只看非注释行的包名部分（去掉 >=1.2.3 一类版本约束）
    const listed = new Set(
      text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split(/[<>=!~\[]/)[0].trim().toLowerCase()),
    );

    for (const dep of SANDBOX_DEPS) {
      expect(
        listed.has(dep.packageName.toLowerCase()),
        `${dep.packageName} 不在 ${REQUIREMENTS_FILE} 里`,
      ).toBe(true);
    }
  });

  it('requirements 里的每个包都在表里 —— 否则它缺失时启动不告警', async () => {
    const text = await fs.readFile(path.resolve(REQUIREMENTS_FILE), 'utf-8');
    const listed = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split(/[<>=!~\[]/)[0].trim().toLowerCase());

    const known = new Set(SANDBOX_DEPS.map(d => d.packageName.toLowerCase()));
    for (const pkg of listed) {
      expect(known.has(pkg), `${pkg} 不在 SANDBOX_DEPS 里`).toBe(true);
    }
  });

  it('记录了 import 名 ≠ 安装名的那几个 —— 这个不一致是 typosquatting 的着力点', () => {
    const byPackage = new Map(SANDBOX_DEPS.map(d => [d.packageName, d.importName]));

    expect(byPackage.get('python-docx')).toBe('docx');
    expect(byPackage.get('beautifulsoup4')).toBe('bs4');
  });

  it('没有重复的 import 名', () => {
    const names = SANDBOX_DEPS.map(d => d.importName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('检测行为', () => {
  it('解释器跑不起来时以 error 返回,不抛异常', async () => {
    const r = await checkSandboxDeps('definitely-not-a-real-python-xyz', logger);

    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    // 检测失败 ≠ 库缺失,不能把 missing 填满去误导用户
    expect(r.missing).toEqual([]);
  });

  it('本机 python 上能跑通检测(缺库时给出可照抄的命令)', async () => {
    const r = await checkSandboxDeps('python', logger);

    // 不断言齐备 —— 那取决于跑测试的机器装了什么
    expect(r.error).toBeUndefined();
    if (!r.ok) {
      expect(r.missing.length).toBeGreaterThan(0);
      // 提示必须带 -r requirements,而不是逐个包名拼 pip install:
      // 后者会漏掉版本下限
      expect(r.hint).toContain(REQUIREMENTS_FILE);
    }
  }, 60_000);

  it('提示里把 chromium 单列 —— 它不在 pip 范围内', async () => {
    // 用一个只有标准库的探测目标验不了这条,所以直接查文案约定:
    // playwright 缺失时必须提到 playwright install
    const r = await checkSandboxDeps('python', logger);
    if (!r.ok && r.missing.includes('playwright')) {
      expect(r.hint).toContain('playwright install chromium');
    }
  }, 60_000);
});
