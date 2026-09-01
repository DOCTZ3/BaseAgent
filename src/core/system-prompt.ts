// ============================================
// Core 层:系统提示的组装(主 agent 与子 agent 共用环境约定)
// ============================================
//
// 为什么要抽出来:主 agent 的提示早期写死在入口里,子 agent 用的是自己一段
// 短提示 —— 于是子 agent **对运行环境一无所知**,实测后果:
// - 不知道浏览器是框架常驻的 → 用 requests 硬抓需要登录的站点,抓不到正文;
//   或者自己 launch() 开一个新浏览器,登录态全丢
// - 不知道「绝不能 close 浏览器」→ 一次 close 杀掉常驻实例,
//   **主 agent 后续轮次全部接不上**,profile 还被锁住
// - 不知道工具已收敛 → 去调 write_file / get_current_time,撞「工具未注册」白烧步数
// - 不知道 stdout 上限 → print 整页 HTML,撑爆自己的上下文
//
// 所以环境约定必须**同源**:环境变了只改这一处,不会再漂移。
// 角色说明各自保留 —— 主 agent 讲「大任务下放」,子 agent 讲「回答是唯一产物」。
// ============================================

// 依赖清单的**单一来源**在 executors 层(与 sandbox-requirements.txt 同源)。
// 依赖方向 core → tools → executors,这个 import 是顺向的。
// 不在这里再手写一份包名 —— 同一份事实写两处必然漂移
import { SANDBOX_DEPS } from '../executors/sandbox-deps.js';

export interface EnvironmentOptions {
  /** 动作空间是否已收敛(工具位缩到 6 个,查时间/写文件等下沉进代码) */
  converged: boolean;
  /** 代码执行是否可用。关掉时整段 CodeAct 约定都不该出现 */
  pythonEnabled: boolean;
  /** 视觉模型名。未配 = 没有看图能力,提示里不提 */
  visionModel?: string;
  /**
   * 外部命令通道(run_command)是否可用
   *
   * 影响的不只是「多一个工具」:代码里装包被 PIP_NO_INDEX 挡住,
   * 模型看到「No matching distribution found」若不知道正式通道在哪,
   * 会去试 --index-url、试直接 URL、试换包名,白烧好几步。
   * 所以这两件事必须同时说 —— 挡住,以及出路。
   */
  shellEnabled?: boolean;

  /**
   * 沙箱里**确实可用**的基线库(安装名)。不给则按全部齐备写
   *
   * 为什么要传实况而不是写死一串:提示里那句「沙箱已预装 playwright、pandas…」
   * 在开发机上碰巧是真的,在一台新机器上是**假的**。模型会照着不存在的前提
   * 写代码、撞 ImportError,而代码里的 pip 已被禁,它自己修不了 ——
   * 只会反复试或者放弃。让提示与启动检测同源,这个失败模式就消失了。
   */
  availablePackages?: string[];
  /** 检测到缺失的基线库(安装名)。有值时提示里明确点名「没有」 */
  missingPackages?: string[];
}

/**
 * 环境约定 —— 主 agent 与子 agent **逐字相同**的部分
 *
 * 只写「这台机器上什么可用、什么禁止」,不写角色定位。
 * 刻意不写函数签名:签名由工具桥从 schema 生成、写在 execute_python 的
 * description 里。手写一份必然漂移(之前就漏了 detail 参数),
 * 而漂移的表现是「模型照提示调用却报 TypeError」,很难查。
 */
export function buildEnvironmentPrompt(opts: EnvironmentOptions): string {
  const parts: string[] = [];

  // 收敛后这几件事没有对应工具了,必须说清用代码做 ——
  // 否则模型会去调 write_file / get_current_time,撞「工具未注册」白花一步。
  //
  // 必须同时要求 pythonEnabled:收敛的前提就是「有代码通道可以接管」,
  // 没有 execute_python 却让模型去写代码,是把它指向一个不存在的工具
  parts.push(
    opts.converged && opts.pythonEnabled
      ? '注意：查时间、写文件、列目录这些没有专门的工具，用 execute_python 写代码做' +
        '（datetime.now() / open(path,"w") / glob）。读文件和按名字找文件仍有工具' +
        '（read_file / search_files），它们自带返回量上限，比在代码里 print 整个文件安全。'
      : '需要读写文件、查询时间等操作时使用提供的工具。',
  );

  // secretsPart 无条件加入,且**不受 pythonEnabled 影响**:
  // 拦截发生在两处(audit hook 与 SecurityGuard),没有代码执行时
  // 模型照样能调 read_file 撞上拒绝 —— 那时它更需要知道原因
  return parts
    .concat(codeActPart(opts), packagesPart(opts), visionPart(opts), secretsPart())
    .join('');
}

/**
 * 沙箱里有哪些库可用 —— 说**实况**,不说声明
 *
 * 清单本体来自 `SANDBOX_DEPS`(与 sandbox-requirements.txt 同源),
 * 不在这里再手写一份 —— 这个项目已在「同一份事实写两处」上栽过多次
 * (visionAnalyzer / pythonExecutor / models.vision)。
 *
 * 缺失的必须**点名说没有**,而不是从「已预装」列表里悄悄去掉:
 * 模型对 pandas、requests 这类库有很强的先验,不明确否认它照样会 import。
 * 而代码里的 pip 已被禁,撞 ImportError 之后它自己修不了。
 */
function packagesAvailability(opts: EnvironmentOptions): string {
  const all = SANDBOX_DEPS.map(d => d.packageName);
  const missing = opts.missingPackages ?? [];
  const available = opts.availablePackages ?? all.filter(p => !missing.includes(p));

  const parts: string[] = [];

  if (available.length > 0) {
    parts.push(`沙箱已预装 ${available.join('、')}。`);
  }

  if (missing.length > 0) {
    // 点名 + 给出处置方式。不给方式的话它会卡在「装不上」上反复尝试
    parts.push(
      `**注意 ${missing.join('、')} 没有安装**，不要 import 它们（会 ImportError）。` +
        (opts.shellEnabled
          ? '需要的话用 run_command 装（会请用户确认），或换用已装的库。'
          : '请换用已装的库，或在回答里说明需要哪个库、让用户来装。'),
    );
  }

  return parts.join('');
}

/**
 * 第三方库怎么装
 *
 * 必须写。代码里的 pip 被 PIP_NO_INDEX 挡住之后,模型只会看到
 * 「No matching distribution found」—— 那句话不告诉它出路是什么,
 * 于是它会去试 --index-url、试直接 URL、试换包名,白烧好几步。
 * 挡住和出路必须同时说,只说前者等于制造一个新的卡点。
 *
 * 没有 shell 通道时也要说清「装不了」,否则它会一直在装包上打转 ——
 * 实测事故就是这个形态:模型想做 OCR,连着四步都在装包。
 */
function packagesPart(opts: EnvironmentOptions): string {
  if (!opts.pythonEnabled) return '';

  return opts.shellEnabled
    ? '沙箱预装的库之外要装新库时:**不要在代码里 pip install**(代码里的 pip ' +
      '不查索引,会拿到「No matching distribution found」)。用 run_command 装 ——' +
      '它每次请用户确认、把原样命令给他看。装之前想清楚包名:' +
      'import 名和安装名常常不同(cv2→opencv-python、PIL→pillow、sklearn→scikit-learn),' +
      '拼错的名字可能是别人抢注的恶意包,而用户是靠你给的那一行做判断的。'
    : '沙箱预装的库之外**装不了新库**(代码里的 pip 不查索引)。' +
      '缺库时不要反复尝试安装 —— 换用已装的库,或在回答里说明需要哪个库、让用户来装。';
}

/**
 * CodeAct 约定 + 常驻浏览器
 *
 * 「筛选发生在沙箱内」是核心:这条不写清楚,模型会 print 整页 HTML,
 * 一次烧掉几十万 token。
 * 「绝不 close 浏览器」是最硬的一条:一次 close 杀掉常驻实例,
 * 主 agent 后续轮次全部接不上 —— 子 agent 尤其需要知道这件事,
 * 因为它的 close 会连带毁掉**主 agent** 的会话。
 */
function codeActPart(opts: EnvironmentOptions): string {
  if (!opts.pythonEnabled) return '';

  return (
    '解析 docx/pdf/excel、抓取网页、数据清洗转换等任务，用 execute_python 写代码完成，' +
    '不要自己手工推断二进制格式。' +
    packagesAvailability(opts) +
    '只有 print 出来的内容会回到你的上下文且有体积上限，' +
    '务必在代码内先提取过滤再打印，绝不要 print 整页 HTML 或整个文件。' +
    '页面结构未知时先用 page.locator("body").aria_snapshot() 拿语义树，' +
    '或用 locator(...).count() 数条目，不要 print(page.content())。' +
    '注意 page.accessibility 在新版 Playwright 已移除。' +
    // 浏览器由框架常驻，模型只连接不启动。这条写错会让它每次开新浏览器，
    // 跨轮次的页面状态就丢了；而抓需要登录的站点时，用 requests 是抓不到正文的
    '浏览器已经由框架启动并常驻（有头窗口，登录态自动持久化）。' +
    '抓取网页优先用这个浏览器而不是 requests —— 需要登录或有反爬的站点，' +
    'requests 拿不到正文，而常驻浏览器带着登录态。' +
    '用 browser = p.chromium.connect_over_cdp(os.environ["BROWSER_CDP_URL"]) 连上去，' +
    'page = browser.contexts[0].pages[0] 拿到当前页面。' +
    '不要用 launch 或 launch_persistent_context 自己启动浏览器，' +
    '也绝对不要调 browser.close() 或 context.close() —— 那会杀掉常驻实例，' +
    '之后所有轮次都接不上了。需要新标签页时用 browser.contexts[0].new_page()，' +
    '用完 page.close() 可以。' +
    '因为浏览器跨轮次存活，上一轮打开的页面这一轮可以直接接着操作。' +
    '绝不要在代码里填写账号密码 —— 那会把明文凭证写进对话记录。'
  );
}

/**
 * 敏感文件禁止读取
 *
 * **单独一段、且不依赖 pythonEnabled**,两个理由:
 * ① 拦截发生在两处 —— audit hook(代码)和 SecurityGuard(read_file 工具)。
 *    塞在 CodeAct 那段里会漏掉工具那条路:没有代码执行时模型照样能调 read_file,
 *    而它对「为什么被拒」一无所知
 * ② 这条比「别 close 浏览器」更硬,不该做长段落的最后一句 ——
 *    位置本身就是权重
 *
 * 措辞上「拦什么」「为什么不能绕」「出路是哪」必须同时给。少了第二条,
 * 模型会把 PermissionError 当成路径写错去换写法;少了第三条,
 * 它会卡在这件事上反复试 —— 实测装包被禁时它连着四步都在试各种绕法。
 *
 * 刻意**不列**具体路径清单:清单按平台推导、十几条,写进提示既占篇幅又必然漂移
 * (这个项目已在「同一份事实写两处」上栽过多次)。说清类别就够模型判断。
 */
function secretsPart(): string {
  return (
    '**敏感文件禁止读取**：私钥（~/.ssh、~/.gnupg）、云与集群凭证（~/.aws、~/.kube、gcloud）、' +
    'token 类文件（.netrc、.git-credentials、.npmrc、.pypirc）、浏览器 profile 目录（里面的 ' +
    'cookie 等价于活凭证），以及本框架自己的 .env。' +
    '这些路径由框架强制拦截：代码里读会抛 PermissionError，read_file 会返回被拒绝。' +
    '**这不是路径写错，也不是权限没配好，换写法、换工具、换进程都一样** —— ' +
    '这类内容一旦读出就会进入对话记录、随请求发送出去并落进日志，事后无法撤回。' +
    '所以不要尝试绕过，也不要把读取失败当成需要排查的故障。' +
    '任务确实需要某个凭证时，说明用途、请用户以环境变量方式提供；' +
    '需要登录某个站点时用常驻浏览器的登录态，不要去翻凭证文件。'
  );
}

/**
 * 视觉插件
 *
 * 数据流是「图进视觉模型、文字回主模型」,所以这里只讲语义:
 * 你拿到的是别人对图的描述,不是图本身。
 *
 * **调用方式取决于 pythonEnabled**,这不是措辞差异而是事实差异:
 * 没有代码执行就没有工具桥,`registry.hide()` 不会执行,
 * 看图类工具会留在工具清单里、按 tool_call 调用。
 * 此时说「必须在代码里调」是错的 —— 模型会去写一段它跑不了的代码。
 */
function visionPart(opts: EnvironmentOptions): string {
  if (!opts.visionModel) return '';

  const how = opts.pythonEnabled
    ? '你可以看图，但**要在 execute_python 的代码里调**框架注入的函数' +
      '（不是工具调用，具体签名见 execute_python 的说明）。'
    : '你可以看图：调 view_image 工具。';

  return (
    how +
    '你拿到的是**视觉模型对图的文字观察**，不是图本身 ——' +
    `看图的是 ${opts.visionModel}，你只读它的描述。` +
    '因此**务必写清 question**：它只回答你问的东西，' +
    '不问就只能拿到泛泛描述，很可能恰好漏掉你要的信息。' +
    '要追问同一张图，再调一次并换个 question。' +
    '观察反映的是**调用当时**的状态，页面变化后请重新看，不要依据旧观察判断。'
  );
}

/**
 * 主 agent 的完整系统提示
 *
 * = 角色 + 环境约定 + (可选)下放子 agent 的指引
 */
export function buildMainSystemPrompt(
  opts: EnvironmentOptions & { subAgentEnabled: boolean },
): string {
  return (
    '你是 BaseAgent，一个可以调用工具完成任务的 AI 助手。' +
    '不要臆测工具结果。工具返回错误时，说明原因而不是反复重试同一路径。' +
    buildEnvironmentPrompt(opts) +
    (opts.subAgentEnabled
      ? '遇到需要读取大量内容才能得出结论的任务（遍历目录逐个读文件、批量搜索比对、' +
        '调研多个网站），用 spawn_subagent 下放给子 agent，避免原始内容占满当前上下文。' +
        '一两次工具调用能完成的事直接自己做。' +
        // 子 agent 没有 request_help,它遇到登录只能把这件事写进回答交回来。
        // 主 agent 必须知道这条,否则会把「需要登录」当成任务失败
        '注意子 agent **没有请求用户帮助的能力**：它遇到需要登录、验证码、人机检测时' +
        '只能把情况写进回答交回给你。收到这类回答时由你来处理 ——' +
        '用 request_help 请用户操作，完成后再把剩下的活下放一次。' +
        '所以下放前最好先确认目标站点是否已登录。'
      : '')
  );
}

/**
 * 子 agent 的完整系统提示
 *
 * 环境约定与主 agent **逐字相同**(同一个函数产出),差别只在角色:
 * ① 看不到主对话历史 ② 回答是唯一产物 ③ **没有 request_help**
 *
 * 第 ③ 条是产品决策:子 agent 的输出只回给主 agent,用户看不到它说的话。
 * 让它调 request_help 的话,用户压根不知道要去操作浏览器,而子 agent
 * 已经带着未完成的答案返回了 —— 所以工具层直接不给它这个能力,
 * 提示里也要说清,否则它会假设自己能等人。
 */
export function buildSubAgentSystemPrompt(opts: EnvironmentOptions): string {
  return (
    '你是一个专注的子任务执行器。你会收到一个自包含的任务，请用提供的工具完成它。\n' +
    '你看不到主对话的历史，任务描述里的信息就是你拥有的全部背景。\n' +
    // 这条必须显式说:否则它会写「请用户登录后重试」然后卡住等一个不会来的回复
    '你**无法与用户交互**，也没有请求用户帮助的工具，也不能执行外部命令（装库等）。' +
    '遇到需要登录、验证码、人机检测、缺少第三方库、或任何必须由人操作/确认的情况，' +
    '不要尝试绕过、也不要等待 —— 把「卡在哪一步、需要人做什么」写进你的回答，' +
    '交回主 agent 由它去请用户处理。\n' +
    // shellEnabled 强制为 false:run_command 不下放给子 agent(见 sub-agent.ts
    // 的 NO_SUBAGENT_TOOLS)。不覆盖的话提示里会让它去用一个自己没有的工具 ——
    // 这正是子 agent 提示词漂移的老毛病(它曾因此拿 requests 抓需要登录的站点)
    buildEnvironmentPrompt({ ...opts, shellEnabled: false }) +
    '\n完成后给出一段**高信息密度**的回答：直接写结论与关键事实（具体数值、路径、名称），' +
    '不要复述过程，不要客套。你的回答会作为唯一产物交回主 agent，' +
    '中间读到的原始内容不会传出去，所以必须把结论写全。'
  );
}
