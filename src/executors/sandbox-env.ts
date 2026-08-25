// ============================================
// Executors 层:子进程环境的单一来源(Python 与 Shell 共用)
// ============================================
//
// 为什么抽出来:凭证隔离必须**两个执行器一致**才有意义。
// Python 那侧费劲不继承 DEEPSEEK_API_KEY,bash 一句 `echo $DEEPSEEK_API_KEY`
// 就把这层还回去了 —— 各写一份白名单等于没有白名单。
//
// 本项目已在「逐字段拷贝」上栽过三次(visionAnalyzer / pythonExecutor /
// models.vision),所以这里从结构上只留一份。
// ============================================

/**
 * 默认继承的环境变量
 *
 * 只放「不给就跑不起来」的:找解释器和动态库要 PATH,
 * Windows 下 python 还依赖 SystemRoot / TEMP 一类。
 * 白名单而非黑名单 —— 黑名单漏一个键就是一次凭证泄漏。
 */
export const DEFAULT_INHERIT_ENV = [
  'PATH',
  'Path',              // Windows 上键名大小写不定
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',       // Playwright 找 chromium 缓存要用
  'LANG',
  'LC_ALL',
  'PYTHONHOME',
  'PYTHONPATH',
  'LD_LIBRARY_PATH',
  'DISPLAY',           // headless=False 在 Linux 上要
];

/**
 * 按白名单挑出要继承的父进程环境变量
 *
 * 不用 `...process.env` 是因为里面有 DEEPSEEK_API_KEY / VISION_API_KEY:
 * 模型写 print(os.environ['DEEPSEEK_API_KEY']) 就能把 key 打进上下文、跟着 trace 落盘。
 * 这不是隔离(进程仍是主环境全权限),只是不主动把凭证递到手里。
 */
export function inheritEnv(keys: string[] = DEFAULT_INHERIT_ENV): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

/**
 * 禁止在**代码里**装包的 env
 *
 * `PIP_NO_INDEX=1` 等价于给进程树里每次 pip 调用都加上 `--no-index`
 * (pip 的通用规则:任何长选项都能用 `PIP_<大写、连字符转下划线>` 设默认值)。
 * 于是 `pip install X` 拿到「No matching distribution found」并返回码 1。
 *
 * **它是路牌,不是锁**,这一点不能含糊:
 * - `subprocess.run(env=清掉这个键的副本)` 能绕 —— 实测返回码 0,装得上
 * - `pip install https://.../x.whl` 也绕 —— 直接 URL 不经索引,--no-index 无感
 *
 * 为什么仍然值得放:
 * 它拦的是「没在绕、只是按常规写法办事」的模型,而那正是实测事故的形态 ——
 * 模型想做 OCR、写了 `subprocess.run([sys.executable,"-m","pip","install",...])`,
 * 静默成功(返回码 0),顺带把用户全局环境里的 onnxruntime 升级了,
 * 用户是**事后翻 trace** 才发现的。
 *
 * 关键性质:env 默认**向子进程继承**,所以它覆盖得到 subprocess 起的新解释器
 * (实测:父进程设了,Python 里 subprocess 起 pip,照样被挡)。
 * 这正好补上写边界补不了的那块 —— audit hook 反过来,注册后删不掉、
 * 但只管当前进程,换个进程就绕过。两者在「进程边界」这一点上互补。
 *
 * 装包的正式通道是 shell 工具:它 danger:true,执行前把**原样命令**给用户看。
 * 那个确认才是真正起作用的地方 —— 一屏代码里第 23 行的 pip 没人看得见,
 * 而单独一行 `pip install rapidocr_onnxruntime` 用户会真的读清包名。
 * 这对 typosquatting(抢注近似包名,`pip install` 在安装期就执行 setup.py,
 * 等于远程代码执行)是唯一有效的防线,因为写边界拦不住它 ——
 * pip 的构建隔离恰好在放行的 TEMP 里跑。
 */
export const PIP_BLOCKED_ENV: Record<string, string> = {
  PIP_NO_INDEX: '1',
  // 顺带压掉「有新版 pip」这类噪声:它每次都往 stderr 写几行,占 token
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};
