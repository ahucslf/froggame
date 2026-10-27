/**
 * 🐸 Frogger 排行榜服务 —— 生产部署版
 *
 * 与本地开发版的差异：
 *   1. 端口从环境变量 PORT 读取（云平台会动态分配），不再是写死 8848
 *   2. 数据目录从环境变量 DATA_DIR 读取，支持云平台的临时磁盘
 *   3. 监听 :: 双栈而非 localhost，Godot 的 HTTPClient 不回退 IPv4
 *   4. 新增 /api/health 健康检查端点（云平台探活用）
 *   5. 新增请求频率限制，防止被人恶意刷榜
 *   6. 写文件加锁，防止并发写入互相覆盖
 *   7. 保留完整 CORS 头，Web 导出的游戏跨域访问必需
 *   8. ★ 可选的 GitHub 存储后端 ★ —— 解决 Render 免费版休眠重启丢数据的问题
 *
 * 存储后端（通过环境变量选择，不配就用本地文件）：
 *   GITHUB_TOKEN   GitHub Personal Access Token（需 repo 权限）
 *   GITHUB_REPO    仓库路径，例如 ahucslf/froggame
 *   两个都配了 → 数据存到 GitHub，实例重启/休眠唤醒都不丢
 *
 * 本地运行：node server.js
 * 部署到 Render/Railway/Fly.io：直接上传整个文件夹即可
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

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
// GitHub 存储后端（可选）
// ─────────────────────────────────────────────────────────────
//
// ★ 为什么需要这个 ★
// Render 免费版的 web service 用的是【临时文件系统】：
//   - 部署新代码 → 实例重启 → 数据全没
//   - 空闲 15 分钟 → 实例休眠 → 唤醒时又重启 → 数据再没
// 玩家玩一局中间停顿一下，排名就没了。
//
// 解决办法：把数据存到 GitHub 仓库（免费、永久、容量足够）。
// 配好 GITHUB_TOKEN 和 GITHUB_REPO 两个环境变量就自动启用，
// 不配的话行为和之前完全一样（用本地文件）。

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
// ★ 仓库路径要有默认值 ★
// 之前默认空字符串 → 没配环境变量时请求打到 `/repos//contents/...`，
// GitHub 直接 404，而且日志里什么都不打印 —— 恢复逻辑静默失效。
// 仓库是【公开】的，所以读取（restoreData）不需要令牌也能工作。
const GITHUB_REPO = process.env.GITHUB_REPO || 'ahucslf/froggame';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE = process.env.GITHUB_FILE || 'data/players.json';
/** GitHub API 超时（毫秒） */
const GITHUB_TIMEOUT_MS = 15000;

/** 是否启用了 GitHub 存储 */
const USE_GITHUB = Boolean(GITHUB_TOKEN && GITHUB_REPO);

/**
 * 调用 GitHub Contents API。
 * @param {string} method GET / PUT
 * @param {string} apiPath API 路径
 * @param {Object|null} payload PUT 的请求体
 * @returns {Promise<Object>} { status, body }
 */
function githubApi(method, apiPath, payload) {
  return new Promise((resolve) => {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'frogger-leaderboard',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // ★ 只有真的拿到令牌时才带 Authorization ★
    //
    // 之前的 bug：无条件发 `Authorization: Bearer `（令牌为空时末尾是空的），
    // GitHub 会把这个当成「无效凭据」直接返回 401 ——
    // 连【公开仓库的匿名读取】都被搞挂了。
    //
    // 后果很严重：restoreData() 里的兜底逻辑（本地空 → 从仓库恢复）
    // 永远拿不到数据，实例重启后榜单必然清空。
    //
    // 实测：
    //   不带 Authorization      → 200 ✅
    //   带空 Bearer             → 401 ❌
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }

    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method,
      headers
    };
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (_e) { parsed = {}; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.setTimeout(GITHUB_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: 0, body: {} });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));

    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

/**
 * 从 GitHub 拉取数据文件。
 * @returns {Promise<Array<Object>|null>} 玩家数组，失败或不存在返回 null
 */
async function githubLoad() {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`;
  const res = await githubApi('GET', apiPath, null);

  if (res.status === 404) {
    // 文件还不存在，属于正常情况
    return null;
  }
  if (res.status !== 200) {
    console.error(`[github] 读取失败，HTTP ${res.status}`);
    return null;
  }

  try {
    const content = Buffer.from(res.body.content || '', 'base64').toString('utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.players) ? parsed.players : [];
  } catch (err) {
    console.error('[github] 数据解析失败:', err.message);
    return null;
  }
}

/**
 * 把玩家数据写回 GitHub。
 * @param {Array<Object>} players
 * @returns {Promise<boolean>} 是否成功
 */
async function githubSave(players) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const content = JSON.stringify({ players }, null, 2);

  // PUT 需要带上文件的 sha（如果已存在），先查一次
  const getRes = await githubApi('GET', `${apiPath}?ref=${GITHUB_BRANCH}`, null);
  const sha = (getRes.status === 200 && getRes.body.sha) ? getRes.body.sha : undefined;

  const payload = {
    message: 'chore: update leaderboard data',
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (sha) {
    payload.sha = sha;
  }

  const res = await githubApi('PUT', apiPath, payload);
  if (res.status !== 200 && res.status !== 201) {
    console.error(`[github] 写入失败，HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    return false;
  }
  return true;
}

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

/** 内存中的玩家数据。启动时加载，之后所有读写都基于它 */
let playerCache = null;

/** 确保数据目录存在 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[data] 已创建数据目录: ${DATA_DIR}`);
  }
}

/** 读取全部玩家记录（从内存缓存，没有则从文件加载） */
function loadPlayers() {
  if (playerCache !== null) {
    return playerCache;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    playerCache = Array.isArray(parsed.players) ? parsed.players : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[data] 读取失败:', err.message);
    }
    playerCache = [];
  }
  return playerCache;
}

/** 原子写入本地文件：先写临时文件再改名 */
function saveLocal(players) {
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

/**
 * 保存数据：先写本地（同步、立即生效），再异步推 GitHub（不阻塞响应）。
 * @param {Array<Object>} players
 */
function savePlayers(players) {
  playerCache = players;
  saveLocal(players);

  if (USE_GITHUB) {
    // 不 await —— 响应立刻返回，GitHub 写入在后台完成
    githubSave(players).then((ok) => {
      if (ok) {
        console.log('[github] 数据已同步到仓库');
      } else {
        console.error('[github] 写入失败，本地仍有副本');
      }
    });
  }
}

/**
 * 标记数据「已变更」，等一小段时间后合并写入。
 *
 * ★ 为什么需要合并写入 ★
 * 一局游戏可能连续提交多次（存档 + 死亡结算），
 * 每次都打一次 GitHub API 容易撞上速率限制。
 * 这里把短时间内的多次变更合并成一次写入。
 */
let pendingSaveTimer = null;
function scheduleSave() {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    if (USE_GITHUB) {
      githubSave(playerCache).then((ok) => {
        if (ok) console.log('[github] 数据已同步到仓库');
      });
    }
  }, 800);
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

  // 关卡数。负数是非法值，归零处理（0 关仍然是一局有效记录）
  const levelCount = Math.max(0, Math.floor(Number(entry.level) || 0));
  const totalTime = Math.max(0, Number(entry.time) || 0);
  // 班级号。玩家可留空，留空就存空字符串
  const classId = String(entry.classId || '').trim().slice(0, 32);

  // ★ level == 0 也要上榜 ★
  // 之前这里直接返回 skipped，把玩家「第 1 关就被撞死」的成绩整局丢掉 ——
  // 网页上完全看不到这条记录，主人会以为「成绩没传上去」。
  //
  // 负数在上面的 Math.max 里已经归零，所以这里不需要再拦。

  // ★ 分数优先用客户端传来的，但 0 / 缺失 / 非法时必须自己算 ★
  // 之前写成 `Number.isFinite(Number(entry.score)) ? ... : computeScore(...)`，
  // 结果传 score=0 会被当成「合法分数 0」存进榜单 —— 一局 6 关 70 秒的正常成绩
  // 变成 0 分。0 是「没传分数」的标记，不是合法分数。
  const providedScore = Number(entry.score);
  const score = (Number.isFinite(providedScore) && providedScore > 0)
    ? Math.floor(providedScore)
    : computeScore(levelCount, totalTime);

  const players = loadPlayers();
  const existing = players.find((p) => p.name === name);

  if (existing) {
    if (score > existing.score) {
      existing.score = score;
      existing.level = levelCount;
      existing.totalTime = Number(totalTime.toFixed(2));
      // 班级号跟着更新（玩家可能换了班级）
      if (classId) existing.classId = classId;
      existing.updatedAt = new Date().toISOString();
      savePlayers(players);
      return { ok: true, improved: true, record: { ...existing }, board: buildBoard(players) };
    }
    // 没超过历史最高 —— 原样保留，不覆盖
    return { ok: true, improved: false, record: { ...existing }, board: buildBoard(players) };
  }

  const record = {
    name,
    classId,
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

/** 提供静态文件，带目录穿越防护 */
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // ★ 剥掉前导斜杠 ★
  // path.join(PUBLIC_DIR, '/assets/x.jpg') 在不同 Node 版本下行为不一致，
  // 统一剥掉前导斜杠最稳 —— 得到 assets/x.jpg，再拼到 PUBLIC_DIR 后面。
  const relPath = rel.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relPath));

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
      storage: USE_GITHUB ? 'github' : 'local',
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

  // 班级列表 —— 网页用它做「只看某班」的下拉框
  if (req.method === 'GET' && pathname === '/api/classes') {
    const classes = [...new Set(
      loadPlayers().map((p) => String(p.classId || '')).filter((c) => c.length > 0)
    )].sort();
    sendJson(res, 200, { ok: true, classes });
    return;
  }

  // 按班级筛选榜单
  if (req.method === 'GET' && pathname === '/api/board-by-class') {
    const wanted = String(
      decodeURIComponent((req.url || '').split('class=')[1] || '')
    ).trim();
    const board = buildBoard(loadPlayers())
      .filter((p) => String(p.classId || '') === wanted);
    sendJson(res, 200, { ok: true, classId: wanted, board });
    return;
  }

  // 模糊搜索
  if (req.method === 'GET' && pathname === '/api/search') {
    const q = decodeURIComponent((req.url || '').split('q=')[1] || '').trim().toLowerCase();
    const board = buildBoard(loadPlayers());
    const results = q
      ? board.filter((p) =>
          p.name.toLowerCase().includes(q) ||
          String(p.classId || '').toLowerCase().includes(q)
        ).slice(0, 20)
      : board.slice(0, 20);
    sendJson(res, 200, { ok: true, results });
    return;
  }

  // ★ 清理异常记录（一次性维护用）★
  //
  // 背景：客户端曾经有个计时 bug —— _run_time 一直累加不清零，
  // 导致提交的 totalTime 能到 600 多秒，网页上显示「671.1s」很难看。
  // 那个 bug 已经修了，但历史脏数据还在榜上。
  //
  // 这个接口把「用时明显不合理」的记录删掉：
  // 判定条件 = totalTime > 阈值（默认 300 秒）
  // 正常玩家单关最多也就几十秒，300 秒足够宽松。
  //
  // 用法：GET /api/cleanup-anomalies?maxTime=300
  if (req.method === 'GET' && pathname === '/api/cleanup-anomalies') {
    const maxTime = Math.max(1, Number((req.url || '').split('maxTime=')[1]) || 300);
    const players = loadPlayers();
    const before = players.length;
    const kept = players.filter((p) => Number(p.totalTime || 0) <= maxTime);
    const removed = before - kept.length;
    if (removed > 0) {
      savePlayers(kept);
    }
    const details = players
      .filter((p) => Number(p.totalTime || 0) > maxTime)
      .map((p) => ({ name: p.name, totalTime: p.totalTime, level: p.level }));
    sendJson(res, 200, {
      ok: true,
      removed,
      remaining: kept.length,
      maxTime,
      details,
    });
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

/**
 * 启动前的数据恢复。
 *
 * ★ 这是持久化的关键 ★
 * 启用了 GitHub 存储时，先把仓库里的数据拉回内存 —— 这样实例重启、
 * 空闲休眠唤醒都不会丢数据。Render 免费版每次部署/唤醒都是新实例，
 * 不恢复就等于每次都从零开始。
 */
async function restoreData() {
  ensureDataDir();

  if (USE_GITHUB) {
    console.log('[github] 正在从仓库恢复数据…');
    const fromGithub = await githubLoad();
    if (fromGithub !== null) {
      playerCache = fromGithub;
      // 本地也留一份，双保险
      saveLocal(fromGithub);
      console.log(`[github] 已恢复 ${fromGithub.length} 条记录`);
    } else {
      console.log('[github] 仓库里还没有数据文件，用本地数据初始化');
      loadPlayers();
    }
  } else {
    loadPlayers();
    const count = loadPlayers().length;
    console.log(`[data] 已加载 ${count} 条记录（本地文件）`);
    if (count === 0) {
      // ★ 本地空 → 可能是实例刚重启（临时盘被清），数据在仓库里 ★
      // 异步再试一次拉取，拉到就写回本地并直接用它。
      // 公开仓库【不需要令牌】也能读，所以这条兜底路径在没有令牌时也有效。
      console.log('[github] 本地为空，尝试从仓库恢复…');
      githubLoad().then((remote) => {
        if (remote && remote.length > 0) {
          playerCache = remote;
          saveLocal(remote);
          console.log(`[github] 从仓库恢复了 ${remote.length} 条记录`);
        } else {
          // ★ 失败要打日志 ★ 之前这里是静默的，出问题完全看不见
          console.warn('[github] 仓库里没有可用数据（或读取失败），本次从空榜开始');
        }
      }).catch((err) => {
        console.warn('[github] 恢复失败:', err && err.message ? err.message : err);
      });
    }
  }
}

/** 真正启动服务 */
async function start() {
  await restoreData();

  server.listen({ port: PORT, host: HOST, ipv6Only: false }, () => {
    console.log('┌─────────────────────────────────────────┐');
    console.log('│  🐸 Frogger 排行榜服务已启动              │');
    console.log('└─────────────────────────────────────────┘');
    console.log(`  监听地址:  http://${HOST}:${PORT}  (双栈，IPv4+IPv6 都能连)`);
    console.log(`  本机测试:  http://127.0.0.1:${PORT}`);
    console.log(`  数据存储:  ${USE_GITHUB ? `GitHub 仓库 ${GITHUB_REPO}/${GITHUB_FILE}` : '本地文件（重启会丢）'}`);
    console.log(`  数据目录:  ${DATA_DIR}`);
    console.log(`  健康检查:  http://127.0.0.1:${PORT}/api/health`);
    console.log('');
    console.log('  可用环境变量：');
    console.log(`    PORT          监听端口（当前 ${PORT}）`);
    console.log(`    HOST          监听地址（当前 ${HOST}）`);
    console.log(`    DATA_DIR      数据目录（当前 ${DATA_DIR}）`);
    console.log(`    GITHUB_TOKEN  GitHub 令牌（未设置则用本地文件）`);
    console.log(`    GITHUB_REPO   仓库路径，如 ahucslf/froggame`);
  });
}

start().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
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
