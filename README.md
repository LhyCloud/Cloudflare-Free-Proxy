<div align="center">

<img src="assets/icon.svg" alt="Cloudflare 免费代理" width="128">

# Cloudflare Free Proxy

单文件 Cloudflare Worker：实时抓优选 IP、评分挑节点，生成 Trojan / VLESS 两份 Clash 订阅，它自己就是代理服务端。

[![Release](https://img.shields.io/github/v/release/LhyCloud/Cloudflare-Free-Proxy?style=flat-square&label=release)](https://github.com/LhyCloud/Cloudflare-Free-Proxy/releases/latest) [![Downloads](https://img.shields.io/github/downloads/LhyCloud/Cloudflare-Free-Proxy/total?style=flat-square&logo=github)](https://github.com/LhyCloud/Cloudflare-Free-Proxy/releases)

[![Single file](https://img.shields.io/badge/single%20file-_worker.js-F6821F?style=flat-square)](_worker.js) [![Protocol](https://img.shields.io/badge/protocol-Trojan%20%2B%20VLESS-2f6feb?style=flat-square)](#订阅与分组) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-FAAF40?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

[功能](#功能) · [部署](#部署) · [订阅与分组](#订阅与分组) · [客户端用法](#客户端用法) · [下载页](#下载页) · [常见问题](#常见问题) · [配置项](#配置项) · [版本记录](#版本记录) · [目录](#目录) · [数据源](#数据源)

</div>

> [!WARNING]
> **若所在国家不允许使用代理服务，请勿下载和部署该项目！**
> 本项目仅用于个人学习与技术研究，不提供任何服务保证；节点与代理均来自第三方公开仓库，非本项目所有。使用者请自行确认当地法律法规，一切后果由使用者自行承担。
> 
<!-- 面板截图（真实 PNG 待补，先把位置留好；补好后取消下面注释即可）
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot-dark.png">
    <img alt="面板截图：订阅链接与代理组" src="assets/screenshot.png" width="92%">
  </picture>
</p>
-->

## 功能

- **一个文件就是全部**：`_worker.js` 既是配置生成器，也是代理服务端；无依赖、无需构建、无需数据库（不占 KV）。
- **每次请求实时抓节点**：读取上游 `result.csv`（IP / 端口 / 带宽 / 延迟 / 地区），按「带宽 50% + 延迟 50%」评分，同一地区只留前 `PER_REGION`（默认 2）个，整份订阅最多 `MAX_NODES`（160）个。
- **两份订阅，同一套节点**：`/cfw`（Trojan，CFW 用）与 `/cv`（VLESS，Verge / FlClash / Mihomo 用），内容一致、协议不同。**CFW 不支持 VLESS。**
- **三类出站**：`🔀 自动中转`（CF 托管站点自动换中转）、`🚀 自动直连`、`🛡 自动代理`（走公共代理池），全部 `url-test`，按延迟自动挑。
- **代理-地区节点**：从免费池抽样、批量反查国家，按 12 个地区各挑一个固定出口，节点名直接带地区与实测耗时；连接时锁定那一台，全挂才回落。
- **延迟检测就地应答**：客户端的 `generate_204` 由 Worker 直接回 `204`，不连上游，测出来就是纯链路 RTT。
- **面板带密码**：`/<密码>/` 一键唤起 Clash 导入、复制订阅、看每个地区的延迟与带宽，另有下载页与排障页。
- **客户端展示**：`subscription-userinfo` 显示已用 114 T / 总量 514 T、到期 24 小时（滚动）；`profile-update-interval` 6 小时自动更新。

## 部署

### 方式 A：Worker（推荐）

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Create Worker**。
2. 名字随便起（例如 `cfnode`）→ **Deploy**。
3. 点 **Edit code** → 把 `_worker.js` 的内容全选替换进去 → **Deploy**。
4. （可选）**Settings → Variables and Secrets** 加变量 `uuid`，值填你自己的 UUID；不加就用内置值。
5. 绑定域名（二选一）：
   - 有自己的域名托管在 CF：**Settings → Domains & Routes → Add → Custom Domain**，填 `cfn.你的域名.com`，等证书生效（约 1 分钟）。
   - 没有域名：直接用 `https://<脚本名>.<你的 workers 子域>.workers.dev`。
     ⚠️ `*.workers.dev` 在国内常被 DNS 污染，能绑域名就绑域名。
6. 打开 `https://<你的域名>/<密码>/`，看到面板即成功。

### 方式 B：Pages（上传 zip）

1. **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 项目名随便起（例如 `cf-proxy`）→ 把 `_worker.zip` 拖进去（**压缩包根目录就是 `_worker.js`**）→ **Deploy**。
3. 打开 `https://<项目名>.pages.dev/<密码>/`。

> Pages 与 Worker 的差别：Pages 后台只能设兼容日期，没有 `compatibility_flags` 开关。
> 本文件**不依赖** `streams_enable_constructors` 这类标记，两种方式都能跑；若 Pages 出现 522 / 全超时，直接改用方式 A。

### 部署后必看

| 位置 | 期望 |
|---|---|
| 面板右上角 | 版本号 `v1.0.7` |
| 面板「地区」区块 | 每个地区 2 个节点，能看到延迟 / 带宽 / 评分 |
| `https://<域名>/<密码>/selftest` | `"ok": true`，且 `tcp www.baidu.com:80` 是 `ok ... 「HTTP/1.1 200 OK」` |

## 订阅与分组

只有 **两个订阅链接**，固定密码路径之后：

| 链接 | 协议 | 适用客户端 |
|---|---|---|
| `/cfw` | Trojan | Clash for Windows（**CFW 不支持 VLESS，只能用这个**）、Verge 也支持 |
| `/cv` | VLESS | Clash Verge Rev / Mihomo / FlClash / Stash |

同义链接：`/trojan` 等价 `/cfw`；`/vless` 等价 `/cv`。

| 分组 | 类型 | 含义 |
|---|---|---|
| **🚀 节点选择** | select | 手选总入口：三个自动组 + `不使用节点` + 全部节点 |
| **🔀 自动中转** | url-test | 普通站点直连；CF 托管站点（x.com 等）自动走中转 |
| **🚀 自动直连** | url-test | 全部直连，不中转、不走代理池（CF 托管站点会失败，设计如此） |
| **🛡 自动代理** | url-test | 全部走公共代理池（5 个 `代理-优化` + 若干 `代理-地区`） |

三个自动组统一测速 `http://www.gstatic.com/generate_204`，间隔 300 秒，容差 50 ms。

### 三个分组怎么上网

```text
🔀 自动中转   你 ─► CF 边缘 ─► Worker ─┬─► 普通站点：直接连目标
                                       └─► x.com 等 CF 托管站点：先连公共中转机 ─► CF ─► 目标

🚀 自动直连   你 ─► CF 边缘 ─► Worker ──► 目标        （不中转、不走代理池，x.com 打不开）

🛡 自动代理   你 ─► CF 边缘 ─► Worker ──► 公共代理（HTTP CONNECT / SOCKS5）──► 目标
```

| 分组 | 目标看到的 IP | 什么时候用 |
|---|---|---|
| **🔀 自动中转** | 普通站点是 Cloudflare 出口；x.com 等是那台公共中转机的 IP | 默认首选，**唯一能开推特的组** |
| **🚀 自动直连** | Cloudflare 出口，链路最短 | 只上普通站点、追求最低延迟 |
| **🛡 自动代理** | 抽到的那台免费代理的 IP | 目标站点屏蔽 Cloudflare 网段时 |

- `🛡 代理-优化 1…5`：每次连接从免费池随机抽 4 条 HTTP + 4 条 SOCKS5 抢，赢的记 10 分钟。
- `🛡 代理-地区…`：**钉死一台**——连接参数里带 `&mode=proxy&px=…`，只连那台，全挂才回落随机池。
- 代理路径的出站 IP 跟着代理走，所以同一分组里不同节点的 IP 归属地会跳，属正常。

老内核用内置 `DIRECT`，Meta 内核多一个 `不使用节点`（`type: direct`）。**没有国家分组**：地区节点直接在三个组里按延迟竞争。

**节点构成**（一次生成的实际结果，约 65 个）：

```text
🔀 中转-优化 1 … 5      ← 本机域名（443 / 8443 / 2053 / 2083 / 8080 各一个）
🚀 直连-优化 1 … 5      ← 同上，直连
🛡 代理-优化 1 … 5      ← 同上，走代理池
🇺🇸 中转-美国 1 / 2 …   ← 地区优选 IP，每区最多 2 个（&mode=relay&rg=US）
🇺🇸 直连-美国 1 / 2 …   ← 同上，直连
🇭🇰 代理-香港 1·303ms   ← 固定出口的免费代理，名字里是生成时的实测耗时
🇨🇳 代理-中国 4         ← 中国节点用百度判活
```

- `代理-地区` 最多 12 个（HK / TW / JP / SG / KR / CN / US / DE / GB / RU / NL / CA），每次生成能覆盖到哪几个国家不固定。
- 名字里**没有** `·xxxms` 表示这次没抽到能判活的代理；连接时会并发试几条，全失败回落免费池，不影响上网。
- 面板上的 `🇨🇳 本机优化`（6 个端口）和 `0️⃣ visa优化`（13 个域名）只是**面板展示用**，不进订阅。

**粘性**（保证出站 IP 稳定）：

- 中转：某地区首次成功的 IP 记入 `relaySticky`，10 分钟内复用；首字节 1.5 秒不回则记入 `relayDead`（10 分钟不再试）。
- 代理：成功的代理记 10 分钟（`premiumGood` / `httpProxyCache.good`）。
- 状态查看：`/<密码>/relay`。

**已知限制**：免费中转成功率约 5~7 成，失败会降级（降到任意中转，仍失败则该连接报错）；要稳定请换成自己的中转 IP。

## 客户端用法

### Clash for Windows（CFW）

1. **Profiles** → 输入框粘贴 `https://<域名>/<密码>/cfw` → **Download**（CFW 只认 Trojan）。
2. 节点列表先选 **`🛡 自动代理`** 或 **`🔀 自动中转`**，再到 `🚀 节点选择` 里手挑具体节点。
3. 延迟测试走 `generate_204`，由 Worker 就地回 204，数字接近你到 Cloudflare 边缘的 RTT（国内常见 30–200 ms）。

### Clash Verge / Mihomo / FlClash

订阅用 `https://<域名>/<密码>/cv`（VLESS）；Verge 也支持 `/cfw`（Trojan），两条都能用。

> Verge 里测延迟显示不出来时：把测速地址改成 `http://www.gstatic.com/generate_204`（本配置默认就是它）。

### 为什么显示的延迟比实际高

客户端测一次延迟要走 TCP 握手 + TLS 握手 + WS Upgrade + HTTP 请求，等于 **4 个 RTT**；实际浏览一个页面只多 **1 个 RTT**。
本版默认下发 `unified-delay: true`（`?unified=0` 关闭），Meta 内核会把这段扣掉；老内核（CFW）不支持，看到的就是 4 倍数字，属正常。

## 下载页

面板里只有一个入口「下载客户端」，相关页面全部独立：

| 地址 | 内容 |
|---|---|
| `/<密码>/download` | 下载索引：FlClash / Clash Meta for Android / Clash Verge Rev |
| `/<密码>/download/flclash` | FlClash（`chen08209/FlClash`） |
| `/<密码>/download/meta` | Clash Meta for Android（`MetaCubeX/ClashMetaForAndroid`） |
| `/<密码>/download/verge` | Clash Verge Rev（`clash-verge-rev/clash-verge-rev`） |
| `/<密码>/dl?u=<编码后的下载地址>` | Worker 中转下载，只放行上面三个仓库的 release 资源 |

实现要点：全部页面共用 `pageShell()`（同一套 CSS 与 `<header>`）；体积优先取 GitHub API，被限流（403）时回退解析发布页 HTML，再不济用 `HEAD` 读 `content-length`；每个客户端的 release 信息缓存 10 分钟。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板能开，节点全部「超时」 | ① 客户端缓存了旧订阅；② 健康检查没收到 `204`（Trojan 必须真写回 HTTP 字节）；③ 目标域名解析失败 | 更新订阅；换 `/cfw` 再试；查 DNS 一条 |
| 日志 `all DNS requests failed ... dns.cloudflare.com` | 配置里的境外 DoH 在国内超时，节点域名解析不出来 | 本版已去掉境外 DoH 并把节点域名写进 `fake-ip-filter`；**务必更新订阅** |
| 节点连不上，ALPN 报错 | 客户端声明 ALPN `h2` 时 CF 选 h2，WebSocket `Upgrade` 永远等不到 `101` | 每个节点都带 `alpn: [http/1.1]`；更新订阅即可 |
| `522` / `1101`，改代码也没用 | 脚本进入冻结态（上传时带不兼容的兼容标记，或代码与绑定分两次提交） | 删掉脚本重新创建，一次性上传 |
| `workers.dev` 打不开 | 该域名在国内被 DNS 污染（会解析到 157.240.x.x） | 绑自有域名 |
| x.com / twitter.com 打不开 | 这两站由 Cloudflare 托管，Worker 的 `connect()` 不允许直连 CF 的 IP | 用 `🔀 中转-*` 节点（`mode=relay`）：目标落在 CF 网段时自动走公共 proxyip；`🚀 直连-*` 按设计打不开这两站，`🛡 代理-*` 走公共代理 |
| `代理-地区` 某国一直失败 | 免费代理随时会死，判活只代表生成那一刻能连 | 换同国另一条，或直接用 `代理-优化` / `🔀 自动中转` |
| `代理-地区` 名字后没有 `·xxxms` | 这个国家这次一条都没判活，保留的是未验证候选 | 正常现象；连接时并发抢，全挂回落免费池 |
| 更新时间 / 流量显示异常 | `subscription-userinfo` 只是写给客户端看的展示字段 | 不影响使用；每次刷新都会顺延 |
| 面板打开要 4–6 秒 | 生成订阅时要抽样 + 判活 12 个国家的代理 | 正常；判活总预算已压到 3 秒 |
| Pages 部署报 `8000119 blocked` | Cloudflare 判定该项目被封锁（与代码无关） | 新建一个 Pages 项目重新部署，或改用 Worker |

## 配置项

都在 `_worker.js` 顶部「配置」区，改完重新部署即可：

| 常量 | 默认 | 作用 |
|---|---|---|
| `PASSWORD` | `cfnode2026` | 面板与订阅路径的密码 |
| `UUID` / `TROJAN_PASSWORD` | 内置 | VLESS 的 UUID / Trojan 口令 |
| `NODE_SOURCES` | `xgonce/Cloudflare_IP` | 节点数据源；支持仓库地址、raw/CSV 直链、`ip:port` 文本 |
| `PER_REGION` / `MAX_NODES` | `2` / `160` | 每地区保留几个 / 订阅最多几个 |
| `WS_PATH` | `/?ed=2560` | WebSocket 路径 |
| `INCLUDE_HOST_NODES` / `HOST_PORTS` / `HOST_PORTS_PLAIN` | `true` / `[443,8443,2053,2083]` / `[80,8080]` | 面板「🇨🇳 本机优化」区块，同时决定优化节点用哪几个端口 |
| `INCLUDE_VISA_NODES` / `VISA_NODES` | `true` / 13 条 | 面板「0️⃣ visa优化」区块，不进订阅 |
| `TARGET_LATENCY_MIN` / `TARGET_LATENCY_MAX` | `100` / `200` | 指定延迟带，保留给 `/diag` 参考 |
| `PREMIUM_COUNTRIES` / `PREMIUM_LIMIT` | 12 个地区 / `12` | 生成哪几个国家的 `代理-地区` 节点、最多几个 |
| `PREMIUM_SAMPLE` | `400` | 每次从免费池抽多少个 IP 反查国家 |
| `PREMIUM_VERIFY_BUDGET` / `PREMIUM_PROBE_TIMEOUT` | `3000` / `1200` | 判活总预算 / 单条超时（毫秒） |
| `PREMIUM_TTL` / `PREMIUM_DEAD_TTL` | 30 分钟 / 10 分钟 | 代理池缓存有效期 / 坏代理冷却 |
| `UPDATE_INTERVAL_HOURS` | `6` | 下发给客户端的订阅更新间隔 |
| `TRAFFIC_USED_BYTES` / `TRAFFIC_TOTAL_BYTES` / `EXPIRE_SECONDS` | 114 T / 514 T / 24 h | 客户端显示的流量与到期 |
| `PAGE_VERSION` | `v1.0.7` | 面板右上角版本号 |

## 版本记录

| 版本 | 简介 | 要点 |
|---|---|---|
| **v1.0.7** | 新增「代理-地区」节点 | 从免费池抽样，用 ip-api 批量反查国家，按 12 个地区各挑固定出口，用真实 `CONNECT` 判活（中国节点测百度，其余测 gstatic），判活预算 3 秒；节点名带实测耗时；连接参数 `&mode=proxy&px=种类\|地址` 锁定出口，全挂才回落免费池。「代理-优化」和其余机制完全未改 |
| **v1.0.6b** | 「直连」改名「不使用节点」 | Meta 内核支持 `type: direct`，订阅里下发 `- name: 不使用节点`；老内核（CFW）仍用内置 `DIRECT` |
| **v1.0.6** | 瘦身 | 删掉 10 个已被替代的函数（`crc32`、`md5`、`connectTarget`、`buildRelayNodes` 等），体积 126,500 → 121,655 字节，行为不变 |
| **v1.0.5** | 404 仿真 | 未知路径返回与 nginx 默认页逐字节一致的 404，不再暴露 Worker 特征 |
| **v1.0.4** | 新增下载页 | 面板加「下载客户端」入口；`/<密码>/download` 实时读 GitHub 最新 release（API 限流时回退解析发布页），按平台分组；`/<密码>/dl?u=` 由 Worker 中转下载（带域名白名单） |
| **v1.0.3** | 修复配置报错 | 移除顶层 `global-client-fingerprint`（新版 Mihomo 已删该项），改为在 Meta 内核每个节点上写 `client-fingerprint: chrome`；老内核不下发 |
| **v1.0.1** | 修复延迟检测连接被提前关闭 | 健康检查 204 去掉 `Connection: close`；同一隧道内连续请求持续就地应答 204；关闭延时改为滚动延长（修 `failed to get the second response ... closed pipe`） |
| **v1.0.0** | 三组分流 + 全节点入选择 | 两组订阅；分组 🚀 节点选择 / 🔀 自动中转 / 🚀 自动直连 / 🛡 自动代理；中转按地区绑定（`&mode=relay&rg=XX`）；粘性 10 分钟 |

## 目录

```
Release/
├── README.md            ← 本文件
├── _worker.js           ← 直接粘贴/上传这一个文件
├── _worker.zip          ← 走 Pages 上传时用它（根目录即 _worker.js）
└── assets/
    ├── icon.png         ← 源图（Clash 小蓝猫官方 logo，512×512）
    ├── icon.svg         ← 矢量版（贝塞尔描迹，CF 橙渐变），README 顶部与面板 favicon 都用它
    ├── icon-blue.svg    ← 同一只猫的蓝色渐变版（Clash 原色，备选）
    ├── screenshot.png   ← 面板截图（浅色，待补）
    └── screenshot-dark.png ← 面板截图（深色，待补）
```

## 数据源

节点、中转与代理全部来自第三方公开仓库（本项目不生产节点）：

- 节点源：[xgonce/Cloudflare_IP](https://github.com/xgonce/Cloudflare_IP) —— 优选 IP 的 IP / 端口 / 带宽 / 延迟 / 地区
- 中转源：[CB-X2-Jun/cf-proxyip-lists](https://github.com/CB-X2-Jun/cf-proxyip-lists) —— 访问 x.com 等 CF 托管站点时的公共 proxyip
- 代理池：[monosans/proxy-list](https://github.com/monosans/proxy-list) —— `代理-地区` 节点与公共代理出口

节点可用性随时间变化属正常现象；Worker 免费额度每天 10 万请求，本方案（订阅 + 代理）足够日常自用。

本项目仅用于自用与学习，请遵守当地法律法规与 Cloudflare 服务条款。
