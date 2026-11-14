
一个单文件 Worker：**每次请求实时抓取优选 IP → 评分挑节点 → 生成两份 Clash 订阅（Trojan / VLESS）**，同时它自己就是代理服务端。
面板带密码保护，支持「一键唤起 Clash 导入」和「复制订阅链接」。

- 文件：`_worker.js`（唯一文件，无依赖、无需构建）
- 面板：`https://<你的域名>/<密码>/`（默认密码 `cfnode2026`）
- 订阅：`/cfw`（Trojan，Clash for Windows / Verge 都支持）、`/cv`（VLESS，Verge / Mihomo）
  - 同义链接：`/trojan` 等价于 `/cfw`；`/vless` 等价于 `/cv`
- 诊断：`/<密码>/selftest`、`/<密码>/relay`、`/<密码>/lastcheck`、`/<密码>/diag?ip=1.2.3.4&port=443`
- 下载页：`/<密码>/download`（FlClash / Clash Meta / Verge）
- 版本：`v1.0.7`

---

## 0. 版本记录

**备份规则**（从 v1.0.0 起）：每版都放在 `版本/` 目录，命名为 `_worker-v<版本号>-<简介>.js`，同时存 `.zip` 与 `README-v<版本号>-<简介>.md`。

| 版本 | 简介 | 要点 |
|---|---|---|
| **v1.0.7** | 自动代理组新增「代理-地区」节点 | 生成配置时从免费池抽样，用 ip-api 批量反查国家，按 12 个地区（HK/TW/JP/SG/KR/CN/US/DE/GB/RU/NL/CA）各挑固定出口，并用真实 `CONNECT` 判活（中国节点测百度，其余测 gstatic），判活预算 3 秒；节点名带实测耗时；连接参数 `&mode=proxy&px=种类\|地址` 锁定出口，全挂才回落免费池。「代理-优化」和其余节点机制完全未改 |
| **v1.0.6b** | 「直连」改名「不使用节点」 | Meta 内核支持 `type: direct`，订阅里下发 `- name: 不使用节点`；老内核（CFW）仍用内置 `DIRECT` |
| **v1.0.6** | 瘦身 | 删掉 10 个已被替代的函数（`crc32`、`md5`、`connectTarget`、`buildRelayNodes` 等），体积 126,500 → 121,655 字节，行为不变 |
| **v1.0.5** | 404 仿真 | 未知路径返回与 nginx 默认页逐字节一致的 404，不再暴露 Worker 特征 |
| **v1.0.4** | 新增 FlClash 下载页 | 面板新增「下载客户端」入口；`/<密码>/download` 实时读取 GitHub 最新 release（API 限流时回退解析发布页 HTML），按 Windows/macOS/Linux/Android 分组；`/<密码>/dl?u=<下载地址>` 由 Worker 中转下载（带域名白名单） |
| **v1.0.3** | 修复配置报错 | 移除顶层 `global-client-fingerprint`（新版 Mihomo 已删除该项），改为在 Meta 内核的每个节点上写 `client-fingerprint: chrome`；老内核（CFW）不下发该字段 |
| **v1.0.1** | 修复延迟检测连接被提前关闭 | 健康检查 204 去掉 `Connection: close`；同一条隧道内连续请求持续就地应答 204；关闭延时改为滚动延长（修复 FlClash/Mihomo 报 `failed to get the second response ... closed pipe`） |
| **v1.0.0** | 三组分流 + 全节点入选择 | 两组订阅；分组 🚀 节点选择 / 🔀 自动中转 / 🚀 自动直连 / 🛡 自动代理；中转按地区绑定（`&mode=relay&rg=XX`）；粘性 10 分钟 |

---

## 1. 它能做什么

| 能力 | 说明 |
|---|---|
| 免费节点来源 | 读取 `url.txt` 指向的项目（默认 `xgonce/Cloudflare_IP` 的 `result.csv`：IP / 端口 / 带宽 / 延迟 / 地区），每次请求重新拉取，不做缓存（上游挂了才退回上一次成功的数据） |
| 选点策略 | 评分 = 带宽 50% + 延迟 50%；同一地区只保留评分最高的 `PER_REGION`（默认 2）个，整个订阅最多 `MAX_NODES`（160）个 |
| 本机入口节点 | 直接用部署域名连（Cloudflare 把你带到最近的边缘节点），不依赖第三方优选 IP；面板里叫 `🇨🇳 本机优化`，订阅里以 `中转-优化 / 直连-优化 / 代理-优化` 出现 |
| 代理-地区节点 | v1.0.7 新增：跑固定出口的免费代理，节点名带国家；连接时锁定那一台，全挂自动回落 |
| 访问推特 | 目标落在 Cloudflare 网段时（x.com / twitter.com），自动改走 proxyip 中转 |
| 延迟检测 | 客户端的 `generate_204` 由 Worker 就地应答 204，不连上游，测出来就是纯 RTT |
| 客户端信息 | `subscription-userinfo`：已用 114 T / 总量 514 T、到期 24 小时（滚动）；`profile-update-interval`：6 小时自动更新 |
| 订阅延迟 | `unified-delay` 默认开启（`?unified=0` 关闭）；Meta 内核会扣掉握手时间，显示更接近真实体验 |
| 排障 | `/selftest` 返回 JSON：流构造器是否可用、能不能用 `connect()` 出网 |

---

## 1.5 分组与节点

只有 **两个订阅链接**：`/cfw`（Trojan）和 `/cv`（VLESS）。两份内容完全一致，只是协议不同。
**CFW 不支持 VLESS，只能用 `/cfw`。**

| 分组 | 类型 | 含义 |
|---|---|---|
| **🚀 节点选择** | select | 手选总入口：先列三个自动组 + `不使用节点`，然后列出全部节点 |
| **🔀 自动中转** | url-test | 普通站点直连；CF 托管站点（x.com 等）走 proxyip 中转 |
| **🚀 自动直连** | url-test | 全部直连，不中转、不走代理池（CF 托管站点会失败，这是设计如此） |
| **🛡 自动代理** | url-test | 全部走公共代理池（含 5 个 `代理-优化` + 若干 `代理-地区`） |

四个组都是 `url-test`（`🚀 节点选择` 除外），测速地址 `http://www.gstatic.com/generate_204`，间隔 300 秒，容差 50ms。
老内核用内置 `DIRECT`，Meta 内核多一个 `不使用节点`（`type: direct`）。

**节点构成**（一次生成的实际结果，共约 65 个）：

```
🔀 中转-优化 1 … 5             ← 本机域名（443 / 8443 / 2053 / 2083 / 8080 各一个）
🚀 直连-优化 1 … 5             ← 同上，直连
🛡 代理-优化 1 … 5             ← 同上，走代理池
🇺🇸 中转-美国 1 / 2 …          ← 地区优选 IP，每区最多 2 个，带地区绑定（&mode=relay&rg=US）
🇺🇸 直连-美国 1 / 2 …          ← 同上，直连
🇭🇰 代理-香港 1·303ms          ← 固定出口的免费代理，名字里是生成配置时的实测耗时
🇨🇳 代理-中国 4                ← 中国节点用百度判活
```

- `代理-地区` 最多 12 个（HK / TW / JP / SG / KR / CN / US / DE / GB / RU / NL / CA），每次生成能覆盖到哪几个国家不固定。
- 名字里**没有** `·xxxms` 表示这个国家这次没抽到能判活的代理，连接时会并发试几条，全失败才回落到免费池，不影响上网。
- 面板上的 `🇨🇳 本机优化`（6 个端口）和 `0️⃣ visa优化`（13 个域名）只是**面板展示用**，不进订阅。

**地区对应**：`中转-美国 1` 的入口是美国优选 IP，节点路径带 `&mode=relay&rg=US`。

**粘性**（保证出站 IP 稳定）：

- 中转：某地区首次成功的 IP 记入 `relaySticky`，10 分钟内复用；首字节 1.5 秒不回则记入 `relayDead`（10 分钟不再试）。
- 代理池：成功的代理记 10 分钟（`premiumGood` / `httpProxyCache.good`）。
- 状态查看：`/<密码>/relay`。

**已知限制**：免费中转成功率约 5~7 成；失败会降级（降级到任意中转，仍失败则该连接报错）。要稳定需换成自己的中转 IP。

---

## 1.6 客户端下载页（独立页面）

面板里只有一个入口「下载客户端」，下载相关页面全部独立：

| 地址 | 内容 |
|---|---|
| `/<密码>/download` | 下载索引：FlClash / Clash Meta for Android / Clash Verge Rev |
| `/<密码>/download/flclash` | FlClash 安装包（`chen08209/FlClash`） |
| `/<密码>/download/meta` | Clash Meta for Android（`MetaCubeX/ClashMetaForAndroid`） |
| `/<密码>/download/verge` | Clash Verge Rev（`clash-verge-rev/clash-verge-rev`） |
| `/<密码>/dl?u=<编码后的 GitHub 下载地址>` | Worker 中转下载，只允许上面三个仓库的 release 资源 |

实现要点：

- **统一外壳**：面板与全部下载页共用 `pageShell()`（同一 `PAGE_CSS`、同一 `<header>` 结构），没有重复 HTML；
- **体积来源**：优先 GitHub API 的精确字节数；API 被限流（403）时回退解析发布页 HTML，仍拿不到就用 `HEAD` 请求读 `content-length`；
- **过滤**：只保留安装包（apk/exe/msi/zip/dmg/pkg/deb/rpm/AppImage/tar.gz），自动剔除 `.sig`、`.blockmap`、`.json`、updater 配置等；
- **缓存**：每个客户端的 release 信息缓存 10 分钟；
- **返回按钮**：每个下载页左上角都有「← 返回面板」，并可一键跳到另外两个客户端。

---

## 2. 网页版部署（全程点鼠标，不用命令行）

### 方式 A：部署成 Worker（推荐）

1. 登录 Cloudflare Dashboard → 左侧 **Workers & Pages** → **Create** → **Workers** → **Create Worker**。
2. 名字随便起（例如 `cfnode`）→ **Deploy**。
3. 点 **Edit code**（编辑代码）→ 把本目录 `_worker.js` 的内容**全选替换**进去 → 右上角 **Deploy**。
4. （可选）**Settings → Variables and Secrets** 添加变量 `uuid`，值填你自己的 UUID；不加就用代码里的默认值。
5. 绑定域名，二选一：
   - 有自己托管在 CF 的域名：**Settings → Domains & Routes → Add → Custom Domain**，填 `cfn.你的域名.com`，等证书生效（约 1 分钟）。
   - 没有域名：直接用 `https://<脚本名>.<你的 workers 子域>.workers.dev`。
     ⚠️ `*.workers.dev` 在国内常被 DNS 污染，能用域名就用域名。
6. 打开 `https://<你的域名>/<密码>/`，能看到面板就成功了。

### 方式 B：部署成 Pages（上传 zip）

1. **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
2. 项目名随便起（例如 `cf-proxy`）→ 把含 `_worker.js` 的 zip（**文件在压缩包根目录**）拖进去 → **Deploy**。
3. 打开 `https://<项目名>.pages.dev/<密码>/`。

> Pages 与 Worker 的差别：Pages 后台只能设「兼容日期」，没有 `compatibility_flags` 开关。
> 本文件已经**不依赖** `streams_enable_constructors` 这类标记，两种方式都能跑；
> 如果 Pages 那边出现 522 / 全超时，直接改用方式 A（Worker）。

### 部署后必看的三处

| 位置 | 期望 |
|---|---|
| 面板右上角 | 版本号 `v1.0.7` |
| 面板「地区」区块 | 每个地区 2 个节点，能看到延迟 / 带宽 / 评分 |
| `https://<域名>/<密码>/selftest` | `"ok": true`，且 `tcp www.baidu.com:80` 是 `ok ... 「HTTP/1.1 200 OK」` |

---

## 3. 客户端怎么用

### Clash for Windows（CFW）

1. **Profiles** → 顶部输入框粘贴订阅地址 → **Download**：
   - 只能用 Trojan：`https://<域名>/<密码>/cfw`
2. 节点列表里先选 **`🛡 自动代理`** 或 **`🔀 自动中转`**，再在 `🚀 节点选择` 里手挑具体节点。
3. 延迟测试走 `generate_204`，由 Worker 就地回 204，数字接近你到 Cloudflare 边缘的 RTT（国内常见 30–200ms）。

### Clash Verge / Mihomo / FlClash

订阅用 `https://<域名>/<密码>/cv`（VLESS）。Verge 也支持 `/cfw`（Trojan），两条都能用。

> 如果 Verge 里测延迟显示不出来：把测速地址改成 `http://www.gstatic.com/generate_204`（本配置默认就是这个）。

### 分组说明

| 分组 | 类型 | 内容 |
|---|---|---|
| `🚀 节点选择` | select | 手选总入口：三个自动组 + `不使用节点` + 全部节点 |
| `🔀 自动中转` | url-test | 全部中转节点（5 个优化 + 各地区） |
| `🚀 自动直连` | url-test | 全部直连节点 |
| `🛡 自动代理` | url-test | 全部代理节点（5 个 `代理-优化` + 0~12 个 `代理-地区`） |

没有国家分组、没有单独的 `自动优化线路` 组：地区节点直接在这三个组里按延迟竞争。

### 为什么显示的延迟比实际高

客户端测一次延迟要走：TCP 握手 + TLS 握手 + WS Upgrade + HTTP 请求，等于 **4 个 RTT**；实际浏览一个页面只多 **1 个 RTT**。
本版默认下发 `unified-delay: true`（Meta 内核会把这部分扣掉）；老内核（CFW）不支持，看到的就是 4 倍数字，属正常。

---

## 4. 常见问题（都是实战踩过的）

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板能打开，但节点全部「超时」 | ① 客户端缓存了旧订阅；② 健康检查没收到 `204`（Trojan 必须真的写回 HTTP 字节）；③ 目标域名解析失败 | 更新订阅；换 `/cfw` 再试；看第 3 条 DNS |
| 日志 `all DNS requests failed ... dns.cloudflare.com` | 配置里的境外 DoH 兜底在国内超时，节点域名解析不出来 | 本版已去掉境外 DoH，并把节点域名写进 `fake-ip-filter`；**务必更新订阅** |
| 节点连不上，ALPN 相关报错 | 客户端声明 ALPN `h2` 时 Cloudflare 选 h2，WebSocket `Upgrade` 永远等不到 `101` | 本版每个节点都带 `alpn: [http/1.1]`；更新订阅即可 |
| `522` / `1101`，改代码也没用 | 脚本进入冻结态（上传时带了不兼容的兼容标记，或代码与绑定分两次提交） | 删掉脚本重新创建，一次性上传 |
| `workers.dev` 打开失败 | 该域名在国内被 DNS 污染（会解析到 157.240.x.x） | 绑自有域名 |
| x.com / twitter.com 打不开 | 这两个站是 Cloudflare 托管，Worker 的 `connect()` 不允许直连 CF 的 IP | 本版会自动改走 proxyip（`PROXYIPS` 内置候选）；普通站点不受影响。内置 proxyip 全是第三方公共中转，失效属常态 |
| `代理-地区` 某个国家一直失败 | 免费代理随时会死，判活只代表生成那一刻能连上 | 换同国另一条，或直接用 `代理-优化` / `🔀 自动中转` |
| `代理-地区` 名字后面没有 `·xxxms` | 这个国家这次一条都没判活，保留的是未验证候选 | 正常现象；连接时会并发抢，全挂回落免费池 |
| 更新时间/流量显示异常 | `subscription-userinfo` 是写给客户端看的展示字段 | 不影响使用；每次刷新都会顺延 |
| 面板打开要等 4–6 秒 | 生成订阅时要先抽样 + 判活 12 个国家的代理 | 正常；判活总预算已压到 3 秒 |
| Pages 部署报 `8000119 blocked` | Cloudflare 判定该项目被封锁（与代码无关） | 新建一个 Pages 项目重新部署，或改用 Worker |

---

## 5. 配置项（`_worker.js` 顶部「配置」区）

| 常量 | 默认 | 作用 |
|---|---|---|
| `PASSWORD` | `cfnode2026` | 面板与订阅路径的密码 |
| `UUID` / `TROJAN_PASSWORD` | 内置 | VLESS 的 UUID / Trojan 口令 |
| `NODE_SOURCES` | `https://github.com/xgonce/Cloudflare_IP` | 节点数据源；支持仓库地址、raw/CSV 直链、`ip:port` 文本 |
| `PER_REGION` | `2` | 每个地区保留几个 |
| `MAX_NODES` | `160` | 订阅最多几个节点 |
| `WS_PATH` | `/?ed=2560` | WebSocket 路径 |
| `INCLUDE_HOST_NODES` / `HOST_PORTS` / `HOST_PORTS_PLAIN` | `true` / `[443,8443,2053,2083]` / `[80,8080]` | 面板「🇨🇳 本机优化」区块；同时决定订阅里优化节点用哪几个端口 |
| `INCLUDE_VISA_NODES` / `VISA_NODES` | `true` / 13 条 | 面板「0️⃣ visa优化」区块（旧项目的 visa 优选域名），不进订阅 |
| `PROXYIPS` | 5 个候选 | 访问 CF 托管站点时的中转 |
| `TARGET_LATENCY_MIN/MAX` | `100` / `200` | 指定延迟带（当前订阅不再插入 `🎯` 节点，保留给 `/diag` 参考） |
| `PREMIUM_COUNTRIES` / `PREMIUM_LIMIT` | 12 个地区 / `12` | 生成哪几个国家的 `代理-地区` 节点、最多几个 |
| `PREMIUM_SAMPLE` | `400` | 每次从免费池抽多少个 IP 去反查国家 |
| `PREMIUM_VERIFY_BUDGET` / `PREMIUM_PROBE_TIMEOUT` | `3000` / `1200` | 判活总预算与单条超时（毫秒） |
| `PREMIUM_TTL` / `PREMIUM_DEAD_TTL` | 30 分钟 / 10 分钟 | 代理池缓存有效期 / 坏代理冷却时间 |
| `UPDATE_INTERVAL_HOURS` | `6` | 下发给客户端的订阅更新间隔 |
| `TRAFFIC_USED_BYTES` / `TRAFFIC_TOTAL_BYTES` / `EXPIRE_SECONDS` | 114 T / 514 T / 24h | 客户端显示的流量与到期 |
| `PAGE_VERSION` | `v1.0.7` | 面板右上角版本号 |

---

## 6. 目录

```
Release/
├── README.md      ← 本文件
├── _worker.js     ← 直接上传/粘贴这一个文件
└── _worker.zip    ← 需要走 Pages 上传时用（zip 根目录就是 _worker.js）
```

## 7. 说明

- 节点 IP 来自第三方扫描结果，可用性随时间变化，属于正常现象。
- Worker 免费额度：每天 10 万请求，本方案（订阅 + 代理）足够日常使用。
- 仅用于自用与学习，请遵守当地法律法规与 Cloudflare 服务条款。
