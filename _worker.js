/**
 * Cloudflare Pages · 单文件 Worker：免费节点订阅生成器（CFW / Clash Verge）
 * ---------------------------------------------------------------------------
 * 用途
 *   1. 每次请求都会重新读取 url.txt 里的项目（NODE_SOURCES），
 *      拉取其中的「免费节点」清单（result.csv：IP / 端口 / 带宽 / 延迟 / 地区）。
 *   2. 按「带宽大 + 延迟低」综合评分，每个地区只保留评分最高的 PER_REGION 个节点。
 *   3. 生成两份 Clash 订阅：
 *        /<密码>/trojan  →  Trojan（CFW / Verge 老内核都支持）
 *        /<密码>/cv   →  Clash Verge / Mihomo（VLESS + WS + TLS）
 *   4. 同一个 Worker 同时是代理服务端，VLESS / Trojan 共用 UUID，路径 /?ed=2560；
 *      路径加 &via=1 的节点为「全流量中转」节点（所有目标都走代理池）。
 *   5. 订阅响应带 subscription-userinfo：已用 114 T / 总量 514 T，到期 = 当前时间 + 1 天
 *      （客户端里的「流量 / 剩余时间」就来自这里，每次请求都会重新计算）。
 *
 * 路由
 *   /<密码>/          面板（打开 Clash 导入 / 复制订阅链接）
 *   /<密码>/cfw       Clash for Windows 订阅（YAML）
 *   /<密码>/cv        Clash Verge 订阅（YAML）
 *   其它路径一律 404，不暴露面板。
 *
 * 部署（Cloudflare Pages · 高级模式）
 *   把本文件命名为 _worker.js 放在 Pages 项目根目录（构建输出根目录）即可，
 *   不需要打包，也不需要 functions 目录。
 *
 * 兼容性（踩过的坑，别改回去）
 *   · 不使用 new ReadableStream({...}) / new WritableStream(...) / new TransformStream(...)，
 *     这些构造函数依赖 streams_enable_constructors 兼容标记，而 Pages 页面里没有这个开关，
 *     一旦缺失，WebSocket 建立数据流时就抛错 → 客户端表现为 502 / 连不上。
 *   · serverWS.accept() 之后强制 binaryType = 'arraybuffer'，并额外兼容 Blob，
 *     否则新兼容日期下 message 事件给的是 Blob，会被当成空数据 → 握手成功但一个字节都不通。
 *   · 因此本文件在 Pages（任意兼容日期）和 Workers 上都能直接用。
 *
 * 只需要改下面「配置」区：PASSWORD（密码）、UUID（节点密钥）、NODE_SOURCES（url.txt 项目）。
 */

import { connect } from 'cloudflare:sockets';

/* ==========================================================================
 * 配置
 * ========================================================================== */

// 面板 / 订阅路径里的密码：只有 /<PASSWORD>/... 能访问（写死在这里即可）
const PASSWORD = 'cfnode2026';

// VLESS / Trojan 共用的 UUID（可在 Pages 环境变量里用 uuid 覆盖）
const UUID = 'e921a2ec-2c5c-4987-a303-35984326d3d7';

// 节点数据源 = url.txt 里的项目地址（支持 GitHub 仓库、raw 地址、或任意 CSV/TXT 地址）
const NODE_SOURCES = ['https://github.com/xgonce/Cloudflare_IP'];

// 每个地区保留几个节点
const PER_REGION = 2;

// 生成的配置最多包含多少个节点
const MAX_NODES = 160;

// WebSocket 路径（与客户端配置一致）
const WS_PATH = '/?ed=2560';

// 可用于 TLS 的 Cloudflare 端口（不在列表里的端口按非 TLS 节点处理）
const TLS_PORTS = new Set([443, 8443, 2053, 2083, 2087, 2096]);

// 评分参数：带宽满分线（Mbps）、延迟满分线 / 归零线（ms）、可接受的最大延迟（ms）
const SPEED_BENCH = 100;
const LATENCY_FLOOR = 20;
const LATENCY_CEIL = 400;
const MAX_LATENCY = 600;

// 客户端自动更新订阅的间隔（小时），通过 profile-update-interval 响应头下发
const UPDATE_INTERVAL_HOURS = 6;

// 订阅信息：客户端里显示的「已用 / 总量 / 到期」
// 1 T = 1024^4 字节；到期时间每次请求都重新算，也就是永远显示「还有 1 天」
const TRAFFIC_USED_BYTES = 114 * 1024 ** 4;
const TRAFFIC_TOTAL_BYTES = 514 * 1024 ** 4;
const EXPIRE_SECONDS = 24 * 3600;

// Trojan 口令（与 VLESS 共用同一批优选 IP，只是协议不同）
const TROJAN_PASSWORD = 'cfnode-trojan-2026';

// 访问 x.com / twitter.com 这类「Cloudflare 托管站点」的中转（proxyip）。
// Worker 的 connect() 不允许直连 Cloudflare 自己的 IP（会报 Stream was cancelled），
// 所以先连到 proxyip，再把客户端原始字节（TLS ClientHello，SNI=目标域名）原样转发，
// 由它按 SNI 送进 CF 边缘 —— 这就是 deploy-guide 里 v4.4 用的那套办法。
// 候选 proxyip 的远端列表（第三方维护，可能失效；拉取失败就只用内置的）
const PROXYIP_SOURCES = [
  'https://raw.githubusercontent.com/cmliu/edgetunnel/main/ProxyIP.txt',
  'https://cdn.jsdelivr.net/gh/cmliu/edgetunnel@main/ProxyIP.txt',
  'https://raw.githubusercontent.com/cmliu/edgetunnel/main/ProxyIP.js',
];
const PROXYIP_TTL = 10 * 60 * 1000;
let proxyipCache = { list: [], at: 0 };

// 这 5 个曾经可用的公共 proxyip 已全部失效（实测 ENOTFOUND / RST），留空；
// 如果自己有 VPS 中转，按 'ip:port' 填进来，会优先于公共代理池使用。
const PROXYIPS = [];

// 订阅里保证至少有一个落在该延迟区间的节点（其余仍按评分挑）
const TARGET_LATENCY_MIN = 100;
const TARGET_LATENCY_MAX = 200;

// 单个数据源请求超时（ms）
const SOURCE_TIMEOUT = 12000;

// 额外附带「本机域名」节点：用部署域名直连，不经过扫描出来的优选 IP。
// 优选 IP 是第三方扫描结果，可能整批失效；留着这一组既能救急，也能用来判断
// 到底是「IP 不行」还是「Worker 本身不行」。
const INCLUDE_HOST_NODES = true;
const HOST_PORTS = [443, 8443, 2053, 2083];
// 明文端口：省掉 TLS 握手（Clash 每次测速都会重建连接，握手占大头）
const HOST_PORTS_PLAIN = [80, 8080];

// 0 号节点：沿用旧项目里的 visa 优选域名（域名:端口），标 0 号单独成组
const INCLUDE_VISA_NODES = true;

// 10 个「全流量中转」节点：路径带 ?via=1，Worker 会把该节点的所有连接都丢进代理池
// （普通节点只在目标被 CF 拒时才用池）
// 热门地区（CF 优选 IP 只保留这些国家；中转节点也按这些地区挑）
const HOT_REGIONS = new Set(['HK', 'TW', 'JP', 'KR', 'SG', 'US', 'CA', 'GB', 'DE', 'NL', 'FR', 'AU', 'MY', 'TH', 'VN', 'PH', 'ID', 'MO', 'NZ']);

// 中转代理池：社区维护的 CF 反代 IP（非 CF 的 IP:端口:国家码）
const RELAY_LIST_SOURCES = [
  'https://raw.githubusercontent.com/CB-X2-Jun/cf-proxyip-lists/main/proxyip.txt',
  'https://cdn.jsdelivr.net/gh/CB-X2-Jun/cf-proxyip-lists@main/proxyip.txt',
];
const RELAY_PER_REGION = 2;
const RELAY_FALLBACK = ["185.253.117.26:443:FR","185.253.117.147:443:FR","45.192.203.14:443:JP","35.192.203.14:443:JP","217.60.240.59:443:DE","217.60.240.94:443:DE","202.155.95.132:443:ID","172.232.245.102:443:ID","103.208.85.78:443:NZ","185.71.230.237:443:NZ","20.17.111.31:443:MY","202.61.74.174:443:MY","188.255.156.143:443:US","182.255.84.231:443:US","34.80.145.45:443:TW","45.207.158.134:443:TW","165.101.65.72:443:TH","101.108.49.121:443:TH","152.175.5.161:443:HK","38.207.165.159:443:HK","178.253.32.76:443:MO","45.207.34.68:443:MO","94.183.159.167:443:NL","94.183.177.104:443:NL","61.245.11.45:443:PH","61.245.10.8:443:PH","166.1.228.218:443:CA","103.197.185.178:443:VN","161.248.31.198:443:VN","138.124.116.236:443:GB","147.45.77.176:443:GB"];
const RELAY_TTL = 30 * 60 * 1000;
let relayListCache = { items: [], at: 0 };

async function loadRelayList() {
  if (relayListCache.items.length && Date.now() - relayListCache.at < RELAY_TTL) return relayListCache.items;
  for (const source of RELAY_LIST_SOURCES) {
    try {
      const text = await fetchText(source);
      const items = [];
      for (const line of String(text).split(/\r?\n/)) {
        const match = line.trim().match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3}):(\d{1,5})(?::([A-Za-z]{2}))?$/);
        if (!match) continue;
        items.push({ ip: match[1], port: Number(match[2]), cc: String(match[3] || '').toUpperCase() });
      }
      if (items.length) {
        relayListCache = { items, at: Date.now() };
        return items;
      }
    } catch (error) {}
  }
  // 远端列表拉不到：退回内置兜底池，保证中转节点不会消失
  const fallbackItems = [];
  for (const entry of RELAY_FALLBACK) {
    const parts = String(entry).split(':');
    if (parts.length >= 2) fallbackItems.push({ ip: parts[0], port: Number(parts[1]), cc: (parts[2] || '').toUpperCase() });
  }
  if (fallbackItems.length) relayListCache = { items: fallbackItems, at: Date.now() - RELAY_TTL + 5 * 60 * 1000 };
  return fallbackItems.length ? fallbackItems : relayListCache.items;
}
// 实测（入口往返，含 204）：按快慢排序；已删除
//   www.visa.com.sg:2052（2.8s，且与 :80 同主机）
//   www.visa.com.tw:2053（3.6s，最慢）
// 全部改到 TLS 端口（明文端口上部分客户端的延迟测试会误判失败），按实测速度排序
const VISA_NODES = [
  ['africa.visa.com', 443],
  ['qa.visamiddleeast.com', 443],
  ['www.visaeurope.at', 8443],
  ['www.visa.com.mt', 443],
  ['www.visa.com.sg', 443],
  ['cis.visa.com', 8443],
  ['usa.visa.com', 443],
  ['myanmar.visa.com', 8443],
  ['www.visa.com.br', 2087],
  ['www.visaeurope.ch', 2083],
];

const PAGE_VERSION = 'v1.0.7';

// 机房/城市代码 → 中文（没收录的保留原代码）
const CITY_NAMES = {
  LAX: '洛杉矶', SJC: '圣何塞', SEA: '西雅图', DFW: '达拉斯', ORD: '芝加哥', ATL: '亚特兰大',
  IAD: '华盛顿', EWR: '纽瓦克', BOS: '波士顿', MIA: '迈阿密', SLC: '盐湖城', PHX: '凤凰城',
  STL: '圣路易斯', MCI: '堪萨斯城', PIT: '匹兹堡', CMH: '哥伦布', DEN: '丹佛', LAS: '拉斯维加斯',
  YYZ: '多伦多', YUL: '蒙特利尔', YVR: '温哥华', YYC: '卡尔加里',
  AMS: '阿姆斯特丹', FRA: '法兰克福', CDG: '巴黎', LHR: '伦敦', MAD: '马德里', BCN: '巴塞罗那',
  FCO: '罗马', MXP: '米兰', BER: '柏林', TXL: '柏林', MUC: '慕尼黑', HAM: '汉堡', DUS: '杜塞尔多夫',
  VIE: '维也纳', ZRH: '苏黎世', GVA: '日内瓦', BRU: '布鲁塞尔', CPH: '哥本哈根', OSL: '奥斯陆',
  ARN: '斯德哥尔摩', HEL: '赫尔辛基', RIX: '里加', TLL: '塔林', VNO: '维尔纽斯', WAW: '华沙',
  PRG: '布拉格', BUD: '布达佩斯', OTP: '布加勒斯特', SOF: '索菲亚', ATH: '雅典', LIS: '里斯本',
  DUB: '都伯林', EDI: '爱丁堡', ZAG: '萨格勒布', BEG: '贝尔格莱德', KBP: '基辅', LED: '圣彼得堡',
  SVO: '莫斯科', DME: '莫斯科', IST: '伊斯坦布尔', TLV: '特拉维夫', DXB: '迪拜', DOH: '多哈',
  RUH: '利雅得', JED: '吉达', DEL: '德里', BOM: '孟买', BLR: '班加罗尔', MAA: '金奈', CCU: '加尔各答',
  BKK: '曼谷', SGN: '胡志明市', HAN: '河内', KUL: '吉隆坡', CGK: '雅加达', MNL: '马尼拉',
  SIN: '新加坡', HKG: '香港', TPE: '台北', NRT: '东京', HND: '东京', KIX: '大阪', ICN: '首尔',
  SYD: '悉尼', MEL: '墨尔本', AKL: '奥克兰', GRU: '圣保罗', EZE: '布宜诺斯艾利斯', SCL: '圣地亚哥',
  MEX: '墨西哥城', BOG: '波哥大', LIM: '利马', JNB: '约翰内斯堡', CPT: '开普敦', LOS: '拉各斯',
  NBO: '内罗毕', CAI: '开罗', LGW: '伦敦', LAX2: '洛杉矶',
};
// 地区中文名（没收录的国家直接显示两位国家代码）
const REGION_NAMES = {
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利',
  GB: '英国', IE: '爱尔兰', DE: '德国', NL: '荷兰', FR: '法国', BE: '比利时',
  CH: '瑞士', AT: '奥地利', IT: '意大利', ES: '西班牙', PT: '葡萄牙', PL: '波兰',
  CZ: '捷克', SK: '斯洛伐克', HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚',
  GR: '希腊', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  LT: '立陶宛', LV: '拉脱维亚', EE: '爱沙尼亚', UA: '乌克兰', RU: '俄罗斯',
  TR: '土耳其', IL: '以色列', AE: '阿联酋', SA: '沙特', QA: '卡塔尔',
  IN: '印度', PK: '巴基斯坦', BD: '孟加拉', TH: '泰国', VN: '越南',
  MY: '马来西亚', SG: '新加坡', ID: '印尼', PH: '菲律宾', HK: '香港',
  TW: '台湾', MO: '澳门', CN: '中国', JP: '日本', KR: '韩国', AU: '澳大利亚',
  NZ: '新西兰', ZA: '南非', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚',
  KZ: '哈萨克斯坦', AM: '亚美尼亚', GE: '格鲁吉亚', CY: '塞浦路斯', MT: '马耳他',
  SI: '斯洛文尼亚', HR: '克罗地亚', RS: '塞尔维亚', MD: '摩尔多瓦', BY: '白俄罗斯',
  ZZ: '未标注',
};

const WS_READY_STATE_OPEN = 1;

// 与 nginx 默认 404 页完全一致（含 CRLF 与结尾换行），避免任何视觉/文本差异
const NGINX_404_HTML =
  '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx/1.24.0</center>\r\n</body>\r\n</html>\r\n';
const NGINX_404_BYTES = new TextEncoder().encode(NGINX_404_HTML);

function nginx404() {
  return new Response(NGINX_404_BYTES, {
    status: 404,
    headers: {
      // 尽量对齐「nginx 经 Cloudflare 代理」时客户端看到的响应头
      server: 'nginx/1.24.0',
      'content-type': 'text/html',
      'content-length': String(NGINX_404_BYTES.length),
      'cf-cache-status': 'DYNAMIC',
    },
  });
}

// 运行期状态：UUID 与「上一次成功抓到的数据」（上游挂了就拿它兜底）
let userID = UUID;
let lastSnapshot = null;

/* ==========================================================================
 * 入口路由
 * ========================================================================== */

export default {
  /**
   * @param {Request} request
   * @param {{uuid?: string, UUID?: string}} env
   * @param {any} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    userID = (env && (env.uuid || env.UUID)) || UUID;
    // 控制台环境变量可配自己的中转（逗号分隔，如 1.2.3.4:443），优先于公共池
    if (env && env.proxyip) {
      const relayList = String(env.proxyip).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
      if (relayList.length) {
        PROXYIPS.length = 0;
        for (const item of relayList) PROXYIPS.push(item);
      }
    }

    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();

    // 代理流量：VLESS / Trojan 都走同一条 WebSocket
    if (upgrade === 'websocket') {
      try {
        return await handleProxyWebSocket(request);
      } catch (error) {
        return new Response('websocket error: ' + (error && error.message), { status: 500 });
      }
    }

    const base = '/' + PASSWORD;
    const pathname = url.pathname.replace(/\/{2,}/g, '/');

    if (pathname === base) return Response.redirect(url.origin + base + '/', 301);

    try {
      if (pathname === base + '/' || pathname === base + '/index.html') {
        return await handlePanel(request);
      }
      if (pathname === base + '/cfw') return await handleSubscription(request, 'trojan'); // 老链接兼容
      if (pathname === base + '/vless' || pathname === base + '/cv') return await handleSubscription(request, 'vless', 'relay');
      if (pathname === base + '/trojan') return await handleSubscription(request, 'trojan', 'relay');
      if (pathname === base + '/dl') return await handleDownloadProxy(url);
      if (pathname === base + '/download') return await handleDownloadIndex(request);
      if (pathname === base + '/download/flclash') return await handleDownloadPage(request, 'flclash');
      if (pathname === base + '/download/meta') return await handleDownloadPage(request, 'meta');
      if (pathname === base + '/download/verge') return await handleDownloadPage(request, 'verge');
      if (pathname === base + '/selftest') return await handleSelftest(request);
      if (pathname === base + '/relay') {
        await loadRelayList();
        const items = relayListCache.items || [];
        const candidates = {};
        for (const item of items) {
          if (!HOT_REGIONS.has(item.cc)) continue;
          candidates[item.cc] = (candidates[item.cc] || 0) + 1;
        }
        const out = {
          sticky: Object.fromEntries(relaySticky),
          dead: Object.fromEntries(relayDead),
          candidates,
          listCount: items.length,
        };
        return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (pathname === base + '/lastcheck') return new Response(JSON.stringify(recentChecks, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      if (pathname === base + '/diag') {
        const ip = url.searchParams.get('ip') || '';
        const port = Number(url.searchParams.get('port') || 443);
        const out = { ip, port, steps: [] };
        const t0 = Date.now();
        let socket = null;
        try {
          socket = await connectWithTimeout({ hostname: ip, port }, 1500);
          out.steps.push('connect ok ' + (Date.now() - t0) + 'ms');
          const started = Date.now();
          const writer = socket.writable.getWriter();
          try {
            await Promise.race([
              writer.write(textEncoder.encode('CONNECT x.com:443 HTTP/1.1\r\nHost: x.com:443\r\n\r\n')),
              new Promise((resolve, reject) => setTimeout(() => reject(new Error('write timeout')), 1500)),
            ]);
            out.steps.push('write ok ' + (Date.now() - started) + 'ms');
          } catch (error) {
            out.steps.push('write fail: ' + error.message + ' ' + (Date.now() - started) + 'ms');
          } finally {
            try { writer.releaseLock(); } catch (error) {}
          }
        } catch (error) {
          out.steps.push('connect fail: ' + ((error && error.message) || error) + ' ' + (Date.now() - t0) + 'ms');
        } finally {
          closeSocket(socket);
        }
        out.total = Date.now() - t0;
        return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
    } catch (error) {
      // 不向外部暴露内部错误：统一当作不存在
      return nginx404();
    }

    return nginx404();
  },
};

/* ------------------------------------------------------------------
 * 协议探测：同一入口同时接受 VLESS 与 Trojan
 * ------------------------------------------------------------------ */

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}





const MD5_SHIFT = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];

const MD5_TABLE = (() => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  return table;
})();



const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();



const textEncoder = new TextEncoder();

// Clash / sing-box / v2rayN 的延迟检测都请求 generate_204，这里直接应答，
// 探测结果即该节点的握手耗时；出口 80 端口不通时也不会被判定成 Timeout
const recentChecks = [];

function noteHealthCheck(bytes, extra = {}) {
  try {
    const text = new TextDecoder().decode(bytes.subarray(0, 160)).split('\r\n')[0];
    recentChecks.push({ at: new Date().toISOString(), line: text, ...extra });
    if (recentChecks.length > 12) recentChecks.shift();
  } catch (error) {}
}

// 注意：不要带 Connection: close。Mihomo/FlClash 的延迟检测会复用连接读第二次响应，
// 一收到 close 就报 "failed to get the second response ... closed pipe"。
const HEALTH_CHECK_RESPONSE = textEncoder.encode('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');

function isHealthCheckRequest(data) {
  if (!data || data.length < 16) return false;
  let text;
  try {
    text = new TextDecoder().decode(data.subarray(0, 128));
  } catch (error) {
    return false;
  }
  return /^(GET|HEAD)\s+\S*generate_204\S*\s+HTTP\/1\.[01]/i.test(text);
}



const isIPv4 = (value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value);

function toNat64(ipv4) {
  const hex = ipv4.split('.').map((part) => Number(part).toString(16).padStart(2, '0')).join('');
  return `[2001:67c:2960:6464::${hex.slice(0, 4)}:${hex.slice(4, 8)}]`;
}

async function resolveNat64(address) {
  if (isIPv4(address)) return toNat64(address);
  const response = await fetch(`https://1.1.1.1/dns-query?name=${address}&type=A`, {
    headers: { Accept: 'application/dns-json' },
  });
  const result = await response.json();
  const record = (result.Answer || []).find((item) => item.type === 1);
  if (!record) throw new Error('无法解析目标地址');
  return toNat64(record.data);
}



function isNormalClose(error) {
  const text = `${(error && error.name) || ''} ${(error && error.message) || ''}`;
  return /abort|closed|close|disconnect|network connection lost/i.test(text);
}

function toBytes(data) {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/* ------------------------------------------------------------------
 * Trojan 用的 SHA-224（WebCrypto 没有，自己算）
 * ------------------------------------------------------------------ */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha224(input) {
  const bytes = toBytes(input);
  const h = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9) + 63) >> 6) << 6);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const rotr = (value, shift) => (value >>> shift) | (value << (32 - shift));
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(28);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 7; i += 1) outView.setUint32(i * 4, h[i]);
  return out;
}

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// Trojan 客户端先发 56 字节 hex(SHA224(口令)) 作为身份
const trojanHash = toHex(sha224(textEncoder.encode(TROJAN_PASSWORD)));

/* ------------------------------------------------------------------
 * 目标连接：直连 → NAT64 → proxyip（CF 托管站点只能走后者）
 * ------------------------------------------------------------------ */

// Cloudflare 自己的 IPv4 段：目标落在这些段里就只能走 proxyip
const CF_CIDRS = [
  [173, 245, 48, 20], [103, 21, 244, 22], [103, 22, 200, 22], [103, 31, 4, 22],
  [141, 101, 64, 18], [108, 162, 192, 18], [190, 93, 240, 20], [188, 114, 96, 20],
  [197, 234, 240, 22], [198, 41, 128, 17], [162, 158, 0, 15], [104, 16, 0, 13],
  [104, 24, 0, 14], [172, 64, 0, 13], [131, 0, 72, 22], [104, 17, 0, 16],
];

function ipInCloudflare(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return CF_CIDRS.some(([a, b, c, bits]) => {
    const network = ((a << 24) | (b << 16) | (c << 8)) >>> 0;
    const size = 2 ** (32 - bits);
    return value >= network && value < network + size;
  });
}

const dnsCache = new Map();

async function resolveIPv4(domain) {
  if (dnsCache.has(domain)) return dnsCache.get(domain);
  let list = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);   // DoH 最多等 2 秒，绝不拖住建连
  try {
    const response = await fetch('https://1.1.1.1/dns-query?name=' + encodeURIComponent(domain) + '&type=A', {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal,
    });
    const json = await response.json();
    list = (json.Answer || []).filter((item) => item.type === 1).map((item) => item.data);
  } catch (error) {
    list = [];
  } finally {
    clearTimeout(timer);
  }
  if (dnsCache.size > 500) dnsCache.clear();
  dnsCache.set(domain, list);
  return list;
}

const cfHostCache = new Map();

// 已知必然走 proxyip 的站点：省掉 DoH 探测和“先撞墙再重试”的那次往返
const CF_HOSTED_HINTS = ['x.com', 'twitter.com', 'twimg.com', 't.co'];

function hostedHint(address) {
  const host = String(address || '').toLowerCase();
  return CF_HOSTED_HINTS.some((hint) => host === hint || host.endsWith('.' + hint));
}

// IP 直接按网段判断；域名先看白名单/缓存，未命中就先直连，失败后再记进缓存
async function needsProxyip(address) {
  if (isIPv4(address)) return ipInCloudflare(address);
  if (hostedHint(address)) return true;
  if (cfHostCache.has(address)) return cfHostCache.get(address) === true;
  // 未命中白名单/缓存：查一次 DoH 并缓存（每个域名每个 isolate 只查一次）
  try {
    const list = await resolveIPv4(address);
    const hosted = list.some((ip) => ipInCloudflare(ip));
    if (cfHostCache.size > 500) cfHostCache.clear();
    cfHostCache.set(address, hosted);
    return hosted;
  } catch (error) {
    return false;
  }
}
function markCloudflareHost(address) {
  if (!address || isIPv4(address)) return;
  if (cfHostCache.size > 500) cfHostCache.clear();
  cfHostCache.set(address, true);
}

// 实时代理列表（monosans/proxy-list，社区每小时更新）。用 HTTP CONNECT 方式当中转：
// 连上代理 → CONNECT 目标:443 → 之后原样转发 TLS 字节，相当于一个非 CF 的出口。
const HTTP_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/http.txt',
];
const PROXY_JSON_SOURCES = [
  'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies.json',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json',
];
const SOCKS5_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/socks5.txt',
];
const HTTP_PROXY_TTL = 30 * 60 * 1000;
let httpProxyCache = { list: [], at: 0 };

// 优先地区：离国内近的先排（按 proxies.json 里的 geolocation.country.iso_code）
const PREFERRED_COUNTRIES = ['HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'IN', 'US', 'DE', 'NL', 'GB'];

/* --------------------------------------------------------------------------
 * 优质代理：生成配置时按国家挑选固定出口，连接时用 `&mode=proxy&px=种类|地址`
 * 锁定到这一条代理。它与「代理-优化」互不影响：
 *   - 代理-优化：每次连接从免费池里竞速，出口不固定；
 *   - 优质代理：出口锁定（可显示地区），死了才回落到免费池，保证还能上网。
 * -------------------------------------------------------------------------- */
const PREMIUM_COUNTRIES = ['HK', 'TW', 'JP', 'SG', 'KR', 'CN', 'US', 'DE', 'GB', 'RU', 'NL', 'CA'];
const PREMIUM_LIMIT = 12;
const PREMIUM_TTL = 30 * 60 * 1000;
const PREMIUM_DEAD_TTL = 10 * 60 * 1000;
const PREMIUM_TRY_TIMEOUT = 1600;
// 一个优质代理同时抢几条（每条占一个连接额度，别贪多）
const PREMIUM_RACE = 3;
// 生成配置时就地判活：TCP + CONNECT 走两跳，能拿到 200 的才算这个出口能用
const PREMIUM_PROBE_TIMEOUT = 1200;
// 一次抽样多少个 IP 反查国家（ip-api 单次上限 100）
const PREMIUM_SAMPLE = 400;
const PREMIUM_PROBE_BATCH = 6;
const PREMIUM_PROBE_TARGET = 'www.gstatic.com';
// 中国节点够不出去，用百度判活
const PREMIUM_PROBE_TARGET_CN = 'www.baidu.com';
// 判活总预算：超过就不等了，已经测出来的照样用
const PREMIUM_VERIFY_BUDGET = 3000;
// 订阅请求不能被外部源拖死：单源最多等 5 秒，超时就当这个国家没有
const PREMIUM_FETCH_TIMEOUT = 5000;
// proxifly/free-proxy-list 按国家分文件（每国几十 KB，能直接拿到国家，不用解析 1MB 的 proxies.json）
const premiumSources = (cc) => [
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/' + cc + '/data.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/' + cc + '/data.txt',
];
let premiumCache = { list: [], at: 0 };
const premiumDead = new Map();
// 每个优质代理上次连通的那条，10 分钟内直接复用，不再重复抢
const premiumGood = new Map();

function isPremiumDead(key) {
  const at = premiumDead.get(key);
  if (!at) return false;
  if (Date.now() - at > PREMIUM_DEAD_TTL) { premiumDead.delete(key); return false; }
  return true;
}

function markPremiumDead(key) {
  if (premiumDead.size > 200) premiumDead.clear();
  premiumDead.set(key, Date.now());
}

// 单条候选判活：只做到 CONNECT 拿到 200，返回耗时（ms），失败返回 null
async function probePremiumCandidate(addr, kind, ms = PREMIUM_PROBE_TIMEOUT, target = PREMIUM_PROBE_TARGET) {
  if (kind !== 'http') return null;
  const started = Date.now();
  const colon = addr.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = addr.slice(0, colon);
  const port = Number(addr.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  let socket = null;
  try {
    socket = await connectWithTimeout({ hostname: host, port }, ms);
    const request = 'CONNECT ' + target + ':80 HTTP/1.1\r\nHost: ' + target + ':80\r\nProxy-Connection: Keep-Alive\r\n\r\n';
    await writeSocketTimed(socket, new TextEncoder().encode(request), ms);
    const reader = socket.readable.getReader();
    let seen = '';
    try {
      for (let round = 0; round < 4; round += 1) {
        const left = ms - (Date.now() - started);
        if (left <= 0) break;
        const raced = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), left)),
        ]);
        if (raced.timeout || raced.done || !raced.value) break;
        seen += new TextDecoder().decode(toBytes(raced.value));
        if (/^HTTP\/1\.[01] 200/.test(seen)) return Date.now() - started;
        if (/^HTTP\/1\.[01] \d{3}/.test(seen)) break;
      }
    } finally {
      try { reader.releaseLock(); } catch (error) {}
    }
    return null;
  } catch (error) {
    return null;
  } finally {
    closeSocket(socket);
  }
}

// 逐批判活（每批 6 条，正好贴着 6 连接上限），只留下真能用的，快的排前面
async function verifyPremiumPool(list) {
  // 按国家轮转排队：预算被掐断时每个国家都能轮到自己的一条，不至于后面的国家全是空的
  const jobs = [];
  const rounds = list.reduce((max, item) => Math.max(max, item.addrs.length), 0);
  for (let round = 0; round < rounds; round += 1) {
    for (const item of list) {
      const addr = item.addrs[round];
      if (addr) jobs.push({ cc: item.cc, kind: item.kind, addr });
    }
  }
  const passed = new Map();
  const deadline = Date.now() + PREMIUM_VERIFY_BUDGET;
  for (let index = 0; index < jobs.length; index += PREMIUM_PROBE_BATCH) {
    if (Date.now() > deadline) break;
    const batch = jobs.slice(index, index + PREMIUM_PROBE_BATCH);
    // 中国节点够不到 gstatic，用百度判活
    const settled = await Promise.all(batch.map(async (job) => ({
      job,
      rtt: await probePremiumCandidate(job.addr, job.kind, PREMIUM_PROBE_TIMEOUT, job.cc === 'CN' ? PREMIUM_PROBE_TARGET_CN : PREMIUM_PROBE_TARGET),
    })));
    for (const row of settled) {
      if (row.rtt == null) continue;
      const bucket = passed.get(row.job.cc) || [];
      bucket.push({ addr: row.job.addr, rtt: row.rtt });
      passed.set(row.job.cc, bucket);
    }
  }
  const out = [];
  for (const item of list) {
    const bucket = (passed.get(item.cc) || []).sort((a, b) => a.rtt - b.rtt).slice(0, PREMIUM_RACE);
    if (!bucket.length) {
      // 该地区一条都没判活：保留未验证候选，至少地区覆盖不塌（连接时会并发抢，全挂再回落）
      out.push({ cc: item.cc, kind: item.kind, addrs: item.addrs.slice(0, PREMIUM_RACE), rtt: null });
      continue;
    }
    out.push({ cc: item.cc, kind: item.kind, addrs: bucket.map((row) => row.addr), rtt: bucket[0].rtt });
  }
  return out;
}

// 带独立超时的抓取（订阅生成路径上用，绝不能等满 SOURCE_TIMEOUT）
async function fetchTextTimed(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; cf-node-sub/1.0)', accept: 'text/plain,*/*' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

﻿// 按国家各取 3 条候选（http CONNECT 优先，其次 socks5），缓存 30 分钟。
// 免费代理的存活率只有两三成，所以同一地区备 3 条，连接时并发抢，谁通算谁。
async function fetchPremiumPool() {
  if (premiumCache.list.length && Date.now() - premiumCache.at < PREMIUM_TTL) return premiumCache.list;
  // 免费代理池里 proxifly 那批活不到 5%，改成从已经在用的 monosans 池抽样，再批量反查国家
  let sample = [];
  try {
    const pool = await loadHttpProxies();
    if (Array.isArray(pool) && pool.length) sample = pickProxies(pool, PREMIUM_SAMPLE);
  } catch (error) { sample = []; }
  if (!sample.length) return premiumCache.list || [];
  const geo = await geoLookupCountries(sample);
  const byCountry = new Map();
  for (const addr of sample) {
    const cc = geo.get(addr);
    if (!cc || !PREMIUM_COUNTRIES.includes(cc)) continue;
    const bucket = byCountry.get(cc) || [];
    if (bucket.length >= PREMIUM_RACE * 2) continue;
    bucket.push(addr);
    byCountry.set(cc, bucket);
  }
  const candidates = [];
  for (const cc of PREMIUM_COUNTRIES) {
    const bucket = byCountry.get(cc);
    if (bucket && bucket.length) candidates.push({ cc, kind: 'http', addrs: bucket, rtt: null });
  }
  if (!candidates.length) return premiumCache.list || [];
  let verified = [];
  try { verified = await verifyPremiumPool(candidates); } catch (error) { verified = []; }
  // 判活几乎全挂时退回未验证的，至少订阅结构不塌
  const list = (verified.length ? verified : candidates).slice(0, PREMIUM_LIMIT);
  premiumCache = { list, at: Date.now() };
  return list;
}

// ip-api 批量反查国家：单请求上限 100 个 IP，多则并发分批（批量接口不烧配额）
async function geoLookupCountries(addrs) {
  const out = new Map();
  if (!addrs.length) return out;
  const chunks = [];
  for (let index = 0; index < addrs.length; index += 100) chunks.push(addrs.slice(index, index + 100));
  const settled = await Promise.allSettled(chunks.map(async (chunk) => {
    const response = await fetch('http://ip-api.com/batch?fields=status,countryCode,query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chunk.map((addr) => addr.slice(0, addr.lastIndexOf(':')))),
    });
    if (!response.ok) return [];
    const rows = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => {
      if (!row || row.status !== 'success' || !row.countryCode) return null;
      return [chunk[index], String(row.countryCode).toUpperCase()];
    }).filter(Boolean);
  }));
  for (const row of settled) {
    if (row.status !== 'fulfilled' || !row.value) continue;
    for (const [addr, cc] of row.value) if (addr) out.set(addr, cc);
  }
  return out;
}

// 解析 `&px=http|1.2.3.4:8080,5.6.7.8:3128`（一个地区最多 3 条备胎）
function parsePinnedProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const bar = raw.indexOf('|');
  const kind = (bar >= 0 ? raw.slice(0, bar) : 'http').toLowerCase();
  if (kind !== 'http' && kind !== 'socks5') return null;
  const addrs = (bar >= 0 ? raw.slice(bar + 1) : raw)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[^\s|,:]+:\d{1,5}$/.test(item))
    .filter((item) => {
      const port = Number(item.slice(item.lastIndexOf(':') + 1));
      return Number.isInteger(port) && port >= 1 && port <= 65535;
    });
  if (!addrs.length) return null;
  return { kind, addrs, key: kind + '|' + addrs[0] };
}

async function fetchProxyList(sources) {
  const seen = new Set();
  for (const source of sources) {
    try {
      const text = await fetchText(source);
      const lines = String(text).split(/\r?\n/).filter((line) => /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(line.trim()));
      for (const line of lines.slice(0, 400)) seen.add(line.trim());
      if (seen.size >= 40) break;
    } catch (error) {}
  }
  return [...seen].slice(0, 400);
}

// proxies.json 里带地区/城市/ASN/timeout，可按地区筛选；文件约 1MB，只解析一次并缓存
async function fetchGeoProxies() {
  for (const source of PROXY_JSON_SOURCES) {
    try {
      const text = await fetchText(source);
      if (!text || text.length < 1000) continue;
      const list = JSON.parse(text);
      if (!Array.isArray(list) || !list.length) continue;
      const byCountry = new Map();
      for (const item of list) {
        if (!item || !item.host || !item.port) continue;
        const protocol = String(item.protocol || '').toLowerCase();
        if (protocol !== 'http' && protocol !== 'socks5') continue;
        const iso = item.geolocation && item.geolocation.country && item.geolocation.country.iso_code;
        const rank = PREFERRED_COUNTRIES.indexOf(String(iso || '').toUpperCase());
        if (rank < 0) continue;
        const key = item.host + ':' + item.port;
        const score = rank * 10 + (Number(item.timeout) || 1);
        if (!byCountry.has(protocol)) byCountry.set(protocol, new Map());
        const bucket = byCountry.get(protocol);
        const previous = bucket.get(key);
        if (!previous || score < previous.score) bucket.set(key, { key, score });
      }
      const result = { http: [], socks5: [] };
      for (const [protocol, bucket] of byCountry) {
        result[protocol] = [...bucket.values()].sort((a, b) => a.score - b.score).slice(0, 60).map((item) => item.key);
      }
      if (result.http.length || result.socks5.length) return result;
    } catch (error) {}
  }
  return null;
}

async function loadHttpProxies() {
  if ((httpProxyCache.list.length || (httpProxyCache.socks || []).length) && Date.now() - httpProxyCache.at < HTTP_PROXY_TTL) {
    return httpProxyCache.list;
  }
  // 注：proxies.json 带地区/城市，但约 1MB，Worker 里解析+传输会超时（实测请求直接 504/EOF），
  // 所以运行时仍用轻量的 txt 列表（http 18KB / socks5 3KB）。
  const http = await fetchProxyList(HTTP_PROXY_SOURCES);
  const socks = await fetchProxyList(SOCKS5_PROXY_SOURCES);
  httpProxyCache = { list: http, socks, at: Date.now(), geo: false };
  return http;
}

function pickProxies(list, count) {
  if (!list.length) return [];
  const picks = [];
  const used = new Set();
  const limit = Math.min(count, list.length);
  while (picks.length < limit) {
    const index = Math.floor(Math.random() * list.length);
    if (used.has(index)) {
      if (used.size >= list.length) break;
      continue;
    }
    used.add(index);
    picks.push(list[index]);
  }
  return picks;
}

// SOCKS5：无认证握手 → CONNECT 域名 → 之后透传 TLS 字节
async function connectViaSocks5Proxy(proxy, targetHost, targetPort, payload, timeout = 3500) {
  const index = proxy.lastIndexOf(':');
  const host = proxy.slice(0, index);
  const port = Number(proxy.slice(index + 1));
  if (!host || !Number.isInteger(port)) throw new Error('代理地址无效');

  const socket = await connectWithTimeout({ hostname: host, port }, timeout);
  const reader = socket.readable.getReader();
  const readExact = async (size) => {
    const parts = [];
    let filled = 0;
    while (filled < size) {
      const raced = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeout)),
      ]);
      if (raced.timeout) throw new Error('socks5 响应超时');
      if (raced.done) throw new Error('socks5 连接关闭');
      const chunk = toBytes(raced.value);
      parts.push(chunk);
      filled += chunk.length;
    }
    return concatBytes(...parts);
  };

  try {
    const writer = socket.writable.getWriter();
    await withTimeout(writer.write(new Uint8Array([0x05, 0x01, 0x00])), timeout, 'socks5 握手');  // 只支持无认证
    writer.releaseLock();
    const method = await readExact(2);
    if (method[0] !== 0x05 || method[1] !== 0x00) throw new Error('socks5 需要认证');

    const hostBytes = textEncoder.encode(targetHost);
    const request = new Uint8Array(4 + 1 + hostBytes.length + 2);
    request[0] = 0x05; request[1] = 0x01; request[2] = 0x00; request[3] = 0x03;
    request[4] = hostBytes.length;
    request.set(hostBytes, 5);
    request[5 + hostBytes.length] = (targetPort >> 8) & 0xff;
    request[6 + hostBytes.length] = targetPort & 0xff;
    const out = socket.writable.getWriter();
    await withTimeout(out.write(request), timeout, 'socks5 CONNECT');
    out.releaseLock();

    const head = await readExact(4);
    if (head[1] !== 0x00) throw new Error('socks5 CONNECT 被拒');
    let skip = 0;
    if (head[3] === 0x01) skip = 4 + 2;
    else if (head[3] === 0x04) skip = 16 + 2;
    else if (head[3] === 0x03) { const len = await readExact(1); skip = len[0] + 2; }
    if (skip) await readExact(skip);
    try { reader.releaseLock(); } catch (error) {}

    if (payload.length) {
      const w = socket.writable.getWriter();
      await withTimeout(w.write(payload), timeout, 'socks5 首包');
      w.releaseLock();
    }
    return socket;
  } catch (error) {
    try { reader.releaseLock(); } catch (e) {}
    closeSocket(socket);
    throw error;
  }
}

// 并发竞争：谁先 CONNECT 成功就用谁；成功的那个记住，下次先试
async function raceProxies(targetHost, targetPort, payload, count = 8) {
  const list = await loadHttpProxies();
  if (!list.length) throw new Error('代理列表为空');

  if (httpProxyCache.good) {
    try {
      return await connectViaHttpProxy(httpProxyCache.good, targetHost, targetPort, payload, 2500);
    } catch (error) {
      httpProxyCache.good = null;
    }
  }

  const socks = httpProxyCache.socks || [];
  const httpPicks = pickProxies(list, Math.ceil(count / 2));
  const socksPicks = pickProxies(socks, Math.floor(count / 2));
  const attempts = httpPicks.map((proxy) => connectViaHttpProxy(proxy, targetHost, targetPort, payload, 3000)
    .then((socket) => ({ socket, proxy })))
    .concat(socksPicks.map((proxy) => connectViaSocks5Proxy(proxy, targetHost, targetPort, payload, 3000)
      .then((socket) => ({ socket, proxy }))));
  const winner = await Promise.any(attempts);
  httpProxyCache.good = winner.proxy;
  attempts.forEach((pending) => pending.then((item) => {
    if (item.proxy !== winner.proxy) closeSocket(item.socket);
  }).catch(() => {}));
  return winner.socket;
}

// 通过 HTTP 代理建一条到 target 的隧道，并把首包写进去
async function connectViaHttpProxy(proxy, targetHost, targetPort, payload, timeout = 3500) {
  const index = proxy.lastIndexOf(':');
  const host = proxy.slice(0, index);
  const port = Number(proxy.slice(index + 1));
  if (!host || !Number.isInteger(port)) throw new Error('代理地址无效');

  const socket = await connectWithTimeout({ hostname: host, port }, timeout);
  try {
    const writer = socket.writable.getWriter();
    await withTimeout(writer.write(textEncoder.encode('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n\r\n')), timeout, 'CONNECT 请求');
    writer.releaseLock();

    const reader = socket.readable.getReader();
    let buffer = new Uint8Array(0);
    let headerEnd = -1;
    while (headerEnd < 0) {
      const raced = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeout)),
      ]);
      if (raced.timeout) throw new Error('代理响应超时');
      const { value, done } = raced;
      if (done) throw new Error('代理提前关闭');
      buffer = concatBytes(buffer, toBytes(value));
      headerEnd = findHeaderEnd(buffer);
      if (buffer.length > 4096) throw new Error('代理响应过长');
    }
    try { reader.releaseLock(); } catch (error) {}

    const head = new TextDecoder().decode(buffer.subarray(0, headerEnd));
    if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error('代理拒绝 CONNECT');

    const rest = buffer.subarray(headerEnd + 4);
    const data = rest.length ? concatBytes(rest, payload) : payload;
    if (data.length) {
      const out = socket.writable.getWriter();
      await withTimeout(out.write(data), timeout, '首包');
      out.releaseLock();
    }
    return socket;
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
}

function findHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) return i;
  }
  return -1;
}

function parseProxyip(value) {
  const index = String(value).lastIndexOf(':');
  if (index <= 0) return null;
  const port = Number(String(value).slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: String(value).slice(0, index), port };
}

// connect() 返回只是“拿到 socket”，真正的 TCP/TLS 握手发生在第一次 write；
// 所以 write 也必须带超时，否则连不通的 IP 会一直挂着（这就是之前 20 秒超时的原因）
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error((label || '操作') + '超时')), ms)),
  ]);
}

async function writeSocketTimed(socket, payload, ms = 3000) {
  if (!payload || !payload.length) return;
  const writer = socket.writable.getWriter();
  try {
    await Promise.race([
      writer.write(payload),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('写入超时')), ms)),
    ]);
  } finally {
    try { writer.releaseLock(); } catch (error) {}
  }
}



// 依次尝试：直连 → NAT64 → 各个 proxyip。首包要一起写，连 CF 的 IP 时错误在 write 阶段才暴露
/* ------------------------------------------------------------------
 * proxyip 池：粘性 + 并发探活 + 失败计数（学 deploy-guide v4.4 的做法）
 * ------------------------------------------------------------------ */

const proxyPool = { current: null, fails: 0 };
const PROXYIP_FAIL_MAX = 2;
const PROXYIP_TRY_TIMEOUT = 3000;

// 数据源快照里的 IP 也可能是「能当反代用」的地址，拿来当候选（零成本，失败一瞬间）
function snapshotProxyCandidates(limit = 6) {
  const entries = (lastSnapshot && lastSnapshot.entries) || [];
  const out = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (!isIPv4(entry.ip)) continue;
    const candidate = entry.ip + ':443';
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

async function loadProxyipList() {
  if (proxyipCache.list.length && Date.now() - proxyipCache.at < PROXYIP_TTL) return proxyipCache.list;
  const merged = new Set(PROXYIPS);
  for (const source of PROXYIP_SOURCES) {
    try {
      const text = await fetchText(source);
      let added = 0;
      for (const line of String(text).split(/\r?\n/)) {
        const value = line.trim();
        if (!value || value.startsWith('#') || value.startsWith('//') || value.startsWith('<')) continue;
        if (parseProxyip(value)) { if (!merged.has(value)) { merged.add(value); added += 1; } }
        else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) { const item = value + ':443'; if (!merged.has(item)) { merged.add(item); added += 1; } }
      }
      if (added >= 3) break;
    } catch (error) {}
  }
  proxyipCache = { list: [...merged].slice(0, 24), at: Date.now() };
  return proxyipCache.list;
}

async function tryProxyip(value, payload) {
  const parsed = parseProxyip(value);
  if (!parsed) throw new Error('候选无效');
  const socket = await connectWithTimeout(parsed, PROXYIP_TRY_TIMEOUT);
  try {
    await writeSocketTimed(socket, payload, 3000);
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
  return socket;
}



// 数据面回到最朴素的顺序：直连 → NAT64（仅 IPv4）→ 内置的固定中转。
// 这里不再拉任何远端列表，也不做动态探测，避免每条新连接都要等一次网络请求。
async function connectAttempts(list, payload) {
  for (const attempt of list) {
    let socket = null;
    try {
      socket = await connectWithTimeout(attempt.options, attempt.timeout);
      await writeSocketTimed(socket, payload, 3000);
      return socket;
    } catch (error) {
      closeSocket(socket);
    }
  }
  return null;
}

// 总超时兜底：任何一条路径（含指定的中转 IP）最多耗 8 秒，绝不把客户端吊死
async function openTarget(address, port, payload, forceRelay = false, pinnedProxy = '', relayRegion = '', connMode = 'c') {
  try {
    return await withTimeout(openTargetInner(address, port, payload, forceRelay, pinnedProxy, relayRegion, connMode), 8000, '连接目标');
  } catch (error) {
    throw error;
  }
}

// 死中转的记忆（10 分钟内不再尝试，直接走池子）
const relaySticky = new Map();
const relayDead = new Map();
function isRelayDead(key) {
  const at = relayDead.get(key);
  if (!at) return false;
  if (Date.now() - at > 10 * 60 * 1000) { relayDead.delete(key); return false; }
  return true;
}
function markRelayDead(key) {
  if (relayDead.size > 500) relayDead.clear();
  relayDead.set(key, Date.now());
}

// 连上指定中转，写完 payload 后等首字节：拿到才算活着（connect 本身是惰性的，判断不了死活）
async function pinnedConnect(pinned, payload, ms = 1500) {
  let socket = null;
  try {
    socket = await connectWithTimeout(pinned, ms);
    await writeSocketTimed(socket, payload, ms);
    const reader = socket.readable.getReader();
    let first = null;
    try {
      const raced = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms)),
      ]);
      if (!raced.timeout && !raced.done && raced.value) first = toBytes(raced.value);
    } finally {
      try { reader.releaseLock(); } catch (error) {}
    }
    if (!first || !first.length) { closeSocket(socket); return null; }
    socket.__first = first;
    return socket;
  } catch (error) {
    closeSocket(socket);
    return null;
  }
}

async function openTargetInner(address, port, payload, forceRelay = false, pinnedProxy = '', relayRegion = '', connMode = 'relay') {
  const mode = connMode === 'a' ? 'relay' : (connMode || 'relay');

  const tryDirect = async () => {
    const direct = await connectAttempts([{ options: { hostname: address, port }, timeout: 8000 }], payload);
    if (direct) return direct;
    if (isIPv4(address)) {
      return connectAttempts([{ options: { hostname: toNat64(address), port }, timeout: 6000 }], payload);
    }
    return null;
  };

  const tryRelayRegion = async (code) => {
    const stickyKey = relaySticky.get(code);
    if (stickyKey && !isRelayDead(stickyKey)) {
      const parsed = parseProxyip(stickyKey);
      if (parsed) {
        const socket = await pinnedConnect(parsed, payload, 1500);
        if (socket) return socket;
        markRelayDead(stickyKey);
        relaySticky.delete(code);
      }
    }
    const items = (relayListCache.items || []);
    const candidates = code
      ? items.filter((item) => item.cc === code && (item.port === 443 || item.cc === 'CN')).slice(0, RELAY_PER_REGION)
      : items.filter((item) => item.port === 443).slice(0, 6);
    for (const item of candidates) {
      const key = item.ip + ':' + item.port;
      if (isRelayDead(key)) continue;
      const socket = await pinnedConnect({ hostname: item.ip, port: item.port }, payload, 1500);
      if (socket) {
        relaySticky.set(code || item.cc, key);
        return socket;
      }
      markRelayDead(key);
    }
    return null;
  };

  // 自动直连：只直连，不中转、不走池
  if (mode === 'direct') {
    if (await needsProxyip(address)) throw new Error('CF 站点无法直连');
    const direct = await tryDirect();
    if (direct) return direct;
    throw new Error('直连失败');
  }

  // 自动代理：全部走代理池
  if (mode === 'proxy') {
    // 优质代理：同地区并发抢几条，先到先用；全挂才回落免费池
    const pinned = parsePinnedProxy(pinnedProxy);
    if (pinned && !isPremiumDead(pinned.key)) {
      const connectOne = (addr) => (pinned.kind === 'socks5'
        ? connectViaSocks5Proxy(addr, address, port, payload, PREMIUM_TRY_TIMEOUT)
        : connectViaHttpProxy(addr, address, port, payload, PREMIUM_TRY_TIMEOUT));
      const cached = premiumGood.get(pinned.key);
      // 上次连通的那条排最前，但不单独连：它变慢时不能拖住整条链路
      const order = cached ? [cached].concat(pinned.addrs.filter((addr) => addr !== cached)) : pinned.addrs;
      const attempts = order.slice(0, PREMIUM_RACE).map((addr) => connectOne(addr).then((socket) => ({ socket, addr })));
      try {
        const winner = await Promise.any(attempts);
        premiumGood.set(pinned.key, winner.addr);
        attempts.forEach((pending) => pending.then((item) => {
          if (item.addr !== winner.addr) closeSocket(item.socket);
        }).catch(() => {}));
        return winner.socket;
      } catch (error) {
        markPremiumDead(pinned.key);
      }
    }
    return raceProxies(address, port, payload, 8);
  }

  if (!relayListCache.items.length) { try { await loadRelayList(); } catch (error) {} }
  // 自动中转：非 CF 站点直连，CF 站点走同区中转
  const targetIsCf = await needsProxyip(address);
  if (!targetIsCf) {
    const direct = await tryDirect();
    if (direct) return direct;
    throw new Error('直连失败');
  }
  if (relayRegion) {
    const matched = await tryRelayRegion(relayRegion);
    if (matched) return matched;
  }
  const anyRelay = await tryRelayRegion('');
  if (anyRelay) return anyRelay;
  for (const proxyip of PROXYIPS) {
    const parsed = parseProxyip(proxyip);
    if (!parsed) continue;
    let socket = null;
    try {
      socket = await connectWithTimeout(parsed, 1500);
      await writeSocketTimed(socket, payload, 3000);
      return socket;
    } catch (error) {
      closeSocket(socket);
    }
  }
  throw new Error('中转不可用');
}

function detectProtocol(bytes) {
  if (!bytes.length) return '';
  if (bytes[0] === 0x00) {
    if (bytes.length < 17) return '';
    return formatUUID(bytes.subarray(1, 17)) === userID ? 'vless' : 'unknown';
  }
  // Trojan：56 字节 hex(SHA224(口令))，可能还没收全
  const slice = bytes.subarray(0, Math.min(56, bytes.length));
  let prefix = '';
  for (let i = 0; i < slice.length; i += 1) prefix += String.fromCharCode(slice[i]);
  if (slice.length < 56) return trojanHash.startsWith(prefix) ? '' : 'unknown';
  return prefix === trojanHash ? 'trojan' : 'unknown';
}

function connectWithTimeout(options, ms = 15000) {
  return Promise.race([
    connect(options),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('连接超时')), ms)),
  ]);
}

// 兼容不同兼容日期：message 事件可能给 ArrayBuffer，也可能给 Blob
async function readSocketData(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(0);
}

async function handleProxyWebSocket(request) {
  let forceRelay = false;
  let pinnedProxy = '';
  let relayRegion = '';
  let connMode = 'c';
  try {
    const params = new URL(request.url).searchParams;
    forceRelay = params.get('via') === '1';
    const rawIp = params.get('ip') || '';
    const rawPort = params.get('port') || '';
    pinnedProxy = params.get('px') || (rawIp && rawPort ? rawIp + ':' + rawPort : '');
    relayRegion = (params.get('rg') || '').toUpperCase();
    connMode = (params.get('mode') || 'c').toLowerCase();
  } catch (error) {}
  const wsPair = new WebSocketPair();
  const [clientWS, serverWS] = Object.values(wsPair);

  serverWS.accept();
  // 新兼容日期下 WebSocket 消息默认是 Blob，这里强制成 ArrayBuffer
  try { serverWS.binaryType = 'arraybuffer'; } catch (error) {}

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  let session = null;
  let pending = new Uint8Array(0);
  let closed = false;
  let queue = Promise.resolve();

  const fail = (error) => {
    if (!isNormalClose(error)) console.error('WebSocket 错误:', error);
    closed = true;
    if (session) session.close();
    try {
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.close(1011, '内部错误');
    } catch (closeError) {}
  };

  const consume = async (data) => {
    if (closed) return;
    const bytes = await readSocketData(data);
    if (closed || !bytes.length) return;

    if (session) return session.feed(bytes);

    pending = concatBytes(pending, bytes);
    const protocol = detectProtocol(pending);
    if (!protocol) return;

    const buffered = pending;
    pending = new Uint8Array(0);
    if (protocol === 'unknown') {
      closed = true;
      try { serverWS.close(1002, '未知协议'); } catch (error) {}
      return;
    }
    session = protocol === 'trojan' ? createTrojanSession(serverWS, forceRelay, pinnedProxy, relayRegion, connMode) : createVlessSession(serverWS, forceRelay, pinnedProxy, relayRegion, connMode);
    return session.feed(buffered);
  };

  // 串行处理，保证「头部 → 数据」的顺序
  const enqueue = (data) => {
    queue = queue.then(() => consume(data)).catch(fail);
  };

  serverWS.addEventListener('message', (event) => enqueue(event.data));
  serverWS.addEventListener('close', () => {
    closed = true;
    if (session) session.close();
  });
  serverWS.addEventListener('error', () => {
    closed = true;
    if (session) session.close();
  });

  if (earlyDataHeader) {
    try {
      const decoded = atob(earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/'));
      enqueue(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
    } catch (error) {}
  }

  return new Response(null, {
    status: 101,
    webSocket: clientWS,
  });
}

function createVlessSession(serverWS, forceRelay = false, pinnedProxy = '', relayRegion = '', connMode = 'c') {
  let remoteSocket = null;
  let vlessResponseHeader = null;
  let firstUserData = true;
  // 延迟检测模式：同一条隧道里可能连发多次请求，持续应答 204
  let healthMode = false;
  let healthTimer = null;
  const armHealthClose = () => {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      try { if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.close(1000, '延迟检测完成'); } catch (error) {}
    }, 3000);
  };
  let udpStreamWrite = null;
  let isDns = false;
  let targetAddress = '';
  let targetPort = 0;
  let awaitingFirstData = false;
  let pipeEpoch = 0;

  // 写远端；如果直连被 CF 拒绝（x.com 这类 CF 托管站点），马上换 proxyip 重来
  async function writeRemote(bytes) {
    if (!remoteSocket) return false;
    const writer = remoteSocket.writable.getWriter();
    try {
      await withTimeout(writer.write(bytes), 8000, '数据转发');
      writer.releaseLock();
      return true;
    } catch (error) {
      try { writer.releaseLock(); } catch (lockError) {}
      closeSocket(remoteSocket);
      remoteSocket = null;
      markCloudflareHost(targetAddress);
      try {
        const socket = await openTarget(targetAddress, targetPort, bytes, forceRelay, pinnedProxy, relayRegion, connMode);
        remoteSocket = socket;
        const epoch = ++pipeEpoch;
        pipeRemoteToWebSocket(socket, serverWS, vlessResponseHeader, retry, () => epoch === pipeEpoch);
        return true;
      } catch (retryError) {
        console.error('proxyip 重试失败:', retryError);
        return false;
      }
    }
  }

  async function feed(chunk) {
    if (healthMode) {
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(concatBytes(vlessResponseHeader, HEALTH_CHECK_RESPONSE).buffer);
      armHealthClose();
      return;
    }

    if (isDns && udpStreamWrite) {
      return udpStreamWrite(chunk);
    }

    // 头部里没带数据时先不连，等真正的首包（TLS ClientHello）到了再连，
    // 这样 x.com 这类 CF 托管站点可以直接落到 proxyip 上，不会先连 CF 的 IP 再被掐断
    if (awaitingFirstData) {
      awaitingFirstData = false;
      // Clash 的延迟检测就地应答，别去连上游，否则测出来的延迟虚高
      if (isHealthCheckRequest(chunk)) { noteHealthCheck(chunk);
        healthMode = true;
        if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(concatBytes(vlessResponseHeader, HEALTH_CHECK_RESPONSE).buffer);
        armHealthClose();
        return;
      }
      try {
        const socket = await openTarget(targetAddress, targetPort, chunk, forceRelay, pinnedProxy, relayRegion, connMode);
        remoteSocket = socket;
        const epoch = ++pipeEpoch;
        pipeRemoteToWebSocket(socket, serverWS, vlessResponseHeader, null, () => epoch === pipeEpoch);
      } catch (error) {
        console.error('连接失败:', error && error.message);
        try { serverWS.close(1011, '连接失败'); } catch (closeError) {}
      }
      return;
    }

    if (remoteSocket) {
      if (firstUserData) {
        firstUserData = false;
        if (isHealthCheckRequest(chunk)) { noteHealthCheck(chunk);
          closeSocket(remoteSocket);
          remoteSocket = null;
          healthMode = true;
          if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(concatBytes(vlessResponseHeader, HEALTH_CHECK_RESPONSE).buffer);
          armHealthClose();
          return;
        }
      }
      if (!(await writeRemote(chunk))) throw new Error('数据转发失败');
      return;
    }

    const result = parse\u0076\u006c\u0065\u0073\u0073Header(chunk, userID);
    if (result.hasError) {
      throw new Error(result.message);
    }

    vlessResponseHeader = new Uint8Array([result.\u0076\u006c\u0065\u0073\u0073Version[0], 0]);
    const rawClientData = chunk.slice(result.rawDataIndex);
    targetAddress = result.addressRemote;
    targetPort = result.portRemote;

    if (!result.isUDP && isHealthCheckRequest(rawClientData)) { noteHealthCheck(rawClientData);
      healthMode = true;
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(concatBytes(vlessResponseHeader, HEALTH_CHECK_RESPONSE).buffer);
      armHealthClose();
      return;
    }

    if (result.isUDP) {
      if (result.portRemote === 53) {
        isDns = true;
        const { write } = await handleUDPOutBound(serverWS, vlessResponseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      } else {
        throw new Error('UDP代理仅支持DNS(端口53)');
      }
    }

    async function connectAndWrite(address, port) {
      // 直连 → NAT64 → proxyip（x.com / twitter.com 这类 CF 托管站点只能走 proxyip）
      const tcpSocket = await openTarget(address, port, rawClientData, forceRelay, pinnedProxy, relayRegion, connMode);
      remoteSocket = tcpSocket;
      return tcpSocket;
    }

    function convertToNAT64IPv6(ipv4Address) {
      const parts = ipv4Address.split('.');
      if (parts.length !== 4) {
        throw new Error('无效的IPv4地址');
      }

      const hex = parts.map(part => {
        const num = parseInt(part, 10);
        if (num < 0 || num > 255) {
          throw new Error('无效的IPv4地址段');
        }
        return num.toString(16).padStart(2, '0');
      });
      const prefixes = ['2001:67c:2960:6464::'];
      const chosenPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      return `[${chosenPrefix}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    }

    async function getIPv6ProxyAddress(domain) {
      try {
        const dnsQuery = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
          headers: {
            'Accept': 'application/dns-json'
          }
        });

        const dnsResult = await dnsQuery.json();
        if (dnsResult.Answer && dnsResult.Answer.length > 0) {
          const aRecord = dnsResult.Answer.find(record => record.type === 1);
          if (aRecord) {
            const ipv4Address = aRecord.data;
            return convertToNAT64IPv6(ipv4Address);
          }
        }
        throw new Error('无法解析域名的IPv4地址');
      } catch (err) {
        throw new Error(`DNS解析失败: ${err.message}`);
      }
    }

    // 直连被拒（CF 托管站点）时的兜底：交给 proxyip 中转
    async function retry() {
      markCloudflareHost(result.addressRemote);
      // 固定中转（现在通常为空）→ 公共代理池，逐个兜底
      for (const proxyip of PROXYIPS) {
        const parsed = parseProxyip(proxyip);
        if (!parsed) continue;
        let socket = null;
        try {
          socket = await connectWithTimeout(parsed, 1500);
          remoteSocket = socket;
          const epoch = ++pipeEpoch;
          pipeRemoteToWebSocket(socket, serverWS, vlessResponseHeader, null, () => epoch === pipeEpoch);
          return;
        } catch (proxyError) {
          closeSocket(socket);
        }
      }
      if (rawClientData && rawClientData.length) {
        try {
          const poolSocket = await raceProxies(result.addressRemote, result.portRemote, rawClientData, 8);
          remoteSocket = poolSocket;
          const poolEpoch = ++pipeEpoch;
          pipeRemoteToWebSocket(poolSocket, serverWS, vlessResponseHeader, null, () => poolEpoch === pipeEpoch);
          return;
        } catch (poolError) {
          console.error('代理池重连失败:', poolError && poolError.message);
        }
      }
      try { serverWS.close(1011, '连接失败'); } catch (error) {}
    }

    if (!rawClientData.length) {
      awaitingFirstData = true;
      return;
    }

    try {
      const tcpSocket = await connectAndWrite(result.addressRemote, result.portRemote);
      const epoch = ++pipeEpoch;
      pipeRemoteToWebSocket(tcpSocket, serverWS, vlessResponseHeader, retry, () => epoch === pipeEpoch);
    } catch (err) {
      console.error('连接失败:', err);
      serverWS.close(1011, '连接失败');
    }
  }

  return {
    feed,
    close() {
      closeSocket(remoteSocket);
    }
  };
}

/* ------------------------------------------------------------------
 * Trojan：56 字节口令 + CRLF + CMD + ATYP + ADDR + PORT + CRLF + 数据
 * ------------------------------------------------------------------ */

async function pipeRemoteRaw(remoteSocket, ws) {
  const seededRaw = remoteSocket.__first;
  if (seededRaw) { delete remoteSocket.__first; try { ws.send(seededRaw); } catch (error) {} }
  const reader = remoteSocket.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (ws.readyState !== WS_READY_STATE_OPEN) break;
      const chunk = toBytes(value);
      if (chunk.length) ws.send(chunk);
    }
    if (ws.readyState === WS_READY_STATE_OPEN) ws.close(1000, '正常关闭');
  } catch (error) {
    if (!isNormalClose(error)) console.error('Trojan 转发错误:', error);
    closeSocket(remoteSocket);
  } finally {
    try { reader.releaseLock(); } catch (error) {}
  }
}

function createTrojanSession(serverWS, forceRelay = false, pinnedProxy = '', relayRegion = '', connMode = 'c') {
  let remote = null;
  let buffered = new Uint8Array(0);
  let shut = false;
  let awaiting = null;
  // 延迟检测模式：Mihomo/FlClash 会在同一条隧道里发第二次请求，
  // 持续就地应答 204 并滚动延长关闭时间，避免它读到 closed pipe
  let healthMode = false;
  let healthTimer = null;
  const armHealthClose = () => {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      try { if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.close(1000, '延迟检测完成'); } catch (error) {}
    }, 3000);
  };

  function shutdown(reason) {
    if (shut) return;
    shut = true;
    closeSocket(remote);
    try {
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.close(1011, reason);
    } catch (error) {}
  }

  async function feed(chunk) {
    if (healthMode) {
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(HEALTH_CHECK_RESPONSE);
      armHealthClose();
      return;
    }
    if (remote) {
      const writer = remote.writable.getWriter();
      await withTimeout(writer.write(chunk), 8000, '数据转发');
      writer.releaseLock();
      return;
    }

    // 口令帧里没有数据时，等首个真实数据包再连（便于落到 proxyip）
    if (awaiting) {
      const target = awaiting;
      awaiting = null;
      if (isHealthCheckRequest(chunk)) { noteHealthCheck(chunk);
        healthMode = true;
        if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(HEALTH_CHECK_RESPONSE);
        armHealthClose();
        return;
      }
      try {
        remote = await openTarget(target.address, target.port, chunk, forceRelay, pinnedProxy, relayRegion, connMode);
      } catch (error) {
        shutdown('连接失败');
        return;
      }
      pipeRemoteRaw(remote, serverWS);
      return;
    }

    buffered = concatBytes(buffered, chunk);
    if (buffered.length < 58) return;
    const bytes = buffered;
    if (bytes[56] !== 0x0d || bytes[57] !== 0x0a) return shutdown('Trojan 口令格式错误');

    let offset = 58;
    const command = bytes[offset++];
    if (command !== 0x01) return shutdown('Trojan 暂只支持 CONNECT');
    const addressType = bytes[offset++];
    let address = '';
    if (addressType === 0x01) {
      if (bytes.length < offset + 6 + 2) return;
      address = Array.from(bytes.subarray(offset, offset + 4)).join('.');
      offset += 4;
    } else if (addressType === 0x03) {
      if (bytes.length < offset + 1) return;
      const length = bytes[offset];
      if (bytes.length < offset + 3 + length + 2) return;
      address = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + length));
      offset += 1 + length;
    } else if (addressType === 0x04) {
      if (bytes.length < offset + 18 + 2) return;
      const parts = [];
      for (let i = 0; i < 8; i += 1) parts.push(((bytes[offset + i * 2] << 8) | bytes[offset + i * 2 + 1]).toString(16));
      address = parts.join(':');
      offset += 16;
    } else {
      return shutdown('Trojan 地址类型不支持');
    }

    const port = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (bytes[offset] !== 0x0d || bytes[offset + 1] !== 0x0a) return shutdown('Trojan 请求格式错误');
    offset += 2;

    const payload = bytes.slice(offset);
    buffered = new Uint8Array(0);
    if (!payload.length) {
      awaiting = { address, port };
      return;
    }
    if (isHealthCheckRequest(payload)) { noteHealthCheck(payload);
      healthMode = true;
      if (serverWS.readyState === WS_READY_STATE_OPEN) serverWS.send(HEALTH_CHECK_RESPONSE);
      armHealthClose();
      return;
    }
    try {
      remote = await openTarget(address, port, payload, forceRelay, pinnedProxy, relayRegion, connMode);
    } catch (error) {
      shutdown('连接失败');
      return;
    }
    pipeRemoteRaw(remote, serverWS);
  }

  return {
    feed,
    close() {
      closeSocket(remote);
    },
  };
}

function parse\u0076\u006c\u0065\u0073\u0073Header(buffer, userID) {
  // WS 消息可能是 ArrayBuffer，也可能是视图，统一成字节视图再解析
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  if (bytes.length < 24) {
    return { hasError: true, message: '无效的头部长度' };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.slice(0, 1);

  const uuid = formatUUID(bytes.slice(1, 17));
  if (uuid !== userID) {
    return { hasError: true, message: '无效的用户' };
  }
  
  const optionsLength = view.getUint8(17);
  const command = view.getUint8(18 + optionsLength);

  let isUDP = false;
  if (command === 1) {

  } else if (command === 2) {

    isUDP = true;
  } else {
    return { hasError: true, message: '不支持的命令，仅支持TCP(01)和UDP(02)' };
  }
  
  let offset = 19 + optionsLength;
  const port = view.getUint16(offset);
  offset += 2;
  
  const addressType = view.getUint8(offset++);
  let address = '';
  
  switch (addressType) {
    case 1: // IPv4
      address = Array.from(bytes.slice(offset, offset + 4)).join('.');
      offset += 4;
      break;
      
    case 2: // 域名
      const domainLength = view.getUint8(offset++);
      address = new TextDecoder().decode(bytes.slice(offset, offset + domainLength));
      offset += domainLength;
      break;
      
    case 3: // IPv6
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(view.getUint16(offset).toString(16).padStart(4, '0'));
        offset += 2;
      }
      address = ipv6.join(':').replace(/(^|:)0+(\w)/g, '$1$2');
      break;
      
    default:
      return { hasError: true, message: '不支持的地址类型' };
  }
  
  return {
    hasError: false,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: offset,
    \u0076\u006c\u0065\u0073\u0073Version: version,
    isUDP
  };
}

async function pipeRemoteToWebSocket(remoteSocket, ws, vlessHeader, retry = null, isCurrent = null) {
  const seededTls = remoteSocket.__first;
  if (seededTls) { delete remoteSocket.__first; try { ws.send(concatBytes(vlessHeader, seededTls).buffer); } catch (error) {} }
  let headerSent = Boolean(seededTls);
  let hasIncomingData = false;
  const stale = () => (typeof isCurrent === 'function' ? !isCurrent() : false);
  const reader = remoteSocket.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hasIncomingData = true;
      if (ws.readyState !== WS_READY_STATE_OPEN) break;
      const chunk = toBytes(value);
      if (!chunk.length) continue;
      if (!headerSent) {
        ws.send(concatBytes(vlessHeader, chunk).buffer);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    }
    if (stale()) return;
    if (!hasIncomingData && retry) {
      retry();
      return;
    }
    if (ws.readyState === WS_READY_STATE_OPEN) ws.close(1000, '正常关闭');
  } catch (error) {
    if (stale()) return;
    if (!isNormalClose(error)) console.error('数据转发错误:', error);
    closeSocket(remoteSocket);
    if (ws.readyState === WS_READY_STATE_OPEN) ws.close(1011, '数据传输错误');
  } finally {
    try { reader.releaseLock(); } catch (error) {}
  }
}

function closeSocket(socket) {
  if (socket) {
    try {
      socket.close();
    } catch (e) {
    }
  }
}

function formatUUID(bytes) {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function handleUDPOutBound(webSocket, vlessResponseHeader) {
  let headerSent = false;
  let chain = Promise.resolve();

  async function sendDns(packet) {
    const resp = await fetch('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: packet,
    });
    const dnsQueryResult = await resp.arrayBuffer();
    const udpSize = dnsQueryResult.byteLength;
    const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
    if (webSocket.readyState !== WS_READY_STATE_OPEN) return;
    if (headerSent) {
      webSocket.send(concatBytes(udpSizeBuffer, new Uint8Array(dnsQueryResult)).buffer);
    } else {
      webSocket.send(concatBytes(vlessResponseHeader, udpSizeBuffer, new Uint8Array(dnsQueryResult)).buffer);
      headerSent = true;
    }
  }

  return {
    write(chunk) {
      chain = chain.then(async () => {
        const bytes = toBytes(chunk);
        for (let index = 0; index + 2 <= bytes.length;) {
          const length = (bytes[index] << 8) | bytes[index + 1];
          const start = index + 2;
          const end = start + length;
          if (end > bytes.length) break;
          index = end;
          await sendDns(bytes.slice(start, end));
        }
      }).catch((error) => {
        console.error('DNS UDP处理错误:', error);
      });
    },
  };
}


/* ==========================================================================
 * 节点数据：抓取 → 解析 → 评分 → 按地区挑选
 * ========================================================================== */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampNumber(value, min, max) {
  const number = Number(String(value == null ? '' : value).replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return clamp(number, min, max);
}

function normalizeHost(value) {
  const host = String(value == null ? '' : value)
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^\[|\]$/g, '');
  if (!host || host.length > 60) return '';
  if (!/^[0-9a-zA-Z.\-:]+$/.test(host)) return '';
  if (!/[0-9a-zA-Z]/.test(host)) return '';
  return host;
}

function normalizeCountry(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : 'ZZ';
}

function normalizeCity(value) {
  return String(value == null ? '' : value).trim().toUpperCase().slice(0, 8);
}

// 带宽 + 延迟 的综合评分（0 ~ 100）
function scoreOf(speed, latency) {
  const bandwidth = Math.sqrt(clamp(speed, 0, SPEED_BENCH) / SPEED_BENCH);
  const delay = 1 - clamp((latency - LATENCY_FLOOR) / (LATENCY_CEIL - LATENCY_FLOOR), 0, 1);
  return Math.round((bandwidth * 50 + delay * 50) * 10) / 10;
}

function makeEntry(source) {
  const ip = normalizeHost(source.ip);
  const port = Number(source.port);
  if (!ip || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const speed = clampNumber(source.speed, 0, 100000);
  const tlsLatency = clampNumber(source.tls, 0, 100000);
  const tcpLatency = clampNumber(source.tcp, 0, 100000);
  const latency = tlsLatency || tcpLatency || LATENCY_CEIL;

  return {
    ip,
    port,
    speed,
    latency,
    tcpLatency,
    country: normalizeCountry(source.country),
    city: normalizeCity(source.city),
    tls: TLS_PORTS.has(port),
    score: scoreOf(speed, latency),
  };
}

const CSV_COLUMNS = {
  ip: /^(ip|地址|主机|host|server|node)$/i,
  port: /端口|port/i,
  speed: /速度|带宽|speed|mbps|rate/i,
  country: /归属国|国家|地区|country|region|geo/i,
  city: /机房|城市|city|datacenter|location/i,
  tcp: /tcp/i,
  tls: /tls|ssl|handshake|握手/i,
};

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function csvColumnIndexes(cells) {
  const map = {};
  cells.forEach((cell, index) => {
    const name = String(cell || '').trim();
    if (!name) return;
    for (const key of Object.keys(CSV_COLUMNS)) {
      if (map[key] === undefined && CSV_COLUMNS[key].test(name)) map[key] = index;
    }
  });
  return map;
}

function looksLikeCsvHeader(cells) {
  if (cells.length < 3) return false;
  return cells.some((cell) => CSV_COLUMNS.port.test(cell) || CSV_COLUMNS.speed.test(cell));
}

// result.csv：IP,cf-meta-ip,端口,速度(Mbps),CF归属国,机房,TCP延迟(ms),TLS延迟(ms)
function parseCsvRows(lines) {
  const entries = [];
  let indexes = { ip: 0, port: 2, speed: 3, country: 4, city: 5, tcp: 6, tls: 7 };
  let start = 0;

  if (lines.length) {
    const headerCells = splitCsvLine(lines[0]);
    if (looksLikeCsvHeader(headerCells)) {
      indexes = csvColumnIndexes(headerCells);
      if (indexes.ip === undefined) indexes.ip = 0;
      if (indexes.port === undefined) return entries;
      start = 1;
    }
  }

  for (let index = start; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    if (cells.length < 2) continue;
    const pick = (key) => (indexes[key] === undefined ? '' : cells[indexes[key]]);
    const entry = makeEntry({
      ip: pick('ip'),
      port: pick('port'),
      speed: pick('speed'),
      country: pick('country'),
      city: pick('city'),
      tcp: pick('tcp'),
      tls: pick('tls'),
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

// 兜底格式：1.2.3.4:443  /  1.2.3.4,443,12.5,88  /  host:8443#HK  /  [2400:cb00::1]:443
function parsePlainRows(lines) {
  const entries = [];
  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text || text.startsWith('#') || text.startsWith('//')) continue;
    if (/^(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\//i.test(text)) continue;

    let ip = '';
    let port = '';
    let rest = '';
    const bracketed = text.match(/^\[([0-9a-fA-F:]+)\][:,]\s*(\d{1,5})\b([\s\S]*)$/);
    if (bracketed) {
      [, ip, port, rest] = bracketed;
    } else {
      const plain = text.match(/^([0-9a-zA-Z.\-]+)[:,]\s*(\d{1,5})\b([\s\S]*)$/);
      if (!plain) continue;
      [, ip, port, rest] = plain;
    }

    const numbers = (rest.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const entry = makeEntry({
      ip,
      port,
      speed: numbers[0] || 0,
      country: (rest.match(/[#|,]\s*([A-Za-z]{2})\b/) || [])[1] || '',
      city: '',
      tcp: numbers[1] || 0,
      tls: '',
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseEntries(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (!lines.length) return [];
  const csvEntries = parseCsvRows(lines);
  if (csvEntries.length) return csvEntries;
  return parsePlainRows(lines);
}

function sourceCandidates(source) {
  const value = String(source || '').trim();
  if (!value) return [];

  const blob = value.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (blob) return [`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`, value];

  const repo = value.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)\/?$/i);
  if (repo) {
    const [, owner, name] = repo;
    return [
      `https://raw.githubusercontent.com/${owner}/${name}/main/result.csv`,
      `https://raw.githubusercontent.com/${owner}/${name}/master/result.csv`,
      `https://cdn.jsdelivr.net/gh/${owner}/${name}@main/result.csv`,
      `https://cdn.jsdelivr.net/gh/${owner}/${name}@master/result.csv`,
    ];
  }

  if (/^https?:\/\//i.test(value)) return [value];
  return [`https://${value.replace(/^\/+/, '')}`];
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; cf-node-sub/1.0)',
        accept: 'text/csv,text/plain,*/*',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadEntries() {
  const errors = [];
  for (const source of NODE_SOURCES) {
    for (const candidate of sourceCandidates(source)) {
      try {
        const text = await fetchText(candidate);
        const entries = parseEntries(text);
        if (entries.length) {
          lastSnapshot = { entries, sourceUrl: candidate, fetchedAt: Date.now(), cached: false };
          return lastSnapshot;
        }
        errors.push(candidate + '：没有解析到节点');
      } catch (error) {
        errors.push(candidate + '：' + ((error && error.message) || error));
      }
    }
  }
  if (lastSnapshot) return { ...lastSnapshot, cached: true, errors };
  throw new Error('节点数据获取失败，' + errors.join('；'));
}

function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return '🌐';
  return String.fromCodePoint(
    ...[...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65),
  );
}

function regionLabel(code) {
  return REGION_NAMES[code] || code;
}

function nodeName(entry, index) {
  const region = REGION_NAMES[entry.country] || entry.country;
  const city = CITY_NAMES[entry.city] || entry.city;
  return `${countryFlag(entry.country)} ${region}${city ? '·' + city : ''} ${index}`;
}

// 每个地区取评分最高的 PER_REGION 个；地区之间按该地区最高分排序
function selectNodes(entries, hostName, mode = 'c') {
  const unique = new Map();
  for (const entry of entries) {
    if (entry.latency > MAX_LATENCY) continue;
    const key = entry.ip + '|' + entry.port;
    const current = unique.get(key);
    if (!current || entry.score > current.score) unique.set(key, entry);
  }

  const buckets = new Map();
  for (const entry of unique.values()) {
    if (!HOT_REGIONS.has(entry.country)) continue;   // 冷门地区直接去掉
    if (!buckets.has(entry.country)) buckets.set(entry.country, []);
    buckets.get(entry.country).push(entry);
  }

  const regions = [];
  for (const [code, list] of buckets) {
    list.sort((a, b) => b.score - a.score || a.latency - b.latency);
    regions.push({
      code,
      name: regionLabel(code),
      flag: countryFlag(code),
      nodes: [],
      list: list.slice(0, PER_REGION),
    });
  }
  regions.sort((a, b) => b.list[0].score - a.list[0].score || b.list.length - a.list.length || a.code.localeCompare(b.code));

  const nodes = [];
  for (const region of regions) {
    region.list.forEach((entry, index) => {
      const node = {
        name: nodeName(entry, index + 1),
        server: entry.ip,
        port: entry.port,
        uuid: userID,
        host: hostName,
        path: WS_PATH + (mode === 'c' ? '' : '&mode=' + mode),
        tls: entry.tls,
        region: region.name,
        flag: region.flag,
        country: region.code,
        city: entry.city,
        speed: entry.speed,
        latency: entry.latency,
        score: entry.score,
      };
      region.nodes.push(node);
      nodes.push(node);
    });
  }

  const finalNodes = nodes.slice(0, MAX_NODES);

  // 保证订阅里至少有一个落在 100~200ms 的节点（其余节点仍按评分挑）
  const usedEndpoints = new Set(finalNodes.map((node) => node.server + '|' + node.port));
  const band = entries
    .filter((entry) => entry.latency >= TARGET_LATENCY_MIN && entry.latency <= TARGET_LATENCY_MAX && !usedEndpoints.has(entry.ip + '|' + entry.port))
    .sort((a, b) => b.score - a.score)[0];
  if (band) {
    finalNodes.push({
      name: '🎯 ' + Math.round(band.latency) + 'ms · ' + band.country,
      server: band.ip,
      port: band.port,
      uuid: userID,
      host: hostName,
      path: WS_PATH,
      tls: band.tls,
      region: '指定延迟',
      flag: '🎯',
      country: band.country,
      city: band.city,
      speed: band.speed,
      latency: band.latency,
      score: band.score,
    });
  }

  return { nodes: finalNodes, regions, total: entries.length };
}

// 自动优化线路：直接用部署域名连（CF 会把你带到最近的边缘节点），不依赖第三方优选 IP
function buildHostNodes(hostName) {
  if (!INCLUDE_HOST_NODES) return [];
  const ports = HOST_PORTS.map((port) => ({ port, tls: true }))
    .concat(HOST_PORTS_PLAIN.map((port) => ({ port, tls: false })));
  return ports.map(({ port, tls }, index) => ({
    name: '🇨🇳 本机优化 ' + (index + 1),
    server: hostName,
    port,
    uuid: userID,
    host: hostName,
    path: WS_PATH,
    tls,
    region: '本机优化',
    flag: '🇨🇳',
    country: 'CN',
    city: '',
    speed: 0,
    latency: 0,
    score: 0,
    hostNode: true,
  }));
}

// 0 号：旧项目里的 visa 优选域名（Cloudflare 托管的真实站点，按 SNI 路由到本 Worker）
function buildVisaNodes(hostName) {
  if (!INCLUDE_VISA_NODES) return [];
  return VISA_NODES.map(([server, port], index) => ({
    name: '0️⃣ visa优化 ' + (index + 1),
    server,
    port,
    uuid: userID,
    host: hostName,
    path: WS_PATH,
    tls: TLS_PORTS.has(port),
    region: 'visa优化',
    flag: '0️⃣',
    country: 'VISA',
    city: '',
    speed: 0,
    latency: 0,
    score: 0,
    visaNode: true,
  }));
}

// 优质代理节点：每条锁定一个国家/地区的一条固定出口（名字里带地区，方便一眼看出来）
async function buildPremiumNodes(hostName) {
  let pool = [];
  try {
    pool = await fetchPremiumPool();
  } catch (error) {
    pool = [];
  }
  const nodes = [];
  for (const item of pool) {
    if (nodes.length >= PREMIUM_LIMIT) break;
    const code = String(item.cc || '').toUpperCase();
    const region = REGION_NAMES[code] || code;
    nodes.push({
      name: countryFlag(code) + ' 代理-' + region + ' ' + (nodes.length + 1) + (item.rtt ? '·' + item.rtt + 'ms' : ''),
      server: hostName,
      port: 443,
      uuid: userID,
      host: hostName,
      path: WS_PATH + '&mode=proxy&px=' + encodeURIComponent(item.kind + '|' + item.addrs.join(',')),
      tls: true,
      region: '优质代理',
      flag: countryFlag(code),
      country: code,
      city: '',
      speed: 0,
      latency: 0,
      score: 0,
      group: 'proxy',
      premiumNode: true,
    });
  }
  return nodes;
}

async function buildContext(request, mode = 'relay') {
  const hostName = request.headers.get('Host') || new URL(request.url).host;

  let snapshot;
  try {
    snapshot = await loadEntries();
  } catch (error) {
    snapshot = { entries: [], sourceUrl: '', fetchedAt: Date.now(), cached: false, error: (error && error.message) || String(error) };
  }

  const selected = selectNodes(snapshot.entries, hostName, 'c');
  // 优化节点只保留最好的 5 个：本机域名的 TLS 端口优先（443/8443/2053/2083 + 8080）
  const allHost = buildHostNodes(hostName);
  const preferredPorts = [443, 8443, 2053, 2083, 8080];
  const optimized = preferredPorts
    .map((port) => allHost.find((node) => Number(node.port) === port))
    .filter(Boolean)
    .slice(0, 5);

  // 优化节点（本机域名/visa）：同一批节点派生出三种用途
  const relayOptimized = optimized.map((node, index) => ({
    ...node,
    name: '🔀 中转-优化 ' + (index + 1),
    path: WS_PATH + '&mode=relay',
    group: 'relay',
    relayNode: true,
  }));
  const directOptimized = optimized.map((node, index) => ({
    ...node,
    name: '🚀 直连-优化 ' + (index + 1),
    path: WS_PATH + '&mode=direct',
    group: 'direct',
    relayNode: false,
  }));
  const proxyOptimized = optimized.map((node, index) => ({
    ...node,
    name: '🛡 代理-优化 ' + (index + 1),
    path: WS_PATH + '&mode=proxy',
    group: 'proxy',
    relayNode: false,
  }));
  // 优质代理：只在「自动代理」组里追加，不改动上面 5 个代理-优化的行为
  const proxyPremium = await buildPremiumNodes(hostName);

  // 地区节点（优选 IP，热门地区每区最多 2 个）：同样派生「中转」和「直连」
  const relayRegionNodes = [];
  const directRegionNodes = [];
  for (const region of selected.regions) {
    region.nodes.forEach((entry, index) => {
      const suffix = region.nodes.length > 1 ? String(index + 1) : '';
      const baseName = REGION_NAMES[region.code] || region.name || region.code;
      relayRegionNodes.push({
        ...entry,
        name: countryFlag(region.code) + ' 中转-' + baseName + (suffix ? ' ' + suffix : ''),
        path: WS_PATH + '&mode=relay&rg=' + region.code,
        group: 'relay',
        relayNode: true,
        relayRegion: region.code,
      });
      directRegionNodes.push({
        ...entry,
        name: countryFlag(region.code) + ' 直连-' + baseName + (suffix ? ' ' + suffix : ''),
        path: WS_PATH + '&mode=direct',
        group: 'direct',
        relayNode: false,
      });
    });
  }

  const nodes = relayOptimized.concat(relayRegionNodes).concat(directOptimized).concat(directRegionNodes).concat(proxyOptimized).concat(proxyPremium);
  if (!nodes.length) throw new Error(snapshot.error || '没有可用节点');

  return {
    hostName,
    nodes,
    hostNodes: buildHostNodes(hostName),
    visaNodes: buildVisaNodes(hostName),
    relayNodes: relayOptimized.concat(relayRegionNodes),
    regions: selected.regions,
    unique: new Set(snapshot.entries.map((entry) => entry.ip + '|' + entry.port)).size,
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    expireAt: Math.floor(Date.now() / 1000) + EXPIRE_SECONDS,
    stale: Boolean(snapshot.cached),
    sourceError: snapshot.error || '',
  };
}

/* ==========================================================================
 * Clash 订阅（YAML）
 * ========================================================================== */

const CFW_BASE = `port: 7890
socks-port: 7891
allow-lan: true
bind-address: '*'
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  ipv6: false
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  # 节点域名必须走真实解析：它一旦进 fake-ip，Clash 就没法连自己的服务器
  fake-ip-filter:
    - '*.lan'
    - '*.local'
    - '__HOST__'
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - https://doh.pub/dns-query
  # 不写 fallback：境外 DoH（1.0.0.1 / dns.cloudflare.com）在国内会超时，
  # 一旦 fallback 被触发，节点域名就解析不出来（日志里 all DNS requests failed 就是这个）
`;

const CV_BASE = `mixed-port: 7890
allow-lan: true
bind-address: '*'
mode: rule
log-level: info
ipv6: false
tcp-concurrent: true
find-process-mode: strict
external-controller: 127.0.0.1:9090
profile:
  store-selected: true
  store-fake-ip: true
dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - '*.local'
    - localhost.ptlogin2.qq.com
    - '__HOST__'
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - 223.5.5.5
    - https://doh.pub/dns-query
  # 节点域名只用国内 DNS 解析，避免被墙的 DoH 拖死
  proxy-server-nameserver:
    - 223.5.5.5
    - 119.29.29.29
`;

const quoteYaml = (value) => JSON.stringify(String(value));

function yamlProxy(node, kind, fingerprint = false) {
  const trojan = kind === 'trojan';
  const lines = [
    '- name: ' + quoteYaml(node.name),
    '  type: ' + (trojan ? 'trojan' : 'vless'),
    '  server: ' + quoteYaml(node.server),
    '  port: ' + node.port,
    trojan ? '  password: ' + quoteYaml(TROJAN_PASSWORD) : '  uuid: ' + quoteYaml(node.uuid),
  ];
  lines.push('  udp: false');
  lines.push('  tls: ' + (node.tls ? 'true' : 'false'));
  if (node.tls) lines.push((trojan ? '  sni: ' : '  servername: ') + quoteYaml(node.host));
  // WebSocket 走 TLS 时必须只用 http/1.1：协商到 h2 时 Upgrade 会被拒，表现为节点连不上
  if (node.tls) lines.push('  alpn:', '    - http/1.1');
  // 新版 Mihomo 已移除顶层的 global-client-fingerprint，指纹必须写在节点上
  if (fingerprint) lines.push('  client-fingerprint: chrome');
  if (trojan) lines.push('  skip-cert-verify: false');
  lines.push('  network: ws');
  lines.push(
    '  ws-opts:',
    '    path: ' + quoteYaml(node.path),
    '    headers:',
    '      Host: ' + quoteYaml(node.host),
  );
  return lines.join('\n');
}



function yamlGroups(nodes, meta = false) {
  const pick = (group) => nodes.filter((node) => node.group === group);
  const build = (name, list, extra = []) => {
    if (!list.length) return null;
    return [
      '- name: ' + name,
      '  type: url-test',
      '  url: http://www.gstatic.com/generate_204',
      '  interval: 300',
      '  tolerance: 50',
      '  proxies:',
      ...list.map((node) => '    - ' + quoteYaml(node.name)),
    ].join('\n');
  };

  const relayList = pick('relay');
  const directList = pick('direct');
  const proxyList = pick('proxy');

  const groups = [];
  const menu = [];
  if (relayList.length) menu.push('    - 🔀 自动中转');
  if (directList.length) menu.push('    - 🚀 自动直连');
  if (proxyList.length) menu.push('    - 🛡 自动代理');
  menu.push('    - ' + (meta ? '不使用节点' : 'DIRECT'));

  groups.push([
    '- name: 🚀 节点选择',
    '  type: select',
    '  proxies:',
    ...menu,
    ...nodes.map((node) => "    - " + quoteYaml(node.name)),
  ].join('\n'));

  for (const [name, list] of [['🔀 自动中转', relayList], ['🚀 自动直连', directList], ['🛡 自动代理', proxyList]]) {
    const block = build(name, list);
    if (block) groups.push(block);
  }

  return 'proxy-groups:\n' + groups.join('\n');
}

function formatTime(timestamp) {
  const date = new Date(timestamp + 8 * 3600 * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC+8';
}

function formatShortTime(timestamp) {
  return new Date(timestamp + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

function formatTraffic(bytes) {
  const value = bytes / 1024 ** 4;
  return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + ' T';
}

function withUnifiedDelay(yaml, enabled) {
  if (!enabled) return yaml;
  return yaml.replace('log-level: info\n', 'log-level: info\nunified-delay: true\n');
}

function yamlDocument(context, kind, meta = false) {
  const { nodes, regions, sourceUrl, fetchedAt, stale } = context;
  const head = [
    '# Cloudflare Pages 自动生成 · ' + formatTime(fetchedAt),
    '# 数据源 ' + (sourceUrl || '-') + (stale ? '（上游暂时不可用，已使用上次成功的数据）' : (context.sourceError ? '（上游暂时不可用）' : '')),
    '# 节点 ' + nodes.length + ' 个（中转 ' + nodes.filter((n) => n.group === 'relay').length + ' / 直连 ' + nodes.filter((n) => n.group === 'direct').length + ' / 代理 ' + nodes.filter((n) => n.group === 'proxy').length + '）· 地区 ' + regions.length + ' 个 · 每地区最多 ' + PER_REGION + ' 个',
    '# 排序依据：带宽 + 延迟综合评分，同地区只保留评分最高的几个',
    '# 订阅流量 ' + formatTraffic(TRAFFIC_USED_BYTES) + ' / ' + formatTraffic(TRAFFIC_TOTAL_BYTES) +
      ' · 到期 ' + formatTime(context.expireAt * 1000),
    '# 协议 ' + (kind === 'trojan' ? 'Trojan + WS + TLS（CFW / Verge 都可用）' : 'VLESS + WS + TLS（Clash Verge / Mihomo）'),
    '',
  ];

  const rules = [
    'rules:',
    '  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    '  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    '  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    '  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,🚀 节点选择',
  ];

  // fake-ip 会把「节点自己的域名」也解析成 198.18.x，导致域名型节点永远连不上；
  // 这里把所有域名型节点（visa、自动优化线路等）统统加进白名单
  const domainServers = Array.from(new Set(
    nodes.map((node) => String(node.server)).filter((server) => /[a-z]/i.test(server)),
  ));
  const fakeIpFilter = [context.hostName]
    .concat(domainServers.filter((server) => server !== context.hostName))
    .map((item) => "    - '" + item + "'")
    .join('\n');
  const baseText = withUnifiedDelay(meta || kind === 'vless' ? CV_BASE : CFW_BASE, context.unifiedDelay)
    .replace(/^ {4}- '__HOST__'$/m, fakeIpFilter)
    .replace(/__HOST__/g, context.hostName);

  const useMeta = meta || kind === 'vless';
  // Mihomo 支持 type: direct，可以给"直连"起一个中文名；老内核只能用内置的 DIRECT
  const directProxy = useMeta ? ['- name: 不使用节点', '  type: direct'].join('\n') : null;

  return head.concat([
    baseText,
    '',
    'proxies:',
    ...(directProxy ? [directProxy] : []),
    nodes.map((node) => yamlProxy(node, kind, useMeta)).join('\n\n'),
    '',
    yamlGroups(nodes, useMeta),
    '',
  ], rules).join('\n') + '\n';
}

async function handleSubscription(request, kind, mode = 'relay') {
  const context = await buildContext(request, mode);
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') || '';
  // Meta 内核支持 unified-delay（延迟显示会扣掉握手），老内核不支持
  context.unifiedDelay = url.searchParams.get('unified') !== '0';
  const meta = url.searchParams.has('meta')
    ? url.searchParams.get('meta') !== '0'
    : /mihomo|clash[-_ ]?verge|clash[-_. ]?meta|clashx|stash|flclash|meta/i.test(ua);
  const body = yamlDocument(context, kind, meta);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/yaml; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      // 客户端里显示的配置名：Trojan-cfn114.sdfwq.cc.cd
      'content-disposition': 'attachment; filename="' + (kind === 'trojan' ? 'Trojan' : 'VLESS') + '-' + context.hostName + '.yaml"',
      // 告诉客户端多久自动更新一次订阅（mihomo / Clash Verge 支持，单位小时）
      'profile-update-interval': String(UPDATE_INTERVAL_HOURS),
      'profile-web-page-url': 'https://' + context.hostName + '/' + PASSWORD + '/',
      // 客户端显示的流量与到期时间（Stash / Clash Verge / Shadowrocket 等会读取）
      'subscription-userinfo':
        'upload=0; download=' + TRAFFIC_USED_BYTES +
        '; total=' + TRAFFIC_TOTAL_BYTES + '; expire=' + context.expireAt,
      'x-node-count': String(context.nodes.length),
      'x-region-count': String(context.regions.length),
      'x-generated-at': new Date().toISOString(),
    },
  });
}

/* ==========================================================================
 * 面板
 * ========================================================================== */

const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

const PAGE_CSS = `
:root{
  --bg:#fbfbfa;--fg:#1b1b1a;--dim:#75756f;--line:#e6e5e0;--fill:#f1f0ea;
  --ink:#1b1b1a;--inkfg:#fbfbfa;--shadow:0 10px 26px rgba(24,24,20,.10);
}
@media (prefers-color-scheme:dark){
  :root{--bg:#111110;--fg:#e7e7e3;--dim:#8b8b84;--line:#282826;--fill:#1a1a19;
    --ink:#e7e7e3;--inkfg:#111110;--shadow:0 10px 26px rgba(0,0,0,.55);}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:34px 20px 76px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.92em}
header{display:flex;align-items:baseline;gap:10px}
h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
.ver{font-size:11.5px;color:var(--dim);letter-spacing:.04em}
.host{margin:6px 0 0;font-size:12.5px;color:var(--dim);word-break:break-all}
section{margin-top:32px}
h2{margin:0 0 8px;font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.16em}
.rows{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:7px 10px;padding:12px 0;border-bottom:1px solid var(--line)}
.meta{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.name{font-size:14px;font-weight:500;line-height:1.35}
.tag{flex:none;font-size:11px;line-height:16px;padding:0 5px;color:var(--dim);border:1px solid var(--line);border-radius:4px}
.act{display:flex;gap:6px;justify-self:end;flex-wrap:wrap;justify-content:flex-end}
.val{grid-column:1/-1;min-width:0;color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.val a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.flag{display:inline-flex;align-items:center;justify-content:center;width:20px;flex:none;font-size:14px;line-height:1;
  font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}
.btn{display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:12.5px;line-height:1;
  padding:7px 11px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);
  cursor:pointer;text-decoration:none;white-space:nowrap;user-select:none}
.btn:hover{border-color:var(--dim)}
.btn:active{transform:translateY(.5px)}
.btn.solid{background:var(--ink);border-color:var(--ink);color:var(--inkfg)}
.btn.solid:hover{opacity:.86;border-color:var(--ink)}
.fold>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--dim);padding:10px 0}
.fold>summary::-webkit-details-marker{display:none}
.fold>summary:hover{color:var(--fg)}
.fold>summary::after{content:"\\25BE";font-size:9px;line-height:1;transition:transform .15s}
.fold[open]>summary::after{transform:rotate(180deg)}
.kv{width:100%;border-collapse:collapse;font-size:12.5px;margin:2px 0 0}
.kv th{text-align:left;font-weight:500;color:var(--dim);padding:7px 8px 7px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.kv td{padding:7px 0;border-bottom:1px solid var(--line);word-break:break-all}
.kv td.num{text-align:right;color:var(--dim);white-space:nowrap;padding-left:8px}
.note{font-size:13px;line-height:1.8;color:var(--dim)}
.note p{margin:0}
.hint{margin:14px 0 0;font-size:12px;line-height:1.7;color:var(--dim)}
.hint a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line)}
.stat{margin:10px 0 0;font-size:12px;color:var(--dim);display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
@media (max-width:430px){
  .row{gap:6px 8px}
  .btn{padding:6px 9px}
  .act{grid-column:1/-1;justify-self:start}
}
`;

const PAGE_JS = `(function () {
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var text = button.getAttribute('data-copy') || '';
    var label = button.textContent;
    var timer = null;
    function done(message) {
      button.textContent = message;
      clearTimeout(timer);
      timer = setTimeout(function () { button.textContent = label; }, 1400);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done('已复制'); }, function () {
        done(fallbackCopy(text) ? '已复制' : '复制失败');
      });
    } else {
      done(fallbackCopy(text) ? '已复制' : '复制失败');
    }
  });
})();`;

// 统一页面外壳：面板与所有下载页共用同一套 <head>/<header>/<main> 结构
function pageShell({ heading, title, version = '', body, script = '' }) {
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<meta name="robots" content="noindex,nofollow">\n' +
    '<title>' + escapeHtml(title || heading) + '</title>\n' +
    '<style>' + PAGE_CSS + '</style>\n</head>\n<body>\n<main>\n  <header>\n' +
    '    <h1>' + escapeHtml(heading) + '</h1>\n' +
    (version ? '    <span class="ver">' + escapeHtml(version) + '</span>\n' : '') +
    '  </header>\n' +
    body +
    '\n</main>\n' + (script ? '<script>' + script + '</script>\n' : '') + '</body>\n</html>';
}

function renderPanel(context) {
  const { hostName, nodes, hostNodes, visaNodes, regions, total, unique, sourceUrl, fetchedAt, expireAt, stale, sourceError } = context;
  const base = 'https://' + hostName + '/' + PASSWORD;
  const sub = {
    trojan: base + '/trojan',
    vless: base + '/vless',
  };
  const clashImport = (url) => 'clash://install-config?url=' + encodeURIComponent(url);

  const subRow = (title, protocol, url) => `        <div class="row">
          <div class="meta"><span class="name">${escapeHtml(title)}</span><span class="tag">${escapeHtml(protocol)}</span><span class="tag">${nodes.length} 个节点</span><span class="tag">${UPDATE_INTERVAL_HOURS}h 自动更新</span></div>
          <div class="act"><a class="btn solid" href="${escapeHtml(clashImport(url))}">打开 Clash 导入</a><button class="btn" type="button" data-copy="${escapeHtml(url)}">复制订阅链接</button></div>
          <div class="val mono"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>
        </div>`;

  const regionRows = regions.map((region) => {
    const best = region.nodes[0];
    return `        <div class="row">
          <div class="meta"><span class="flag">${escapeHtml(region.flag)}</span><span class="name">${escapeHtml(region.name)}</span><span class="tag">${escapeHtml(region.code)}</span></div>
          <span class="tag">${region.nodes.length} 个 · ${best.latency.toFixed(0)}ms · ${best.speed.toFixed(1)}Mbps</span>
          <div class="val">${escapeHtml(region.nodes.map((node) => node.name).join(' / '))}</div>
        </div>`;
  }).join('\n');

  const nodeRows = nodes.filter((node) => !node.hostNode && !node.visaNode).map((node) => `        <tr>
          <td>${escapeHtml(node.name)}</td>
          <td class="num">${node.latency.toFixed(0)}ms</td>
          <td class="num">${node.speed.toFixed(1)}M</td>
          <td class="num">${node.score.toFixed(0)}</td>
        </tr>`).join('\n');

  const regionSection = regions.length ? `
  <section>
    <h2>地区 · 每区 ${PER_REGION} 个</h2>
    <div class="rows">
${regionRows}
    </div>
    <details class="fold">
      <summary>全部 ${nodes.length - (hostNodes || []).length - (visaNodes || []).length} 个优选节点（延迟 / 带宽 / 评分）</summary>
      <table class="kv">
        <tr><th>节点</th><th>延迟</th><th>带宽</th><th>评分</th></tr>
${nodeRows}
      </table>
    </details>
  </section>` : `
  <section>
    <h2>地区</h2>
    <p class="hint">数据源暂时不可用${sourceError ? '（' + escapeHtml(sourceError) + '）' : ''}，本次只有本机入口节点可用。</p>
  </section>`;

  const notes = [
    '每次打开或刷新页面、每次客户端更新订阅，都会重新抓取数据源并重新挑选节点，不做任何缓存（上游失败时才会退回上一次成功的数据）。',
    '评分 = 带宽 50% + 延迟 50%；同一地区只保留评分最高的 ' + PER_REGION + ' 个，整个订阅最多 ' + MAX_NODES + ' 个。',
    '两种协议共用同一批节点：/cfw（Trojan，CFW 与 Verge 老内核都支持）、/cv（VLESS，Clash Verge / Mihomo）。',
    '访问 x.com / twitter.com 这类 Cloudflare 托管站点时会自动改走 proxyip 中转（Worker 的 connect() 不允许直连 CF 自己的 IP）；普通站点仍然直连，不绕路。内置 proxyip 都是第三方公共中转，失效属常态。',
    '「🛡 代理-地区」每个国家锁一条固定出口（v1.0.7 新增，最多 12 个），名字带生成配置时的实测耗时；连接时会并发抢几条，全失败才回落到免费池。',
    '当前 Worker 同时是代理服务端，UUID 与面板密码都写死在代码里；转发落地依赖 Worker 的 NAT64 出口，无需设置 ProxyIP。',
    '订阅响应带 profile-update-interval = ' + UPDATE_INTERVAL_HOURS + ' 小时，Clash Verge / mihomo 会按这个间隔自动更新；Clash for Windows 需要在「订阅」设置里自己填更新间隔。',
    '客户端显示的「已用 ' + formatTraffic(TRAFFIC_USED_BYTES) + ' / 总量 ' + formatTraffic(TRAFFIC_TOTAL_BYTES) + '」「到期 24 小时后」来自 subscription-userinfo 响应头，每次刷新都会顺延到新的 24 小时，纯展示用，不影响节点使用。',
    '节点 IP 来自第三方扫描结果，可用性会随时间变化；连不上时换同地区另一个节点即可。',
    '订阅里还附带 🇨🇳 本机优化节点（面板展示用，订阅里以 中转-优化 / 直连-优化 / 代理-优化 出现），直接用部署域名连接；如果只有它们能用、地区节点全超时，说明是数据源里的优选 IP 失效，不是 Worker 的问题。',
  ].map((line) => `<p>${escapeHtml(line)}</p>`).join('\n        ');

  return pageShell({
    heading: '免费节点订阅',
    title: '免费节点订阅 · ' + hostName,
    version: PAGE_VERSION,
    script: PAGE_JS,
    body: `
  <p class="host mono">${escapeHtml(hostName)}</p>
  <div class="stat">
    <span>数据 ${formatTime(fetchedAt)}</span><span>·</span>
    <span>${total} 条记录 / ${unique} 个地址</span><span>·</span>
    <span>${regions.length} 个地区 / ${nodes.length} 个节点</span><span>·</span>
    <span>流量 ${formatTraffic(TRAFFIC_USED_BYTES)} / ${formatTraffic(TRAFFIC_TOTAL_BYTES)}</span><span>·</span>
    <span>到期 ${formatShortTime(expireAt * 1000)}（24 小时）</span>${stale ? '<span>·</span><span>⚠️ 上游暂时不可用，正在使用上次的数据</span>' : ''}
  </div>

  <section>
    <h2>订阅</h2>
    <div class="rows">
${subRow('Trojan（CFW / Verge 都支持）', 'Trojan · WS + TLS', sub.trojan)}
${subRow('VLESS（Clash Verge / Mihomo）', 'VLESS · WS + TLS', sub.vless)}
    </div>
    <p class="hint">「打开 Clash 导入」会直接唤起已经安装的 Clash 客户端；没有反应时先点「复制订阅链接」，再到客户端里粘贴订阅地址。</p>
    <div class="row">
      <div class="meta"><span class="name">还没有客户端？</span><span class="tag">FlClash · Clash Meta · Clash Verge</span></div>
      <div class="act"><a class="btn solid" href="${base}/download">下载客户端</a></div>
    </div>
  </section>

${regionSection}

  <section>
    <h2>说明</h2>
    <div class="note">
        ${notes}
    </div>
    <p class="hint"><a href="${base}/selftest" target="_blank" rel="noopener">连接自检</a>（JSON）：检查这个 Worker 能否用 connect() 出网、NAT64 是否可用 —— 节点全都连不上时先看它。</p>
    <details class="fold">
      <summary>手动配置参数</summary>
      <table class="kv">
        <tr><th>地址</th><td>下面订阅里的优选 IP（也可用自定义域名）</td></tr>
        <tr><th>端口</th><td class="mono">443 / 8443 / 2053 / 2083 / 2087 / 2096</td></tr>
        <tr><th>UUID</th><td class="mono">${escapeHtml(userID)}</td></tr>
        <tr><th>传输</th><td>ws / websocket</td></tr>
        <tr><th>Host</th><td class="mono">${escapeHtml(hostName)}</td></tr>
        <tr><th>路径</th><td class="mono">${escapeHtml(WS_PATH)}</td></tr>
        <tr><th>TLS</th><td>开启，SNI = ${escapeHtml(hostName)}</td></tr>
        <tr><th>数据源</th><td class="mono">${escapeHtml(sourceUrl || '-')}</td></tr>
      </table>
    </details>
  </section>
`,
  });
}

// ---------------- 客户端下载页（FlClash / Meta / Verge） ----------------
const CLIENTS = {
  flclash: {
    key: 'flclash',
    title: 'FlClash',
    repo: 'chen08209/FlClash',
    desc: 'Windows / macOS / Linux / Android，界面简洁，支持 Clash 订阅',
  },
  meta: {
    key: 'meta',
    title: 'Clash Meta for Android',
    repo: 'MetaCubeX/ClashMetaForAndroid',
    desc: '仅 Android，Mihomo 内核，功能最全',
  },
  verge: {
    key: 'verge',
    title: 'Clash Verge Rev',
    repo: 'clash-verge-rev/clash-verge-rev',
    desc: 'Windows / macOS / Linux 桌面客户端，Mihomo 内核',
  },
};
const CLIENT_ORDER = ['flclash', 'meta', 'verge'];
const RELEASE_CACHE = new Map();
const RELEASE_TTL = 10 * 60 * 1000;
const KEEP_EXT = ['.apk', '.exe', '.msi', '.zip', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.tar.gz'];
const SKIP_EXT_RE = /\.sig$|\.blockmap$|\.json$|\.ya?ml$|\.txt$/;

function keepAsset(name) {
  const lower = name.toLowerCase();
  if (SKIP_EXT_RE.test(lower)) return false;
  return KEEP_EXT.some((ext) => lower.endsWith(ext));
}

async function loadRelease(client) {
  const cached = RELEASE_CACHE.get(client.key);
  if (cached && cached.data && Date.now() - cached.at < RELEASE_TTL) return cached;
  const now = Date.now();
  const entry = { at: now, data: null, error: '' };
  try {
    const res = await fetch('https://api.github.com/repos/' + client.repo + '/releases/latest', {
      headers: { 'user-agent': 'cfnode-worker', accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
    const json = await res.json();
    entry.data = {
      tag: json.tag_name || '',
      name: json.name || json.tag_name || '',
      published: json.published_at || '',
      htmlUrl: json.html_url || ('https://github.com/' + client.repo + '/releases/latest'),
      assets: (json.assets || [])
        .filter((a) => keepAsset(a.name))
        .map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url, dl: a.download_count || 0 })),
    };
  } catch (error) {
    entry.error = (error && error.message) || String(error);
    try {
      const fallback = await loadReleaseViaHtml(client);
      if (fallback.assets.length) {
        await fillSizes(fallback.assets);
        entry.data = fallback;
        entry.error = '';
      }
    } catch (fallbackError) {
      entry.error += ' / HTML 回退失败：' + ((fallbackError && fallbackError.message) || fallbackError);
    }
  }
  RELEASE_CACHE.set(client.key, entry);
  return entry;
}

function parseHumanSize(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB|Bytes?|B)/i);
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'GB') return Math.round(value * 1024 * 1024 * 1024);
  if (unit === 'MB') return Math.round(value * 1024 * 1024);
  if (unit === 'KB') return Math.round(value * 1024);
  return Math.round(value);
}

async function fillSizes(assets) {
  const targets = assets.filter((a) => !a.size).slice(0, 24);
  if (!targets.length) return;
  await Promise.all(targets.map(async (a) => {
    try {
      const res = await fetch(a.url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': 'cfnode-worker' } });
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 0) a.size = len;
    } catch (error) {}
  }));
}

async function loadReleaseViaHtml(client) {
  const latest = await fetch('https://github.com/' + client.repo + '/releases/latest', {
    redirect: 'manual',
    headers: { 'user-agent': 'cfnode-worker' },
  });
  const location = latest.headers.get('location') || '';
  const tag = location.split('/tag/')[1] || '';
  if (!tag) throw new Error('拿不到 latest tag');
  const res = await fetch('https://github.com/' + client.repo + '/releases/expanded_assets/' + tag, {
    headers: { 'user-agent': 'cfnode-worker' },
  });
  if (!res.ok) throw new Error('expanded_assets HTTP ' + res.status);
  const html = await res.text();
  const assets = [];
  const re = /href="(\/[^"]+\/releases\/download\/[^"]+)"[\s\S]{0,240}?<span class="text-bold">([^<]+)<\/span>/g;
  let match;
  while ((match = re.exec(html))) {
    const href = match[1];
    const name = match[2].trim();
    if (!keepAsset(name)) continue;
    const tail = html.slice(match.index, match.index + 260);
    const parsed = parseHumanSize(tail);
    assets.push({
      name,
      size: parsed >= 1024 && parsed <= 4 * 1024 * 1024 * 1024 ? parsed : 0,
      url: 'https://github.com' + href,
      dl: 0,
    });
  }
  return {
    tag,
    name: tag,
    published: '',
    htmlUrl: 'https://github.com/' + client.repo + '/releases/tag/' + tag,
    assets,
  };
}

function platformOf(name) {
  const n = name.toLowerCase();
  if (n.includes('android') || n.endsWith('.apk')) return 'Android';
  if (n.includes('windows') || /\.(exe|msi)$/.test(n) || n.includes('win')) return 'Windows';
  if (n.includes('macos') || n.includes('darwin') || /\.(dmg|pkg)$/.test(n) || n.includes('aarch64.app')) return 'macOS';
  if (n.includes('linux') || /\.(deb|rpm|appimage)$/.test(n)) return 'Linux';
  return '其他';
}

function humanSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function handleDownloadIndex(request) {
  const url = new URL(request.url);
  const base = url.origin + '/' + PASSWORD;

  const cards = CLIENT_ORDER.map((key) => {
    const c = CLIENTS[key];
    const platforms = key === 'meta' ? 'Android' : (key === 'flclash' ? 'Windows / macOS / Linux / Android' : 'Windows / macOS / Linux');
    return '    <div class="row">\n' +
      '      <div class="meta"><span class="name">' + escapeHtml(c.title) + '</span>' +
      '<span class="tag">' + escapeHtml(platforms) + '</span></div>\n' +
      '      <div class="act"><a class="btn solid" href="' + escapeHtml(base) + '/download/' + key + '">查看安装包</a></div>\n' +
      '      <div class="val">' + escapeHtml(c.desc) + '</div>\n' +
      '    </div>';
  });

  const html = pageShell({
    heading: '客户端下载',
    title: '客户端下载',
    version: '3 个客户端',
    body:
      '  <div class="act" style="margin:0 0 14px"><a class="btn" href="' + escapeHtml(base) + '/">← 返回面板</a></div>\n' +
      '  <section>\n    <h2>选择客户端</h2>\n    <div class="rows">\n' + cards.join('\n') + '\n    </div>\n  </section>\n' +
      '  <p class="hint">安装包均由本 Worker 实时读取官方 GitHub 发布页；「通过本站下载」由 Worker 中转，适合 GitHub 直连较慢的网络。</p>',
  });

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleDownloadPage(request, clientKey) {
  const client = CLIENTS[clientKey] || CLIENTS.flclash;
  const url = new URL(request.url);
  const base = url.origin + '/' + PASSWORD;
  const cached = await loadRelease(client);
  const data = cached.data;
  const total = data ? data.assets.length : 0;

  const groups = ['Windows', 'macOS', 'Linux', 'Android', '其他'];
  const sections = [];
  if (total) {
    const bucket = new Map(groups.map((g) => [g, []]));
    for (const a of data.assets) bucket.get(platformOf(a.name)).push(a);
    for (const g of groups) {
      const list = bucket.get(g);
      if (!list.length) continue;
      const rows = list.map((a) => {
        const viaWorker = base + '/dl?u=' + encodeURIComponent(a.url);
        const size = humanSize(a.size);
        const tags = (size ? '<span class="tag">' + escapeHtml(size) + '</span>' : '') +
          (a.dl ? '<span class="tag">下载 ' + a.dl + ' 次</span>' : '');
        return '      <div class="row">\n' +
          '        <div class="meta"><span class="name">' + escapeHtml(a.name) + '</span>' + tags + '</div>\n' +
          '        <div class="act"><a class="btn solid" href="' + escapeHtml(viaWorker) + '">通过本站下载</a>' +
          '<a class="btn" href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener">GitHub 直链</a></div>\n' +
          '      </div>';
      });
      sections.push('  <section>\n    <h2>' + escapeHtml(g) + ' · ' + list.length + ' 个文件</h2>\n    <div class="rows">\n' +
        rows.join('\n') + '\n    </div>\n  </section>');
    }
  }

  const meta = data
    ? '版本 <b>' + escapeHtml(data.tag || data.name) + '</b>' +
      (data.published ? ' · 发布于 ' + escapeHtml(data.published.slice(0, 10)) : '') +
      ' · 共 ' + total + ' 个文件'
    : '暂时读取失败（' + escapeHtml(cached.error || '未知原因') + '）';
  const releasesUrl = data ? data.htmlUrl : 'https://github.com/' + client.repo + '/releases/latest';

  const others = CLIENT_ORDER.filter((k) => k !== client.key)
    .map((k) => '<a class="btn" href="' + escapeHtml(base) + '/download/' + k + '">' + escapeHtml(CLIENTS[k].title) + '</a>')
    .join('');

  const body = total
    ? sections.join('\n')
    : '  <section><p class="hint">没有取到发布文件列表，可以直接到 <a href="' + escapeHtml(releasesUrl) + '" target="_blank" rel="noopener">GitHub 发布页</a> 下载。</p></section>';

  const html = pageShell({
    heading: client.title + ' 下载',
    title: client.title + ' 下载',
    version: data ? (data.tag || '') : '',
    body:
      '  <div class="act" style="margin:0 0 14px;flex-wrap:wrap">' +
      '<a class="btn" href="' + escapeHtml(base) + '/">← 返回面板</a>' +
      others +
      '<a class="btn" href="' + escapeHtml(releasesUrl) + '" target="_blank" rel="noopener">GitHub 发布页</a></div>\n' +
      '  <p class="hint">' + escapeHtml(client.desc) + ' · ' + meta + '</p>\n' +
      body +
      '\n  <p class="hint" style="margin-top:16px">「通过本站下载」由本 Worker 中转 GitHub 上的官方安装包，适合 GitHub 直连较慢的网络；文件较大会持续传输，请耐心等待。</p>',
  });

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleDownloadProxy(url) {
  const target = url.searchParams.get('u') || '';
  // 只允许三个客户端官方仓库的 release 资源
  const allowed = /^https:\/\/github\.com\/(chen08209\/FlClash|MetaCubeX\/ClashMetaForAndroid|clash-verge-rev\/clash-verge-rev)\/releases\/download\//i.test(target);
  if (!allowed) return new Response('只允许下载官方客户端安装包', { status: 400 });
  try {
    const res = await fetch(target, { headers: { 'user-agent': 'cfnode-worker' }, redirect: 'follow' });
    if (!res.ok) return new Response('下载失败：GitHub 返回 ' + res.status, { status: 502 });
    let name = 'download';
    try {
      name = decodeURIComponent(new URL(target).pathname.split('/').pop() || 'download');
    } catch (error) {}
    const headers = new Headers(res.headers);
    headers.set('content-disposition', 'attachment; filename="' + name.replace(/["\\]/g, '') + '"');
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: 200, headers });
  } catch (error) {
    return new Response('下载失败：' + ((error && error.message) || error), { status: 502 });
  }
}

async function handleSelftest(request) {
  const hostName = request.headers.get('Host') || new URL(request.url).host;
  const checks = {};

  try {
    const probe = new ReadableStream({ start() {} });
    if (probe && typeof probe.cancel === 'function') probe.cancel().catch(() => {});
    checks.streamConstructors = 'ok（本文件不依赖它，仅供参考）';
  } catch (error) {
    checks.streamConstructors = 'blocked: ' + ((error && error.message) || error);
  }

  // 真连一次并收发数据：connect() 返回只是「拿到 socket」，握手要等第一次写
  async function probeTcp(hostname, port) {
    const label = 'tcp ' + hostname + ':' + port;
    const started = Date.now();
    let socket = null;
    try {
      socket = await connectWithTimeout({ hostname, port }, 8000);
      const writer = socket.writable.getWriter();
      await writer.write(textEncoder.encode('GET / HTTP/1.1\r\nHost: ' + hostname + '\r\nConnection: close\r\n\r\n'));
      writer.releaseLock();
      const reader = socket.readable.getReader();
      const race = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 6000)),
      ]);
      try { reader.releaseLock(); } catch (error) {}
      if (race && race.timeout) {
        checks[label] = 'fail: 读超时';
      } else if (race && race.value) {
        const head = new TextDecoder().decode(toBytes(race.value)).split('\r\n')[0];
        checks[label] = 'ok ' + (Date.now() - started) + 'ms 「' + head.slice(0, 40) + '」';
      } else {
        checks[label] = 'fail: 连接被关闭（没有返回数据）';
      }
    } catch (error) {
      checks[label] = 'fail: ' + ((error && error.message) || error);
    } finally {
      closeSocket(socket);
    }
  }

  // 故意选非 Cloudflare 的目标：Worker 的 connect() 不允许连 Cloudflare 自己的 IP
  const httpCount = httpProxyCache.list.length;
  const socksCount = (httpProxyCache.socks || []).length;
  checks.proxyList = (httpCount || socksCount)
    ? 'ok http ' + httpCount + ' / socks5 ' + socksCount + '（' + (httpProxyCache.geo ? '带地区，按就近排序' : '纯列表') + '，已缓存）'
    : '（尚未加载，首次访问需走代理的站点时才拉取）';

  await probeTcp('www.baidu.com', 80);
  await probeTcp('www.qq.com', 80);

  const failed = Object.values(checks).filter((value) => String(value).startsWith('fail')).length;
  return new Response(JSON.stringify({
    ok: failed === 0,
    host: hostName,
    uuid: userID,
    wsPath: WS_PATH,
    passwordPath: '/' + PASSWORD + '/',
    nodeMode: '每次请求重新生成（无缓存）',
    checks,
  }, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
async function handlePanel(request) {
  const context = await buildContext(request);
  return new Response(renderPanel(context), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-node-count': String(context.nodes.length),
    },
  });
}
