# BaseAgent — 踩坑记录

这份文档收录开发过程中**实测踩到**的坑,供复盘。

与 [agent-architecture.md](agent-architecture.md) 的分工:那份写「设计是什么、
为什么这样设计」;这份写「哪些做法试过并且错了、错的表现是什么」。
两份都保留「为什么」,区别在于这里的每一条都对应一次真实故障。

**为什么单独成文**:这些记录的价值在于**症状**而不是结论 —— 结论一句话就能写完
(「同一份事实不要写两处」),但下次再犯时你看到的是症状,不是结论。
所以每条都尽量保留:当时的表现、误导性在哪、怎么定位到的。

---

## 一、同一份事实写两处 —— 本项目栽过五次

这是**唯一一个反复出现的失败模式**,值得单独列在最前面。

形态:某个事实(资源清单、路径推导规则、配置项)需要在两处保持一致,
而代码里各写一份。**错位不报错**,只表现成别的症状。

### ① 逐字段转发执行器 —— 漏 `visionAnalyzer`

子 agent 自己建 `ToolRunner`,原先逐字段转发父级资源。加了视觉插件后
忘了转发 `visionAnalyzer`,子 agent 拿不到。

### ② 逐字段转发执行器 —— 漏 `pythonExecutor`(表现极具误导)

同一个位置、同一个失败模式,第二次。这次的症状值得记:

子 agent **注册了** `execute_python` 却拿不到执行器,每次返回「未初始化」。
它以为是自己代码的问题,连跑 `print("hello")` / `print(sys.version)` 探活,
**白烧十几步才放弃**(实测 trace 22 轮)。

修法是抽出 `InheritableRunnerConfig`:一个对象、入口构造一次、主 runner
与子 agent 共用同一份。于是「新增执行器忘了给子 agent」这个失败模式
**从结构上消失**。该类型刻意不含 `subAgentRunner` —— 递归的阻断因此有两道:
工具集过滤 + 类型上就传不进去。

连带的隐式顺序约束:子 agent runner 必须建在 `pythonExecutor` 之后。
靠回归测试锁住(`sub-agent.test.ts` 一次性断言「父 runner 能注入的子 agent
全拿得到」,而不是逐个断言某个执行器 —— 后者等于把同一个漏再写一遍)。

### ③ `models.vision` 在 loadConfig 里被丢掉

`loadConfig` 浅合并顶层字段,新加的 `models.vision` 段没有单独合并,
配了等于没配。

### ④ `fsGrants` 不跟随 `overrides.workspace`

`fsGrants`(fs 白名单)在 `defaultConfig` 里由 `resolveWorkspace()` 算一次,
而 `loadConfig` 浅合并 `security` —— 于是**客户端改了工作区,白名单还是旧的**。

症状:界面显示新工作区,所有文件类工具却按旧边界判定。写探针
(`probe-ws.ts`)打印实际的 `fsGrants` 才确认。

修法:`deriveFsGrants(workspace, traceDir)`,由 `loadConfig` 在合并后调用。

### ⑤ `MAIN_MAX_TOKENS` / `MAIN_TEMPERATURE` 是死配置

Adapter 写 `max_tokens: request.maxTokens`,依赖每个调用方传;
而 orchestrator 两处 `complete()` **都不传**。于是配了 `MAIN_MAX_TOKENS=256`,
trace 里 `max_tokens=undefined`、`completion=14485`。

修法:adapter 自己持有默认值(`request.maxTokens ?? this.config.maxTokens`),
由 session 在装配时注入。

附带一条:`temperature` 用 `??` 不能用 `||` —— `temperature: 0` 是合法值
(确定性输出),真值判断会静默回落。

### 由此定下的规则

需要在两处保持一致的事实,一律**抽成一处、两边共用**,而不是各写一份加注释提醒:

- `sandbox-env.ts` / `capped-buffer.ts` / `process-tree.ts` —— 两个执行器共用
- `read-deny.ts` —— SecurityGuard 与 audit hook 共用。各算一份会出现
  「工具读不到、代码读得到」这种不报错的错位(修补前正是这个形态:
  `fsDeniedPaths` 只挡住 fs 工具,代码里一句 `open()` 照读)
- `buildEnvironmentPrompt` —— 主 agent 与子 agent 的环境段**逐字相同**
- venv 的 Scripts 目录由 `PYTHON_PATH` 推导,不另配 —— 两处配置必然错位,
  而错位不报错,只表现成「venv 里装了、代码里 import 不到」

---

## 二、上下文与压缩

### 压缩注入了与事实相反的摘要

送给压缩模型的每轮原先只有「提问 + 工具名」,缺工具结果和最终回答。
模型只能靠猜补全 —— 实测出现「工具调用后未返回具体时间数据」这种摘要,
**而那轮工具明明成功了**。

压缩注入假事实比丢一段摘要严重得多。修法:每轮包含
提问 + 工具调用 + **工具结果** + **最终回答**,按字段截断(保留开头,`ok` 标志在前)。

### 给摘要设字数下限,产出比原文还长

字数只给上限不给下限。给下限会逼模型注水复述过程 —— 实测发生过。

### `turn_id` 撞号(静默连锁)

原先由 `this.turns.length + 1` 派生,而压缩执行 `this.turns = recentTurns`
把数组截短 —— 15 轮压到保留 10 轮后,下一轮算出 11,与已存在的第 11 轮撞。

后果**全是静默的**:`activeTurnTopics` 映射错乱、归档文件 `turn-011.json`
被覆盖、历史落盘按 turn_id 判断进度,于是压缩之后每一轮都不再写入。

修法:独立的单调计数器,与 turns 的增删解耦。续接会话时抬到历史最大 id
(取 max 而非 length —— 文件里可能有坏行被跳过)。

### `peekTurns()` 必须含进行中那一轮

`finalizeTurn()` 只在 `addUserMessage()` 里调,于是一个轮次要等
**下一条用户消息**才进 `turns`。

两处踩到同一个形状:
- 记忆抽取发生在轮末,只取 `turns` 会让抽取器永远看不到最新一轮(最新鲜的证据),
  且第一轮结束时拿到空数组直接返回
- 历史落盘若挂在 `finalizeTurn()`,**每个会话的最后一轮永远不落盘**

### 记忆抽取按「token 增量」触发是错的

原先在「每 N 轮」之上叠了一层 token 增量。实测发现那个量取的是模型**输出**增量,
而用户在横幅上看到的是上下文水位(`total_prompt`)。

同一次会话:输出累计 3656、水位涨到 11966,**差三倍多** —— 于是出现
「聊了 11k 还没触发」。两个量各自都能自圆其说,放在一起就是让人猜不到
什么时候会抽。改为纯轮次计数(粗但可预测)。

### `archive/` 全为空 —— 压缩从没触发过

实测 8 个客户端会话的 archive 全空。窗口 1M、阈值 0.7,压缩一次都没跑。
于是所有轮次只活在内存里,关掉客户端就没了。

这暴露的是**缺「轮次完成即落盘」**,而不是压缩坏了。由此分出两份存储:
`turns.jsonl`(完整原始对话,给前端)与 `archive/`(被压缩挤出的轮次,给模型回溯)。

`recentTurnsToKeep` 同理是个**从未生效**的配置:它是压缩的地板/闸门,
而压缩按 token 触发,1M × 0.7 的阈值让整个机制没跑过。

---

## 三、权限与沙箱边界

### 判定函数放模块级,一行代码就能换掉

第一版把 audit hook 的路径判定函数放在模块级。模型代码写一行
`def _inside(p): return True` 就能整个换掉 —— **实测确认可绕过**。

原因:模块级函数被调用时从 globals 查名字。修法是放进闭包 ——
闭包变量走 `LOAD_DEREF`,外部无法重绑。

### 读白名单做不了 —— 一次 `import pandas` 触发 1183 次 `open`

原计划读也按白名单。实测 `import pandas` 一次触发 1183 次 `open`,
漏放行一个目录就是 import 直接失败。

于是改成**写按白名单、读按黑名单**,两侧策略相反:
- 写/删不可逆,一次手滑就是真实损失 → 收紧到工作区 + temp
- 读错普通文件没有直接损害,但读到凭证不一样:值会进上下文、发给模型服务商、
  落进 traces,事后删 trace 追不回已经发出去的那一次 → 只列**纯负债**的路径
  (私钥/云凭证/token/浏览器 cookie/本框架 `.env`),误伤面接近零

### `pip install` 污染了用户全局环境(触发写边界修补的事故)

模型为做 OCR 在代码里 `pip install rapidocr_onnxruntime`,返回码 0 静默成功,
**顺带升级了用户全局环境的 `onnxruntime`**,用户事后翻 trace 才发现。

危害不止「多几个文件」:pip 在**安装期**执行 `setup.py`(PEP 517 后端),
而构建隔离恰好跑在放行的 TEMP 里 —— 等于**远程代码执行**。
配合 typosquatting(抢注 `opencv-pythonn` 一类近似名),
而模型是凭记忆猜安装名,**猜错概率比人打错字高得多**。

### ⚠️ 写边界换个进程就绕过(已知缺口,不是设计选择)

audit hook 的性质是「注册后删不掉,但**只管当前进程**」。所以模型不必攻击钩子,
只要换个进程。实测对照:

| 做法 | 结果 |
|---|---|
| 同一路径直接 `open(...,'w')` | 被拒 |
| `subprocess.run([sys.executable, "-c", "open(...,'w')"])` | **返回码 0,文件落盘** |

`os.system` / `ctypes` 调 CreateProcess、以及机器上现成的 powershell / node / git
都是同一个出口。

所以写边界是**护栏,不是边界**:挡得住「没在攻击、只是按常规写法办事」的代码
(上面那次 pip 事故正是这种 —— 模型想做 OCR,不是想越界),挡不住刻意绕的。

### 读黑名单挡不住的两条路

① `subprocess` 换个进程(同上);
② `page.goto("file:///.../id_rsa")` + `inner_text("body")` 三行原样取回 ——
chromium 是独立进程,audit hook 只约束 Python。

而**写**这一侧没有对应的绕过路径:chromium 不能往任意路径写文件
(没有 `file://` 写语义,下载目录受控)。于是能守住的恰好是不可逆的那一半。

### 工作区约束的实际语义与直觉相反

实测同一个工作区外的普通文件:

| 通道 | 工作区外的读 | 工作区外的写 | 凭证类路径 |
|---|---|---|---|
| fs 工具(`read_file` 等) | 拒绝 | 拒绝 | 拒绝 |
| 沙箱代码(`execute_python`) | **允许** | 拒绝 | 拒绝 |

这个不对称是「写按白名单、读按黑名单」的直接后果,不是漏洞。但它与直觉相反
(「未授权也不可读才逻辑通顺」),所以在 `.env.example` 与 `config.ts` 的
`workspace` 注释里都写明了 —— **配置项的语义不能只有读过架构文档的人知道**。

### env 全量透传会把 API key 交给模型

`process.env` 里有 `DEEPSEEK_API_KEY`,全量继承则模型一行
`print(os.environ[...])` 就能把它打进上下文并跟着 trace 落盘。
改为按白名单继承,两个执行器共用同一份清单。

---

## 四、流式与中断

### openai SDK 的 abort 是**静默**的

`streaming.js:69` / `:116` 里:

```javascript
if (e instanceof Error && e.name === 'AbortError') return;
```

`for await` 因此**正常退出**,不抛异常。于是代码继续往下走,
去 `JSON.parse` 一个半截收到的 `tool_calls.arguments`,
抛出「流式工具调用参数不是合法 JSON」。

症状:点停止 → 界面弹一条红色报错。用户以为停止功能坏了。

修法:在 parse **之前**检查 `signal?.aborted`。顺序是关键,不是保险。

### `AbortController` 一旦 abort 就永久失效

会话级的单个 controller 意味着「点一次停止,整个会话再也发不出请求」。
所以下游必须取 `getSignal: () => AbortSignal`,每次现取;
`run()` 在开头换新的 controller。

### `isAbortError` 必须按 `name` 匹配,不能用 `instanceof`

错误会穿过 SDK 边界。SDK 升级或重复安装会让 `instanceof` 静默失效。
按 `name === 'AbortError' || name === 'APIUserAbortError'` 判断。

### 中断必须**第一个**判、且与 `retryableErrors` 解耦

中断抛出的 `APIUserAbortError` 带 message「Request was aborted.」——
里面没有可重试特征。但只要将来有人往 `retryableErrors` 里加了 `'abort'`
或 `'canceled'` 之类的词,**点一次停止就会打出三次新请求**。

那时的表现是「越点停止越忙」,而账单上才看得见。所以 `isRetryable()`
第一行就挡掉中断,与清单内容彻底解耦。

### `finishReason === 'length'` 没人读

被截断的回答与正常回答**结构上同形**(有正文、无 toolCalls),
所以它走的是正常的 `complete` 路径 —— 表现只是「话说到一半就没了」。

而且截断且无正文时**不能报 `no_response`**:那是错误归因 ——
模型确实回答了,是我们没给够空间(256 预算、开着思维链时 155 给了推理)。
新增 `stopReason: 'truncated'` 并在界面上说明「可在设置里调大该值」。

### Electron IPC 只序列化 `Error.message`

自定义字段会丢(`LLMError.detail` 里正是服务端原话),
还会给消息加上「Error invoking remote method '...':」前缀。

所以失败一律**当返回值**回去(`{ok:false, error, detail, code}`),不让异常穿过 IPC。

### `LLMError.detail` 不能进 `message`

服务端原话进 `message` 会让外层 `RetryHandler` 按特征匹配到
`ECONNRESET` 之类的词,导致两层重试**相乘**(4×4=16)。
`RetryHandler` 只看 message/code/status,所以 `detail` 能原样传到界面
而不改变匹配面。

---

## 五、抽取类调用(结构化输出)

### 思维链吃光输出预算 → `content` 为空

**最新一例,值得完整记录。**

技能抽取 4 次调用全部失败:

```
attempt 1 → 模型返回空内容
attempt 2 → 模型返回空内容
attempt 3 → JSON 解析失败
attempt 4 → 模型返回空内容
→ 重试次数已用尽,库保持原样
```

翻 `traces/app-1788091462247/calls/call-019.json` 才看清:

```
max_tokens: 2000
thinking: { type: "enabled" }
input: 13321 字
→ parsed.content = ""      (长度 0)
→ reasoning    = 巨长
```

`reasoning_content` 里模型**把整份答案都想完了** —— 名字、description、
四个步骤、四条 pitfalls、note,一字不差全在推理里,然后预算用尽,
`content` 一个字都没轮到。

**代价**:4 × 40 秒 ≈ 2 分 40 秒全白花。而失败原因是预算不够,
**重试不会让预算变多** —— 这类「重试注定无效」的失败目前只表现成
「重试次数已用尽」,真正的诊断信息(`finish_reason`/`usage`/reasoning 长度)
只在 trace 里。

根因是 `MEMORY_MAX_TOKENS` / `SKILL_MAX_TOKENS` 各自兜底 2000 ——
一个**暗默值**:配了 `MAIN_MAX_TOKENS` 也管不到这里。
修法是删掉兜底,留空即跟随主模型。

必须两处一起改:只改 config 的话,manager 里那层 `?? DEFAULTS.maxTokens`
会把 `undefined` 兜回去,改动等于没做。

### 名字用严格相等去重 → 库里两条同名条目

`mergeSkillExtraction` 与 `findSkill` 原先用 `s.name === name`。
抽取模型两次写出的名字只要差一个空格、一个全角标点,或在 40 字上限处
截断位置不同,就配不上 → 走 `push` 新建一条。

症状:界面上两个**看起来一模一样**的名字,各带一半步骤,谁也不完整。
而且它绕过了「保留 hits」规则 —— 新条目 hits 从 0 开始,老条目的资历被稀释。

修法:先试严格相等(模型照索引原样抄名字时是常态),配不上再用归一化
(去所有空白 + 转小写)。**不去标点** —— 那会把「导出-CSV」和「导出CSV」
并成一条,而它们可能真是两件事。

### 抽取器结构上不能删除条目

若让它输出整张表(填表式覆写),「用户要说中文」这类十轮前定下、
本区间完全没体现的条目会被**静默抹掉**,而这种丢失没有任何迹象。

这一点必须是结构保证(它只输出候选 + 矛盾标记,合并由代码做、默认全部保留),
不能靠 prompt 里写一句「没看到的别删」。

### 更新时保留 `hits` / `createdAt`

那是条目的资历,而 hits 正是淘汰依据。重置会让排序错乱。
同理更新分支要回报**库里那个名字**而不是新抽出来的 ——
两者可能只差一个空格,日志打新名字会让人按那个去查、查不到。

---

## 六、客户端渲染

### 流式追加不能在 DOM 变高后再判断是否贴底

原先 `follow()` 是先改 DOM,再调用 `atBottom()`。流式内容一追加,`scrollHeight`
已经变大,即使用户追加前明明贴着底,追加后也可能被判成「不在底部」。

症状:长行为里底部还在继续输出,但视口停在旧位置不再跟随;「回到最新」按钮亮着,
用户会以为界面卡死。

修法:每个会改变高度的事件入口先保存 `wasAtBottom = atBottom()`,
DOM 更新后把这个快照传给 `follow(wasAtBottom)`。判断的是**追加前**用户是否愿意跟随,
不是追加后布局把他甩开了多远。

### 流式输出时不要用 smooth scroll 做兜底按钮

`scrollTo({ behavior: 'smooth' })` 是异步动画。持续流式输出会不断改变高度并触发滚动事件,
动画很容易被打断,表现成「按钮点了没用」。

修法:按钮点击走同步 `scrollTop = scrollHeight`,并在下一帧再校正一次。
如果页面里还有当前活动的内部滚动区(例如 `.think-text`),按钮也要一起滚它,
否则外层到了底,里面仍停在旧位置。

### 长流式文本不要反复重写整段 `textContent`

`buf += text; node.textContent = buf` 在短回答里看不出来,长推理/长正文里会变成
每个分片都重写整段文本,越到后面越慢。症状和滚动 bug 很像:内容还在来,
但界面开始发黏、按钮响应变差。

修法:流式期间保留一个 `Text` 节点,每次只 `appendData(text)`。
本轮结束时再用完整 `buf` 做一次 Markdown 渲染。

### 推理块自己的滚动区把内容吃掉

`.think-text` 有 `max-height: 300px; overflow-y: auto`,而 `reasoning()`
每来一段增量只调 `follow()` —— 那个函数滚的是外层 `.stream`,从不碰这个盒子。

症状:长推理填满 300px 之后,后续文字全进了盒子**自己的**滚动区下面。
外层因为已到底所以滚不动,而内容确实还在长 —— 表现成
**「还在跑、滚不下去、但下面明明有输出」**。

从外层看一切正常:`scrollHeight` 没变,因为盒子高度是固定的。

### 流式渲染状态不能跨轮复用

`think` / `answer` / `buf` 这类状态必须每轮新建。提到模块作用域后,
上一轮的 DOM 节点或文本缓冲会被下一轮继续写。

症状:新问题的正文续到上一轮气泡里;或者像早期调试壳踩过的同类问题一样,
`streamed` 这类标志泄漏,导致回答整段消失。

### 推理过程不能简单聚合成一个总块

多步 agent 的推理和工具调用是交错的。若把推理聚合成一个总的「思考过程」,
这个块的位置会在第一次推理到达时固定,后续第 4 步推理可能显示在第 2 步工具调用上面。

这不是审美问题,而是因果顺序错了:界面最该表达的是「这段推理导致这次工具调用」。
所以推理按步分块,并在工具开始、正文开始、进入下一步、本轮结束时收口。

### `[hidden]` 被作者样式表打平

浏览器默认 `[hidden] { display: none }` 特异度是 (0,1,0),
而 `.modal-mask { display: flex }` 同样是 (0,1,0)。平手时**作者样式表赢**,
于是带着 `hidden` 属性的元素照样显示。

症状:确认框(z-index 20)铺满全屏拦掉所有点击,而它的按钮事件只在 `ask()`
里绑定、从未被调用 —— 表现成「界面卡在确认框上,点哪儿都没反应」,
而 DOM 里 `hidden` 属性明明是对的,**从 JS 那边完全查不出问题**。

修法:`[hidden] { display: none !important; }` 一条兜住。
不给每个 mask 单独写 `&[hidden]` —— 那要求每次新加可隐藏元素时都记得补一条。

### flex 项默认 `flex-shrink: 1` 导致内容被压扁

`.stream` 是 flex 容器(column),内容超出容器高度时每个 `.msg` 会被**压扁**、
里面文字被裁掉,而容器的 `scrollHeight` 等于**压扁后**的高度之和。

三个症状同一个原因:最下面的内容看不见、滚轮到底也没用、窗口缩小时更严重。

### `window.prompt()` 在 Electron 里什么都不做

Electron 刻意没实现它 —— 调用后什么都不发生**且不报错**,
表现成「按钮点了没反应」。改用原生目录对话框。

顺带解决了另一个问题:网页拿不到绝对路径(`webkitdirectory` 只给相对路径、
`showDirectoryPicker` 只给 handle),而 `workspace` 必须是绝对路径,
填错的后果是所有文件类工具静默全拒。

### 启动必须摘掉 `ELECTRON_RUN_AS_NODE`

该变量存在时 electron 退化成普通 Node 运行时,`app` / `ipcMain` /
`BrowserWindow` 全为 undefined。实测报错是
`Cannot read properties of undefined (reading 'handle')` ——
**完全指不到真正的原因**。IDE 与各类工具会设它且会继承,
所以在启动路径上删,不靠文档提醒。

### 回填合成值会静默丢配置

shell 的生效是三个条件的合成(`shell.enabled && workspace && allowDangerousTools`)。
配置面板若回填**合成值**:勾了 shell 但没勾「允许危险工具」时,
面板显示未勾选,用户下次保存就把自己存的 `true` 写成了 `false` ——
而这个过程没有任何提示。

修法:回填**用户勾的那个原始值**(`shellConfigured`),
另外用一行提示说明「你开了但没生效」。

### 数值输入框的空值必须是 null 而不是 0

`maxSteps=0` 是个合法数字,存进去会被当成「用户就要 0」,
表现成「主循环一步不走就返回 max_steps」,看起来像卡死。

### 切会话/保存配置会拆掉正在跑的会话

`switchSession()` / `restart()` 都会 `dispose()` 当前会话(关 DB 句柄、停工具桥),
而 `agent:run` 刻意持有**局部**的 session 引用 —— 那一轮会继续跑在被拆掉的
实例上,表现成任务半途开始报一串莫名的工具失败。

侧边栏原先是 `if (busy) return` 静默拦下(症状是「点了没反应」),
而保存按钮**压根没拦** —— 那才是真正暴露这条路的口子。

---

## 七、原生依赖与运行时

### better-sqlite3 的 ABI 与 Electron 不匹配

症状:

```
NODE_MODULE_VERSION 127 ... requires 132
```

本机 Node v22 = ABI 127,Electron 34 内置的 Node = 132。

**关键事实**(我一开始判断错了):v11 起 better-sqlite3 按 ABI 分目录存二进制
(`bin/win32-x64-132/`),所以两个运行时各加载自己那份 —— `electron-rebuild`
之后**Node 入口不会坏**。用
`ELECTRON_RUN_AS_NODE=1 electron -e ...` 验证过 ABI 132 侧可用。

### `platform/index.ts` 的 `export *` 会让 8 个测试文件加载原生模块

`export * from './storage.js'` 意味着任何 `from '../platform/index.js'`
都会在 import 时刻加载 `.node`。

修法是 `createRequire` 惰性加载,**不用 `await import()`** ——
后者会让构造函数变成 async,进而感染所有调用方。

### vitest 不做类型检查

vitest 走 esbuild,只转译不检查类型。所以「测试全过」和「`tsc` 干净」
是两件事,必须分别跑 —— 我曾在 `tsc` 红着的时候报告「测试通过」。

---

## 八、提示词与模型行为

### 子 agent 对运行环境一无所知

子 agent 原本用一段独立短提示,只讲「你是子任务执行器、看不到主对话历史、
回答要高信息密度」。后果按危害排序:

1. **它的错误会毁掉主 agent** —— 不知道「绝不能 `close()` 浏览器」,
   一次 close 杀掉常驻实例,主 agent 后续所有轮次都接不上,profile 还被锁住
2. **任务直接做不成** —— 不知道浏览器是框架常驻的,拿 `requests` 硬抓知乎/搜狐,
   没有登录态基本抓不到正文(实测 trace 里就是这么干的)
3. **白烧步数** —— 不知道动作空间已收敛,去调 `write_file` 撞「工具未注册」
4. **撑爆自己的上下文** —— 不知道 stdout 上限与「先提取再打印」

修法:环境段由 `buildEnvironmentPrompt` 产出、两份提示**逐字相同**。
测试锁的是**同源性**(断言整个环境段被原样嵌入),而不是「提示里有某句话」。

这条测试当时就抓到一个真 bug:`pythonEnabled=false` 时收敛段与视觉段仍在
引用 `execute_python`,而那时它根本不存在。视觉那处更严重 —— 没有工具桥
就不会 `hide()`,`view_image` 仍是普通工具,说「必须在代码里调」
会让模型写出一段它跑不了的代码。

### 环境段不能写函数签名

签名由工具桥从 schema 生成、写在 `execute_python` 的 description 里。
手写一份必然漂移(之前就漏了 `detail` 参数),
而漂移的表现是「模型照提示调用却报 TypeError」。

### 收敛动作空间必须同步改系统提示

模型不会因为工具消失就自动改用代码 —— 它会照旧发 `write_file`
然后撞「工具未注册」白花一步。

### `request_help` 不能下放给子 agent

子 agent 的输出只回给主 agent,**用户看不到它说的话** ——
它调 `request_help` 等于打扰了用户却没人告诉用户要做什么,
而它已经带着未完成的答案返回了。

两侧提示都要写明:子 agent 侧说「你无法与用户交互」,
否则它会写「请用户登录后重试」然后等一个永远不会来的回复;
主 agent 侧说「子 agent 没有这个能力,收到这类回答由你 `request_help`」,
否则它会把「需要登录」当成任务失败。

按**名字**排除而非按 `needs` —— `request_help` 的 `needs` 是空数组
(它不碰任何执行器),没有可依赖的结构特征。这是唯一按名字排除的工具。

### 隐藏工具的时机:必须在工具桥启动成功之后

桥起不来又隐藏了工具,模型就两条路都没有(清单里没有、代码里的函数也连不上)。

### 模型拿到概括性输入后不会去核实

压缩那条实测:模型拿到概括性输入后会判定「已经足够明确」然后照着复述、
不去核实。这是「模型没有维护记忆的工具」那条决策的依据 ——
一条错的特征长得和对的一样权威,而它**每轮**都在注入。

---

## 九、性能观察

### 首字延迟的大头是思维链,不是网络

读 `_stream_timing` 实测:**5.79 秒的地板**,不是网络抖动。
关掉思考过程能砍掉等待时间的一半以上,代价是回答质量。

### prompt cache 命中率 60~77%

系统提示是缓存前缀里最稳定的部分。这是「技能索引进系统提示、正文由工具按需取」
那条决策的量化依据 —— 每轮注入不同正文会让整段前缀失效。

### 打包入口也要处理 `ELECTRON_RUN_AS_NODE`

开发期 `npm run app` 走 `electron/launch.cjs`,能先删掉这个环境变量再启动
Electron。但打包后的 exe 直接由 Electron 加载 `package.json.main`:
如果它从 IDE/插件环境继承了 `ELECTRON_RUN_AS_NODE=1`,主进程第一行
`require('electron').app` 就是 undefined,`main.cjs` 根本来不及自救。

所以 packaged 入口要先经过一个极薄的 `boot.cjs`:发现 `app` 不存在时,
用删掉该环境变量的 env 重启同一个 `process.execPath`;正常桌面模式才进入
真正的 `main.cjs`。

### 打包后运行时目录不能跟 `process.cwd()`

开发期把 `traces`、`.agent-memory.db`、`.sandbox-venv`、`.browser-profile`
放项目根很顺手;打包后 cwd 可能是安装目录、快捷方式启动目录或解压目录。
这些地方不一定可写,也不该作为用户数据归属。

Electron app 入口要把默认运行时目录覆盖到 `app.getPath('userData')`:
配置、trace、记忆/技能库、venv、浏览器 profile 都应跟用户走,不跟安装包走。
覆盖时要做分段深合并;配置面板只写 `python.enabled` 这类开关,如果整段浅覆盖,
会把 `browserProfileDir` / `venvDir` 这类默认路径悄悄抹掉。

### 浏览器自愈不只是重启进程

用户手动关掉常驻浏览器后,`BrowserManager.ensureAlive()` 能重启 Chromium,
但重启会换 CDP 端口。只重启、不刷新 `BROWSER_CDP_URL`,模型代码仍会连旧端口,
表现成“框架已经恢复了,但 Python 还是连不上”。

所以浏览器判活要接在 Python 每次执行前,并把最新 CDP URL 动态注入子进程。
框架自己的 BrowserOps 也不能把 URL 写死在构造期;截图脚本应从
`os.environ["BROWSER_CDP_URL"]` 读取,吃到同一条动态刷新结果。

---

## 十、待补的坑(已知但还没修)

- **Python/Shell 子进程不响应中断信号**:点停止只中止 LLM 请求,
  正在跑的代码不会停(独立超时兜底)
- **跨轮任务的技能沉淀会碎片化**:判据是单轮的,一个任务分五轮做完时
  每轮各抽一次、每次只看到五分之一;而累计 15 步却一次都不触发单轮 8 步门槛
- **技能库在内存里整数组覆盖**:切会话时新旧两个 manager 各持一份快照,
  而 `dispose()` 不中止在飞的抽取 —— 旧的抽完落盘会用陈旧数组盖掉新条目
- **「重试注定无效」的失败没有区分**:预算不够导致的空内容会白重试三次
- **工具桥每次切会话都重建**
