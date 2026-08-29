// ============================================
// 客户端配置持久化 —— 盯的是三类**静默**失败
// ============================================
//
// ① 范围错的值落盘后下次启动静默生效。maxSteps=0 表现成「主循环一步不走
//    就返回 max_steps」(看起来像卡死),maxTokens=1 表现成「每次回答都是空的」。
//    所以校验必须在**写盘之前**,而且失败时不能留下半份配置。
// ② 数值输入框清空存成 0 而不是删除。0 是合法数字,会被当成「用户就要 0」。
//    清空的语义是 null(删掉这一项、回落 .env),这一层要能区分 null 和 0。
// ③ toOverrides 漏字段。漏了不报错,只表现成「界面上存了、跑起来没变」——
//    fsGrants 那个 bug 就是这个形状,本项目已栽过多次。
//
// 测试全程把配置目录指到临时目录:**绝不能**碰用户真实的 config.json
// (里面有 API key)。configFilePath() 在调用时读环境变量,所以覆盖有效。
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  configFilePath,
  readConfigFile,
  writeConfigFile,
  toOverrides,
  validateStored,
} from './config-store.js';
import { loadConfig } from './config.js';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basecfg-'));
  // 三个平台的分支各读一个变量,全覆盖掉 —— 漏一个就会写到真实配置目录
  for (const k of ['APPDATA', 'XDG_CONFIG_HOME', 'HOME']) {
    saved[k] = process.env[k];
    process.env[k] = tmpDir;
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('配置文件位置', () => {
  it('落在被覆盖的配置目录下 —— 测试绝不能碰用户真实的 config.json', () => {
    // 这条不是形式主义:真实文件里有 API key,而下面每个用例都在写盘
    expect(configFilePath().startsWith(tmpDir)).toBe(true);
    expect(path.basename(configFilePath())).toBe('config.json');
  });
});

describe('数值项校验', () => {
  it('合法值通过', () => {
    expect(validateStored({ maxTokens: 8000, maxSteps: 20 })).toEqual([]);
  });

  it('undefined / null 都不校验 —— 前者是「不修改」,后者是「清空」', () => {
    expect(validateStored({ maxTokens: undefined, maxSteps: null })).toEqual([]);
  });

  it('maxSteps=0 被挡住 —— 它表现成「一步不走就返回 max_steps」,像卡死', () => {
    const errors = validateStored({ maxSteps: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('最大工具调用轮数');
  });

  it('maxTokens 过小被挡住 —— 思维链计入预算,给小了正文会空', () => {
    expect(validateStored({ maxTokens: 1 })).toHaveLength(1);
  });

  it('小数被挡住 —— max_tokens 传小数 API 会拒,而那个错来得很晚', () => {
    expect(validateStored({ maxSteps: 2.5 })).toHaveLength(1);
  });

  it('NaN 被挡住 —— 界面里粘进文字就会得到它,而 JSON 化后变 null 更难查', () => {
    expect(validateStored({ maxTokens: NaN })).toHaveLength(1);
  });

  it('多项都错时一次性全报 —— 逐项抛会让用户改一个存一次', () => {
    expect(validateStored({ maxTokens: 1, maxSteps: 0 })).toHaveLength(2);
  });

  it('上界也挡:maxSteps 过大等于「一轮可以跑到天荒地老」', () => {
    expect(validateStored({ maxSteps: 9999 })).toHaveLength(1);
  });
});

describe('写盘', () => {
  it('校验失败**不写盘** —— 留下半份配置比不写糟得多', () => {
    expect(() => writeConfigFile({ model: 'm1', maxSteps: 0 })).toThrow();
    expect(fs.existsSync(configFilePath())).toBe(false);
  });

  it('校验失败不破坏已存的配置', () => {
    writeConfigFile({ model: 'good', maxSteps: 30 });
    expect(() => writeConfigFile({ maxSteps: -5 })).toThrow();

    const after = readConfigFile();
    expect(after.model).toBe('good');
    expect(after.maxSteps).toBe(30);
  });

  it('null 表示**删掉这一项**,不是存 0', () => {
    writeConfigFile({ maxSteps: 40 });
    expect(readConfigFile().maxSteps).toBe(40);

    writeConfigFile({ maxSteps: null });
    // 键必须真的消失 —— 留着 null 会让 toOverrides 的 != null 判断多绕一层,
    // 而「回落到 .env」的语义靠的就是这个键不存在
    expect('maxSteps' in readConfigFile()).toBe(false);
  });

  it('undefined 表示不修改 —— apiKey 留空走这条,不能把已存的抹掉', () => {
    writeConfigFile({ apiKey: 'sk-existing', maxSteps: 25 });
    writeConfigFile({ apiKey: undefined, maxSteps: 26 });

    const after = readConfigFile();
    expect(after.apiKey).toBe('sk-existing');
    expect(after.maxSteps).toBe(26);
  });

  it('enableThinking=false 能存下来 —— 它是布尔,不能被真值判断吃掉', () => {
    writeConfigFile({ enableThinking: false });
    expect(readConfigFile().enableThinking).toBe(false);
  });
});

describe('toOverrides 翻译', () => {
  it('maxTokens / enableThinking 落在 models.main', () => {
    const o = toOverrides({ maxTokens: 8000, enableThinking: false });
    expect(o.models?.main?.maxTokens).toBe(8000);
    expect(o.models?.main?.enableThinking).toBe(false);
  });

  it('maxSteps 落在 execution,不在 models —— 它是主循环预算,与模型无关', () => {
    const o = toOverrides({ maxSteps: 45 });
    expect(o.execution?.maxSteps).toBe(45);
    expect(o.models).toBeUndefined();
  });

  it('未配的数值项不进 overrides —— 进了会用 undefined 盖掉 .env 的值', () => {
    const o = toOverrides({ model: 'm' });
    expect(o.models?.main).not.toHaveProperty('maxTokens');
    expect(o.execution).toBeUndefined();
  });

  it('null 也不进 overrides —— 「清空」的含义是回落,不是覆盖成空', () => {
    const o = toOverrides({ maxTokens: null, maxSteps: null });
    expect(o.models).toBeUndefined();
    expect(o.execution).toBeUndefined();
  });

  it('端到端:存下的运行参数真的到达 loadConfig 的结果里', () => {
    // 这条是整条链的收口。前面几条只验翻译,而漏字段的失败模式正是
    // 「翻译对了但没接上」—— fsGrants 那个 bug 就是这么藏住的
    writeConfigFile({ maxTokens: 9000, maxSteps: 33, enableThinking: false });
    const c = loadConfig(toOverrides(readConfigFile()));

    expect(c.models.main.maxTokens).toBe(9000);
    expect(c.execution.maxSteps).toBe(33);
    expect(c.models.main.enableThinking).toBe(false);
    // 没配的段仍是默认值,没被这次覆盖带歪
    expect(c.execution.timeout).toBe(loadConfig().execution.timeout);
  });
});
