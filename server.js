/**
 * 🐸 Frogger 排行榜服务 —— 生产部署版
 *
 * 与本地开发版的差异：
 *   1. 端口从环境变量 PORT 读取（云平台会动态分配），不再是写死 8848
 *   2. 数据目录从环境变量 DATA_DIR 读取，支持云平台的临时磁盘
 *   3. 监听 0.0.0.0 而非 localhost，否则容器外无法访问
 *   4. 新增 /api/health 健康检查端点（云平台探活用）
 *   5. 新增请求频率限制，防止被人恶意刷榜
 *   6. 写文件加锁，防止并发写入互相覆盖
 *   7. 保留完整 CORS 头，Web 导出的游戏跨域访问必需
 *
 * 本地运行：node server.js
 * 部署到 Render/Railway/Fly.io：直接上传整个文件夹即可
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────
// 配置（全部支持环境变量覆盖）
// ─────────────────────────────────────────────────────────────

/** 监听端口。云平台通常注入 PORT，本地默认 8848 */
const PORT = Number(process.env.PORT) || 8848;

/**
 * 监听地址。
 *
 * ★ 默认用 '::' 而不是 '0.0.0.0' ★
 * 原因：macOS/Windows 上 `localhost` 会同时解析出 IPv6 的 `::1` 和 IPv4 的
 * `127.0.0.1`，且 IPv6 排在前面。Godot 的 HTTPClient 拿到 `::1` 后
 * **不会回退到 IPv4**，直接连接失败 —— 表现为「浏览器能打开、游戏却连不上」。
 * 监听 `::`（双栈）可以同时接受 IPv4 和 IPv6 连接，一次解决。
 *
 * 云平台（Render/Railway）注入的是 IPv4 地址，用 `::` 双栈同样能接。
 * 需要强制 IPv4 时设环境变量 HOST=0.0.0.0。
 */
const HOST = process.env.HOST || '::';

/** 数据目录。Render 的磁盘挂载点是 /data，本地默认 ./data */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

/** 数据文件完整路径 */
const DATA_FILE = path.join(DATA_DIR, 'players.json');

/** 静态网页目录 */
const PUBLIC_DIR = path.join(__dirname, 'public');

/** 名字最长字符数 */
const MAX_NAME_LENGTH = 16;

/** 单次请求体上限（字节），防止超大 body 打满内存 */
const MAX_BODY_BYTES = 8 * 1024;

/** 榜单最多返回条数 */
const MAX_BOARD_ENTRIES = 500;

/**
 * 提交频率限制：同一 IP 在 RATE_WINDOW_MS 内最多提交 RATE_LIMIT_MAX 次。
 * 防止有人写脚本刷榜，把正常玩家的记录顶掉。
 */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

// ─────────────────────────────────────────────────────────────
// 计分规则（必须与 Godot 端 leaderboard_service.gd 的 compute_score 一致）
// ─────────────────────────────────────────────────────────────

const SCORE_PER_LEVEL = 1000;
const PAR_TIME_PER_LEVEL = 15.0;
const TIME_BONUS_PER_SECOND = 40;

/**
 * 计算一局得分。
 * @param {number} levelCount 通过的关卡数
 * @param {number} totalSeconds 本局总耗时（秒）
 * @returns {number}
 */
function computeScore(levelCount, totalSeconds) {
  if (!Number.isFinite(levelCount) || levelCount <= 0) return 0;
  const base = levelCount * SCORE_PER_LEVEL;
  const parTime = levelCount * PAR_TIME_PER_LEVEL;
  const timeBonus = Math.max(0, parTime - totalSeconds) * TIME_BONUS_PER_SECOND;
  return Math.round(base + timeBonus);
}

// ─────────────────────────────────────────────────────────────
// 数据读写（带锁，防止并发覆盖）
// ─────────────────────────────────────────────────────────────

/** 写锁标志。Node 单线程，同一时刻只允许一个写操作 */
let writeLock = false;

/** 确保数据目录存在 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[data] 已创建数据目录: ${DATA_DIR}`);
  }
}

/** 读取全部玩家记录 */
function loadPlayers() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.players) ? parsed.players : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[data] 读取失败:', err.message);
    }
    return [];
  }
}

/** 原子写入：先写临时文件再改名 */
function savePlayers(players) {
  if (writeLock) {
    console.warn('[data] 写锁被占用，跳过本次写入');
    return false;
  }
  writeLock = true;
  try {
    ensureDataDir();
    const payload = JSON.stringify({ players }, null, 2);
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
    return true;
  } catch (err) {
    console.error('[data] 写入失败:', err.message);
    return false;
  } finally {
    writeLock = false;
  }
}

/** 排序：分数降序 → 关卡多者优先 → 用时短者优先 → 名字字典序兜底 */
function sortPlayers(players) {
  return players.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.level !== a.level) return b.level - a.level;
    if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
    return a.name.localeCompare(b.name);
  });
}

/** 附加名次序号 */
function buildBoard(players) {
  return sortPlayers(players).map((p, i) => ({ ...p, rank: i + 1 }));
}

// ─────────────────────────────────────────────────────────────
// 提交逻辑
// ─────────────────────────────────────────────────────────────

/**
 * 提交一局成绩。★ 只在超过历史最高分时才更新 ★
 * @param {Object} entry
 * @returns {Object}
 */
function submitScore(entry) {
  const name = String(entry.name || '').trim().slice(0, MAX_NAME_LENGTH);
  if (name.length === 0) {
    return { ok: false, error: '名字不能为空', improved: false, record: null, board: buildBoard(loadPlayers()) };
  }

  const levelCount = Math.max(0, Math.floor(Number(entry.level) || 0));
  const totalTime = Math.max(0, Number(entry.time) || 0);
  const score = Number.isFinite(Number(entry.score))
    ? Math.max(0, Math.floor(Number(entry.score)))
    : computeScore(levelCount, totalTime);

  const players = loadPlayers();
  const existing = players.find((p) => p.name === name);

  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.level = levelCount;
      existing.totalTime = Number(totalTime.toFixed(2));
      existing.updatedAt = new Date().toISOString();
      savePlayers(players);
      return { ok: true, improved: true, record: { ...existing }, board: buildBoard(players) };
    }
    // 没超过历史最高 —— 原样保留，不覆盖
    return { ok: true, improved: false, record: { ...existing }, board: buildBoard(players) };
  }

  const record = {
    name,
    score,
    level: levelCount,
    totalTime: Number(totalTime.toFixed(2)),
    updatedAt: new Date().toISOString()
  };
  players.push(record);
  savePlayers(players);
  return { ok: true, improved: true, record: { ...record }, board: buildBoard(players) };
}

// ─────────────────────────────────────────────────────────────
// 频率限制
// ─────────────────────────────────────────────────────────────

/** IP -> 时间戳数组 */
const rateBuckets = new Map();

/**
 * 检查该 IP 是否超出提交频率限制。
 * @param {string} ip
 * @returns {boolean} true 表示允许提交
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);

  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);

  // 顺手清理过期的 IP 记录，避免 Map 无限增长
  if (rateBuckets.size > 1000) {
    for (const [key, times] of rateBuckets) {
      if (times.length === 0 || now - times[times.length - 1] > RATE_WINDOW_MS) {
        rateBuckets.delete(key);
      }
    }
  }
  return true;
}

/** 取客户端 IP（反向代理场景下取 X-Forwarded-For 的第一段） */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ─────────────────────────────────────────────────────────────
// HTTP 辅助
// ─────────────────────────────────────────────────────────────

/** 所有响应都带 CORS 头 —— Web 导出的游戏跨域访问必需 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** 提供静态文件，带目录穿越防护 */
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  // 归一化后必须仍在 PUBLIC_DIR 之内
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: '文件不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      ...CORS_HEADERS,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/** 读取并解析请求体 */
function readJsonBody(req, callback) {
  let size = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      callback(new Error('请求体过大'), null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (chunks.length === 0) {
      callback(new Error('请求体为空'), null);
      return;
    }
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (err) {
      callback(new Error('JSON 解析失败'), null);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 请求路由
// ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  // 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // 健康检查（云平台探活）
  if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
    sendJson(res, 200, {
      ok: true,
      status: 'healthy',
      players: loadPlayers().length,
      uptime: Math.round(process.uptime())
    });
    return;
  }

  // 获取完整榜单
  if (req.method === 'GET' && pathname === '/api/board') {
    sendJson(res, 200, {
      ok: true,
      board: buildBoard(loadPlayers()).slice(0, MAX_BOARD_ENTRIES)
    });
    return;
  }

  // 精确查询单个玩家
  if (req.method === 'GET' && pathname === '/api/player') {
    const name = decodeURIComponent((req.url || '').split('name=')[1] || '');
    if (!name) {
      sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
      return;
    }
    const record = buildBoard(loadPlayers()).find((p) => p.name === name);
    if (!record) {
      sendJson(res, 404, { ok: false, error: '未找到该玩家' });
      return;
    }
    sendJson(res, 200, { ok: true, player: record });
    return;
  }

  // 模糊搜索
  if (req.method === 'GET' && pathname === '/api/search') {
    const q = decodeURIComponent((req.url || '').split('q=')[1] || '').trim().toLowerCase();
    const board = buildBoard(loadPlayers());
    const results = q
      ? board.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20)
      : board.slice(0, 20);
    sendJson(res, 200, { ok: true, results });
    return;
  }

  // 提交成绩
  if (req.method === 'POST' && pathname === '/api/score') {
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      sendJson(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
      return;
    }
    readJsonBody(req, (err, body) => {
      if (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      const result = submitScore(body);
      sendJson(res, result.ok ? 200 : 400, result);
    });
    return;
  }

  // 其余走静态文件
  serveStatic(res, pathname);
});

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

ensureDataDir();

server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
  console.log('┌─────────────────────────────────────────┐');
  console.log('│  🐸 Frogger 排行榜服务已启动              │');
  console.log('└─────────────────────────────────────────┘');
  console.log(`  监听地址:  http://${HOST}:${PORT}  (双栈，IPv4+IPv6 都能连)`);
  console.log(`  本机测试:  http://127.0.0.1:${PORT}`);
  console.log(`  数据目录:  ${DATA_DIR}`);
  console.log(`  数据文件:  ${DATA_FILE}`);
  console.log(`  健康检查:  http://127.0.0.1:${PORT}/api/health`);
  console.log('');
  console.log('  可用环境变量：');
  console.log(`    PORT      监听端口（当前 ${PORT}）`);
  console.log(`    HOST      监听地址（当前 ${HOST}）`);
  console.log(`    DATA_DIR  数据目录（当前 ${DATA_DIR}）`);
});

// 优雅退出，确保数据已落盘
process.on('SIGTERM', () => {
  console.log('\n[server] 收到 SIGTERM，正在退出…');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  // 单个请求出错不能让整个服务挂掉
  console.error('[server] 未捕获异常:', err.message);
});
