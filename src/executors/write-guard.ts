// ============================================
// Executors 层:代码执行的写边界 + 读黑名单(Python audit hook)
// ============================================
//
// 写按**白名单**(工作区 + temp),读按**黑名单**(凭证类路径,见 read-deny.ts)。
//
// 为什么两侧用相反的策略:
// - 写/删是**不可逆**的,一次手滑就是真实损失,所以按白名单收紧
// - 读的白名单做不了 —— 实测一次 `import pandas` 触发 1183 次 open,
//   全是库加载。漏放行一个目录就是 import 直接失败
// - 但读**不能完全不管**:读错普通文件没有直接损害,读到凭证不一样,
//   值会进上下文、发给模型服务商、落进 traces,事后删不回来。
//   黑名单只列沙箱没有正当理由读的东西,误伤面接近零
//
// ⚠️ **已知缺口:换个进程就绕过。**
//
// audit hook 的性质是「注册后删不掉,但只管当前进程」。所以模型不需要攻击这个
// 钩子,只要**换个进程**:
//   subprocess.run([sys.executable, "-c", "open(r'C:\\x.txt','w')"])   # 实测成功
// 实测对照:同一路径直接写 → 被拒;经 subprocess 起新解释器写 → 返回码 0,
// 文件真的落盘了。os.system / os.spawn* / ctypes 调 CreateProcess、
// 以及机器上现成的 powershell / cmd / node / git 都是同一个出口。
//
// 因此本模块是**护栏,不是边界**:它挡住「没在攻击、只是按常规写法办事」的代码
// (实测事故就是这种 —— 模型想做 OCR,不是想越界),挡不住刻意绕的。
// 真边界必须在进程之外(容器 / 独立用户 / seccomp),属于待实现。
//
// 缓解措施(各管一段,都不管全部):
// - **沙箱 venv**(PYTHON_PATH 指向项目内 venv):装包落在 venv,碰不到用户全局
//   环境。结构性、无绕法 —— 治的是「污染」,不是「越界」
// - **PIP_NO_INDEX**(见 sandbox-env.ts):代码里 pip 装不上。同样是路牌不是锁,
//   但它借的是 env **向子进程继承**的性质,恰好覆盖 subprocess 这条路
// - **run_command**(danger:true,原样命令给用户看):装包的正式通道。
//   pip 在安装期就执行 setup.py、而构建隔离跑在放行的 TEMP 里 ——
//   写边界对这条路完全无感,只有人读那行命令才拦得住 typosquatting
//
// 明确**不做**(评估后放弃,不是欠的债):
// - **网络管控**:实测无效。Playwright 全流程里 socket.connect 只出现 2 次、
//   都是 127.0.0.1(Python 连本地 driver);真正访问网站的是 node driver 与
//   chromium 独立进程,audit hook 只约束 Python 进程,一个字节都看不到
// - **subprocess / ctypes 调用栈分析**:实测 subprocess.Popen 的 executable 参数
//   是 None、命令行是一整个带空格的字符串,无法可靠切分;而 ctypes.dlopen
//   有正常用途(标准库查时区会 dlopen kernel32/tzres.dll)。
//   要区分「谁触发的」需要栈分析,复杂且脆弱。
//   **注意这条只说明「拦 subprocess 很难」,不改变上面那个缺口的存在**
// - **sitecustomize.py / .pth 注入**(让新解释器自动装同一份写边界):可行且便宜,
//   但绕法仍在(`python -S` 不加载 site、`-I` 连 PYTHONPATH 一起忽略),
//   而且只覆盖 Python 子进程。加了容易让人误以为进程内边界补上了 ——
//   PIP_NO_INDEX + run_command 确认已经覆盖了实际发生过的场景,故暂不做
// - **读路径白名单 / 分级策略 / 中途授权确认**:白名单见上(误伤 import);
//   中途授权确认还需要 CodeAct 工具桥,且结构上不可能 —— 代码块是原子的
// - **读侧的 realpath**:读黑名单只做 abspath 前缀匹配,不解析符号链接。
//   于是「工作区内建软链接指到 ~/.ssh,再读那个链接」能绕过。
//   不补是权衡:realpath 要按路径分量做 syscall,而读事件一次 import 上千次;
//   更关键的是 subprocess 那条绕法**更省事**,补了符号链接也不会让谁绕不过去。
//   fs 工具那一侧(SecurityGuard)是做 realpath 的,严格于此
//
// 剩余风险(产品决策,不是技术限制):
//   读黑名单之外的文件模型仍读得到,并可借浏览器把内容发出去。
//   自用场景 + 用户信任该 agent 的前提下接受 —— 同类工具(Codex/Claude Code)
//   也是全权限跑在用户机器上。黑名单收的只是**纯负债**的那部分(凭证),
//   因为那类内容一旦进上下文就已经发给模型服务商了,事后删 trace 追不回。
//
// 配置面：用户只需指定**工作区**一项,其余(Python 安装目录、temp)运行时推导。
// ============================================

import * as path from 'path';

/**
 * 生成注入到模型代码之前的 prelude
 *
 * 关键性质:audit hook 注册后**无法注销**(PEP 578 故意不提供 remove),
 * 所以模型的代码删不掉它。因此 prelude 必须排在模型代码之前执行。
 *
 * 钩子里做的判断要极轻:一次 import 就触发上千次事件。
 * 写类事件很少,可以做 realpath;读类事件是绝大多数,只做
 * 一次 `str.startswith(tuple)`(C 层单次调用),不做 realpath ——
 * 代价是符号链接绕得过,见顶部「明确不做」。
 *
 * @param workspace 工作区绝对路径(用户唯一需要配置的项)
 * @param readDenyPaths 读黑名单(绝对路径)。见 read-deny.ts;
 *   与 SecurityGuard 用同一份清单,两边不同源会造成不报错的错位
 */
export function buildWriteGuardPrelude(
  workspace: string,
  readDenyPaths: readonly string[] = [],
): string {
  // 用 JSON.stringify 转义路径：Windows 反斜杠直接插进 Python 源码会变转义符
  const ws = JSON.stringify(path.resolve(workspace));
  const deny = JSON.stringify(readDenyPaths.map(p => path.resolve(p)));

  return `# --- BaseAgent 写边界 + 读黑名单(自动注入,不可移除) ---
def _baseagent_install_guard():
    """
    所有状态与判定函数都放在**闭包**里,不留任何模块级名字。

    这一点是必须的,不是风格问题:模块级的 def 在被调用时会从 globals
    查找它引用的名字,于是模型代码只要写一行同名定义
        def _inside(p): return True
    就能把判定逻辑整个换掉 —— 实测确认可绕过。
    闭包变量走 LOAD_DEREF,外部无法重新绑定,所以覆盖不生效。
    """
    import sys, os, tempfile

    ws = os.path.realpath(${ws})
    # temp 也放行：库运行时要在这里落临时文件（实测 pandas/playwright 都会）
    allow = (ws, os.path.realpath(tempfile.gettempdir()))
    sep = os.sep
    normcase = os.path.normcase

    # 读黑名单。normcase 是必须的：Windows 上路径大小写不敏感,
    # 不归一化则 C:\\Users\\x\\.ssh 与 c:\\users\\x\\.ssh 判成两个路径。
    #
    # 拆成 exact + prefixes 两个结构是为了**读事件的性能**:
    # 一次 import 触发上千次读,判定必须是 O(1) 的 C 层调用 ——
    # set 查一次 + startswith 吃元组(单次 C 调用),不写 Python 循环
    _dn = tuple(normcase(r) for r in ${deny})
    deny_exact = frozenset(_dn)
    deny_prefixes = tuple(r + sep for r in _dn)
    # 黑名单为空时读事件一个字节的工作都不做:省掉每次 open 的一次函数调用
    deny_roots_present = bool(_dn)

    # 只拦这些。open 单独处理（要看 mode），其余是纯写操作
    write_events = frozenset((
        "os.remove", "os.rename", "os.replace", "os.rmdir",
        "os.mkdir", "os.makedirs", "os.truncate", "os.link",
        "os.symlink", "os.chmod", "os.chown", "shutil.copyfile",
        "shutil.copymode", "shutil.copystat", "shutil.move",
    ))
    wflags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC
    realpath, abspath = os.path.realpath, os.path.abspath

    def inside(p):
        try:
            # realpath 解析符号链接：否则工作区内一个软链接就能指到外面
            rp = realpath(abspath(p))
        except Exception:
            return False
        for root in allow:
            if rp == root or rp.startswith(root + sep):
                return True
        return False

    def deny(op, p):
        raise PermissionError(
            "写入被拒绝: %s -> %s\\n"
            "代码只能在工作区内写文件。工作区: %s\\n"
            "要写到别处,请改用工作区内的相对路径;"
            "确实需要访问其他目录时,请在回答里说明并请用户授权。" % (op, p, ws)
        )

    def denied_read(p):
        """
        读黑名单判定。只做 abspath,不做 realpath —— 读事件一次 import 上千次,
        realpath 会按路径分量做 syscall。代价是符号链接绕得过(见顶部「明确不做」)。

        bytes 路径必须先 fsdecode:open(b"...id_rsa") 是合法调用,
        而 bytes 和 str 前缀比较永远为假 —— 不转换就是一条静默绕过。
        """
        if isinstance(p, int):
            return False
        try:
            if isinstance(p, bytes):
                p = os.fsdecode(p)
            elif not isinstance(p, str):
                p = os.fspath(p)      # PathLike(如 pathlib.Path)
            np = normcase(abspath(p))
        except Exception:
            # 判不出来就放行:这里错杀的代价是任意读操作报错,
            # 而黑名单本来只是护栏(subprocess 就能绕),不值得为它牺牲可用性
            return False
        return np in deny_exact or np.startswith(deny_prefixes)

    def refuse_read(p):
        raise PermissionError(
            "读取被拒绝: %s\\n"
            "该路径属于凭证类数据(私钥/云凭证/token/浏览器 cookie),"
            "沙箱代码不允许读取。\\n"
            "这类内容一旦读出就会进入对话上下文并发送给模型服务商,"
            "事后无法撤回 —— 所以这条限制不能由代码自己绕过。\\n"
            "如果任务确实需要某个凭证,请让用户以环境变量方式提供。" % (p,)
        )

    def hook(event, args):
        # 一次 import 触发上千次 open,所以最热的这条路径要尽早分流
        if event == "open":
            # (path, mode, flags) —— mode 为 None 时表示底层 os.open,看 flags
            if len(args) < 2:
                return
            p, mode = args[0], args[1]
            if mode is None:
                try:
                    writing = bool((args[2] if len(args) > 2 else 0) & wflags)
                except Exception:
                    writing = False
            else:
                writing = any(c in str(mode) for c in ("w", "a", "x", "+"))
            if not writing:
                # 读:只查黑名单。白名单在这一侧做不了 ——
                # 实测一次 import pandas 触发 1183 次 open,全是库加载
                if deny_roots_present and denied_read(p):
                    refuse_read(p)
                return
            # fd（int）不是路径，无法判定归属，放行 —— 拿到 fd 前必然已过一次检查
            if isinstance(p, int):
                return
            # 写到黑名单里也拒,且用读的措辞:凭证目录通常本来就在工作区外,
            # 会被 inside() 拦掉,但工作区内的 .env 之类只有这条能拦
            if deny_roots_present and denied_read(p):
                refuse_read(p)
            if not inside(p):
                deny(event, p)
            return

        # 列目录:拦的是「有哪些凭证文件」这类信息。事件本身很少,不影响热路径
        if event in ("os.listdir", "os.scandir"):
            if args and deny_roots_present and denied_read(args[0]):
                refuse_read(args[0])
            return

        if event in write_events:
            if not args:
                return
            p = args[0]
            if isinstance(p, int):
                return
            if not inside(p):
                deny(event, p)

    sys.addaudithook(hook)

_baseagent_install_guard()
del _baseagent_install_guard
# --- 写边界结束 ---

`;
}
