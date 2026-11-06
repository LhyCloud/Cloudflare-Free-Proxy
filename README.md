# Cloudflare 免费节点订阅（Trojan / VMess / VLESS 三类订阅）

一个单文件 Worker：**每次请求实时抓取优选 IP → 评分挑节点 → 生成三份 Clash 订阅**，同时它自己就是代理服务端。
面板带密码保护，支持「一键唤起 Clash 导入」和「复制订阅链接」。

- 文件：`_worker.js`（唯一文件，无依赖、无需构建）
- 面板：`https://<你的域名>/<密码>/`（默认密码 `cfnode2026`）
- 订阅：`/trojan`、`/vmess`、`/vless`（旧的 `/cfw` = vmess、`/cv` = vless 仍然可用）
- 版本：`V26.11.07`

---

## 1. 它能做什么

| 能力 | 说明 |
|---|---|
| 免费节点来源 | 读取 `url.txt` 指向的项目（默认 `xgonce/Cloudflare_IP` 的 `result.csv`：IP / 端口 / 带宽 / 延迟 / 地区），每次请求重新拉取，不做缓存 |
| 选点策略 | 带宽 + 延迟综合评分；每个地区保留评分最高的 4 个；额外固定一个 `🎯 100~200ms` 节点 |
| 三类订阅 | Trojan、VMess、VLESS 共用同一批节点，只是协议不同（CFW 不支持 VLESS，用前两种） |
| 自动优化线路 | 订阅里固定 `🇨🇳 自动优化线路·443/8443/2053/2083`：直接用部署域名连，Cloudflare 会把你带到最近的边缘节点，不依赖第三方优选 IP |
| 访问推特 | 目标落在 Cloudflare 网段时（x.com / twitter.com），自动改走 proxyip 中转 |
| 延迟检测 | Clash 的 `generate_204` 由 Worker 就地应答，不连上游，测出来就是纯 RTT |
| 客户端信息 | `subscription-userinfo`：已用 114 T / 总量 514 T、到期 24 小时（滚动）；`profile-update-interval`：6 小时自动更新 |
| 排障 | `/selftest` 返回 JSON：流构造器是否可用、能不能用 `connect()` 出网 |

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
| 面板右上角版本号 | `V26.11.07` |
| 面板底部两个区块 | `0️⃣ visa优化`（13 个）和 `🇨🇳 自动优化线路`（4 个） |
| `https://<域名>/<密码>/selftest` | `"ok": true`，且 `tcp www.baidu.com:80` 是 `ok ... 「HTTP/1.1 200 OK」` |

---

## 3. 客户端怎么用

### Clash for Windows（CFW）

1. **Profiles** → 顶部输入框粘贴订阅地址 → **Download**：
   - 首选 Trojan：`https://<域名>/<密码>/trojan`
   - 或 VMess：`https://<域名>/<密码>/vmess`
2. 节点列表里先选 **`⚡ 低延迟`**、**`🇨🇳 自动优化线路`** 或 **`0️⃣ visa优化`**。
3. 延迟测试走的是 `generate_204`，数字应该接近你到 Cloudflare 边缘的 RTT（国内常见 30–200ms）。

### Clash Verge / Mihomo

订阅用 `/vless`（VLESS）或 `/trojan`，导入后同样先看 `⚡ 低延迟` 组。

### 分组说明

| 分组 | 类型 | 内容 |
|---|---|---|
| `🚀 节点选择` | select | 手选总入口，含所有分组和所有节点 |
| `♻️ 自动选择` | url-test | **只含 IP 节点**（不含 visa / 自动优化线路这类域名节点） |
| `⚡ 低延迟` | url-test | IP 节点里延迟 ≤150ms 的那一批 |
| `🔁 自动优化` | url-test | **所有域名节点**：0️⃣ visa 13 个 + 🇨🇳 自动优化线路 4 个，共 17 个（原「自动优化线路」组已并入本组） |
| `⚖️ 负载均衡` | load-balance | 全部节点哈希负载 |
| `0️⃣ visa优化` | select | 旧项目的 13 个 visa 优选域名 |

国家分组已取消：地区节点（如 `🇺🇸 美国·西雅图 1`）直接在 `自动选择` / `⚡ 低延迟` / `节点选择` 里按延迟竞争。

### 地区节点为什么有的几百毫秒

订阅里按国家分组（`🇺🇸 美国`、`🇯🇵 日本`…），`🇧🇷 巴西`、`🇮🇳 印度`、`🇷🇺 俄罗斯` 这类远端地区本身数据里就是 180–220ms，再叠加一跳必然高，别拿它们当基准。

---

## 4. 常见问题（都是实战踩过的）

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板能打开，但节点全部「超时」 | ① 客户端缓存了旧订阅；② 健康检查没收到 `204`（Trojan 必须真的写回 HTTP 字节）；③ 目标域名解析失败 | 更新订阅；换 `/trojan`；看第 5 条 DNS |
| 日志 `all DNS requests failed ... dns.cloudflare.com` | 配置里的境外 DoH 兜底在国内超时，节点域名解析不出来 | 本版已去掉境外 DoH，并把节点域名写进 `fake-ip-filter`；**务必更新订阅** |
| 自动优化线路 443 连不上 | 客户端声明 ALPN `h2` 时，Cloudflare 选 h2，WebSocket `Upgrade` 永远等不到 `101` | 本版每个节点都带 `alpn: [http/1.1]`；更新订阅即可 |
| `522` / `1101`，改代码也没用 | 脚本进入冻结态（上传时带了不兼容的兼容标记，或代码与绑定分两次提交） | 删掉脚本重新创建，一次性上传 |
| `workers.dev` 打开失败 | 该域名在国内被 DNS 污染（会解析到 157.240.x.x） | 绑自有域名 |
| x.com / twitter.com 打不开 | 这两个站是 Cloudflare 托管，Worker 的 `connect()` 不允许直连 CF 的 IP | 本版会自动改走 proxyip（`PROXYIPS`，内置 5 个候选），普通站点不受影响 |
| 某个地区节点全部超时 | 第三方扫描出来的优选 IP 失效（抽样约 3/10 可用） | 换同地区另一个，或直接用 `🇨🇳 自动优化线路` / `0️⃣ visa优化` / `⚡ 低延迟` |
| 仪表盘显示流量 114 T / 到期 1 天 | 这是写给客户端看的展示字段 | 不影响使用；每次刷新都会顺延 |

---

## 5. 配置项（`_worker.js` 顶部「配置」区）

| 常量 | 默认 | 作用 |
|---|---|---|
| `PASSWORD` | `cfnode2026` | 面板与订阅路径的密码 |
| `UUID` | `e921a2ec-…` | VLESS / VMess 共用 UUID（可用环境变量 `uuid` 覆盖） |
| `TROJAN_PASSWORD` | `cfnode-trojan-2026` | Trojan 口令 |
| `NODE_SOURCES` | `https://github.com/xgonce/Cloudflare_IP` | 节点数据源；支持仓库地址、raw/CSV 直链、`ip:port` 文本 |
| `PER_REGION` | `4` | 每个地区保留几个 |
| `MAX_NODES` | `160` | 订阅最多几个节点 |
| `WS_PATH` | `/?ed=2560` | WebSocket 路径 |
| `INCLUDE_HOST_NODES` / `HOST_PORTS` | `true` / `[443,8443,2053,2083]` | 是否附带「🇨🇳 自动优化线路」节点及其端口 |
| `INCLUDE_VISA_NODES` / `VISA_NODES` | `true` / 13 条 | 旧项目里的 visa 优选域名（0 号节点） |
| `PROXYIPS` | 5 个候选 | 访问 CF 托管站点时的中转 |
| `TARGET_LATENCY_MIN/MAX` | `100` / `200` | `🎯` 节点的延迟区间 |
| `UPDATE_INTERVAL_HOURS` | `6` | 下发给客户端的订阅更新间隔 |
| `TRAFFIC_USED_BYTES` / `TRAFFIC_TOTAL_BYTES` / `EXPIRE_SECONDS` | 114 T / 514 T / 24h | 客户端显示的流量与到期 |

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
