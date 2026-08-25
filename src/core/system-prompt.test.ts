// ============================================
// 系统提示 —— 主 agent 与子 agent 的环境约定必须同源
// ============================================
//
// 这批测试针对一个**实测发生过**的问题:子 agent 用一段独立的短提示,
// 对运行环境一无所知,后果按危害排序:
// - 不知道「绝不能 close 浏览器」→ 一次 close 杀掉常驻实例,
//   **主 agent 后续轮次全部接不上**(它的错误会连带毁掉主会话)
// - 不知道浏览器是常驻的 → 用 requests 硬抓需要登录的站点,拿不到正文
//   (实测 trace 里它就是这么干的)
// - 不知道工具已收敛 → 去调 write_file,撞「工具未注册」白烧步数
//
// 所以核心断言不是「提示里有某句话」,而是**两份提示的环境段逐字相同** ——
// 将来给主 agent 加一条环境约定却忘了子 agent,这条会直接失败。
// ============================================

import { describe, it, expect } from 'vitest';
import {
  buildEnvironmentPrompt,
  buildMainSystemPrompt,
  buildSubAgentSystemPrompt,
  type EnvironmentOptions,
} from './system-prompt.js';

const FULL: EnvironmentOptions = {
  converged: true,
  pythonEnabled: true,
  visionModel: 'test-vision-model',
};

describe('环境约定同源', () => {
  it('主 agent 与子 agent 的提示都包含完整的环境段（逐字）', () => {
    const env = buildEnvironmentPrompt(FULL);

    // 不逐句比对，而是断言整段被原样嵌入 —— 加了新约定也自动覆盖
    expect(buildMainSystemPrompt({ ...FULL, subAgentEnabled: true })).toContain(env);
    expect(buildSubAgentSystemPrompt(FULL)).toContain(env);
  });

  it('关掉代码执行时，两边同样都不含 CodeAct 段', () => {
    const off = { ...FULL, pythonEnabled: false };
    const env = buildEnvironmentPrompt(off);

    expect(env).not.toContain('execute_python');
    expect(buildMainSystemPrompt({ ...off, subAgentEnabled: true })).toContain(env);
    expect(buildSubAgentSystemPrompt(off)).toContain(env);
  });

  it('未配视觉模型时，两边同样都不提看图', () => {
    const noVision = { ...FULL, visionModel: undefined };
    const env = buildEnvironmentPrompt(noVision);

    expect(env).not.toContain('view_image');
    expect(env).not.toContain('看图');
    expect(buildSubAgentSystemPrompt(noVision)).toContain(env);
  });
});

describe('环境段的关键约定', () => {
  const env = buildEnvironmentPrompt(FULL);

  it('说清不能 close 浏览器 —— 子 agent 的 close 会毁掉主 agent 的会话', () => {
    expect(env).toContain('close()');
    expect(env).toContain('常驻');
  });

  it('抓网页优先用常驻浏览器而不是 requests', () => {
    // 实测子 agent 拿 requests 抓知乎/搜狐，没有登录态基本抓不到正文
    expect(env).toContain('requests');
    expect(env).toContain('connect_over_cdp');
  });

  it('说清 stdout 有上限、要先提取再打印', () => {
    expect(env).toContain('print');
    expect(env).toContain('上限');
  });

  it('收敛后说清哪些事没有工具、要用代码做', () => {
    expect(env).toContain('datetime.now()');
    expect(env).toContain('open(path,"w")');
  });

  it('不写函数签名 —— 签名由工具桥从 schema 生成，手写必然漂移', () => {
    // 之前手写那份漏了 detail 参数；漂移的表现是「照提示调用却报 TypeError」
    expect(env).not.toContain('view_image(path');
    expect(env).not.toContain('screenshot(');
  });

  it('绝不在代码里写账号密码', () => {
    expect(env).toContain('账号密码');
  });
});

// ============================================
// 装包这件事:挡住,以及出路
// ============================================
//
// 必须同时说。实测事故里模型想做 OCR,连着四步都在装包 ——
// 代码里的 pip 被 PIP_NO_INDEX 挡住之后,「No matching distribution found」
// 这句话不告诉它出路是什么,于是它会去试 --index-url、试直接 URL、试换包名。
// 只挡不给出路等于制造一个新的卡点。
describe('第三方库的装法', () => {
  it('有 shell 通道时:指向 run_command,并说明会请用户确认', () => {
    const env = buildEnvironmentPrompt({ ...FULL, shellEnabled: true });

    expect(env).toContain('run_command');
    expect(env).toContain('确认');
    // 挡住这件事也要说清,否则它会先去代码里试一遍
    expect(env).toContain('不要在代码里 pip install');
  });

  it('有 shell 通道时提醒 import 名 ≠ 安装名 —— 猜错的名字可能是抢注的恶意包', () => {
    const env = buildEnvironmentPrompt({ ...FULL, shellEnabled: true });

    expect(env).toContain('opencv-python');
    expect(env).toContain('pillow');
  });

  it('没有 shell 通道时:明说装不了,不要反复尝试', () => {
    const env = buildEnvironmentPrompt({ ...FULL, shellEnabled: false });

    expect(env).toContain('装不了新库');
    expect(env).not.toContain('run_command');
  });

  it('关掉代码执行时整段不出现 —— 没有沙箱就没有「装库」这件事', () => {
    const env = buildEnvironmentPrompt({
      ...FULL,
      pythonEnabled: false,
      shellEnabled: true,
    });

    expect(env).not.toContain('run_command');
    expect(env).not.toContain('pip install');
  });

  it('子 agent 永不被告知有 run_command —— 它拿不到那个工具', () => {
    // run_command 在 NO_SUBAGENT_TOOLS 里(sub-agent.ts)。
    // 提示里若提到它,就是让子 agent 去用一个自己没有的工具 ——
    // 这正是子 agent 提示词漂移的老毛病
    const sub = buildSubAgentSystemPrompt({ ...FULL, shellEnabled: true });

    expect(sub).not.toContain('run_command');
    expect(sub).toContain('装不了新库');
  });

  it('主 agent 与子 agent 的环境段在 shell 这一点上**刻意不同**', () => {
    // 其余环境约定必须逐字相同,但这一条是能力差异,不是漂移。
    // 断言差异存在,免得将来「统一」时把它合掉
    const opts = { ...FULL, shellEnabled: true };
    const main = buildMainSystemPrompt({ ...opts, subAgentEnabled: true });
    const sub = buildSubAgentSystemPrompt(opts);

    expect(main).toContain('run_command');
    expect(sub).not.toContain('run_command');
  });
});

// ============================================
// 「已预装」必须是实况,不是声明
// ============================================
//
// 写死一串包名的话,那句话在缺库的机器上是**假的** ——
// 模型照着不存在的前提写代码、撞 ImportError,而代码里的 pip 已被禁,
// 它自己修不了,只会反复试或者放弃。
describe('基线库的可用性', () => {
  it('默认(不传)按全部齐备写', () => {
    const env = buildEnvironmentPrompt(FULL);

    expect(env).toContain('已预装');
    expect(env).toContain('playwright');
    expect(env).not.toContain('没有安装');
  });

  it('缺失的库**点名说没有**,而不是从列表里悄悄去掉', () => {
    // 悄悄去掉不够:模型对 pandas 这类库有很强的先验,不明确否认它照样会 import
    const env = buildEnvironmentPrompt({ ...FULL, missingPackages: ['pandas'] });

    expect(env).toContain('pandas 没有安装');
    expect(env).toContain('ImportError');
    // 其余仍要说有
    expect(env).toContain('playwright');
  });

  it('缺失且有 shell 通道时,给出 run_command 这条出路', () => {
    const env = buildEnvironmentPrompt({
      ...FULL,
      missingPackages: ['pypdf'],
      shellEnabled: true,
    });

    expect(env).toContain('pypdf 没有安装');
    expect(env).toContain('run_command');
  });

  it('缺失且无 shell 通道时,让它换库或让用户装 —— 不留一个死胡同', () => {
    const env = buildEnvironmentPrompt({
      ...FULL,
      missingPackages: ['pypdf'],
      shellEnabled: false,
    });

    expect(env).toContain('换用已装的库');
    expect(env).not.toContain('run_command');
  });

  it('全部缺失时不再声称「已预装」任何东西', () => {
    const env = buildEnvironmentPrompt({
      ...FULL,
      missingPackages: [
        'playwright', 'python-docx', 'openpyxl',
        'pypdf', 'pandas', 'requests', 'beautifulsoup4',
      ],
    });

    expect(env).not.toContain('已预装');
    expect(env).toContain('没有安装');
  });

  it('主 agent 与子 agent 拿到的可用性**一致** —— 它们跑在同一个沙箱里', () => {
    const opts = { ...FULL, missingPackages: ['pandas'] };

    expect(buildMainSystemPrompt({ ...opts, subAgentEnabled: true })).toContain(
      'pandas 没有安装',
    );
    expect(buildSubAgentSystemPrompt(opts)).toContain('pandas 没有安装');
  });
});

describe('角色差异', () => {
  it('子 agent 被明确告知没有请求用户帮助的能力', () => {
    // 它的输出只回给主 agent，用户看不到它说的话 —— 不说清它会写
    // 「请用户登录后重试」然后等一个永远不会来的回复
    const sub = buildSubAgentSystemPrompt(FULL);

    expect(sub).toContain('无法与用户交互');
    expect(sub).toContain('交回主 agent');
    // 遇到人机检测类情况的处置方式要写明
    expect(sub).toContain('验证码');
  });

  it('主 agent 被告知子 agent 没有那个能力，需由自己处理', () => {
    // 否则主 agent 会把「需要登录」当成任务失败，而不是自己去请用户帮忙
    const main = buildMainSystemPrompt({ ...FULL, subAgentEnabled: true });

    expect(main).toContain('request_help');
    expect(main).toContain('没有请求用户帮助的能力');
  });

  it('关掉子 agent 时主提示不提下放，也不提那条注意事项', () => {
    const main = buildMainSystemPrompt({ ...FULL, subAgentEnabled: false });

    expect(main).not.toContain('spawn_subagent');
    expect(main).not.toContain('request_help');
  });

  it('子 agent 提示强调回答是唯一产物', () => {
    const sub = buildSubAgentSystemPrompt(FULL);
    expect(sub).toContain('唯一产物');
  });

  it('主 agent 提示不含子 agent 的角色说明（避免角色串味）', () => {
    const main = buildMainSystemPrompt({ ...FULL, subAgentEnabled: true });
    expect(main).not.toContain('你是一个专注的子任务执行器');
  });
});
