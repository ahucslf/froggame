# 🐸 Frogger 排行榜服务

> 📦 **只想知道上传哪些文件？直接看 [DEPLOY.md](./DEPLOY.md)** ——
> 整个包 60KB 零依赖，拷到哪都能跑。

零依赖 Node 服务，只需一个文件夹即可部署到公开网页。

---

## 📁 文件清单

```
frogger-leaderboard-deploy/
├── server.js          服务主程序（API + 静态页托管）
├── package.json       项目描述，无任何依赖
├── render.yaml        Render 平台配置
├── railway.json       Railway 平台配置
├── vercel.json        Vercel 平台配置（见下方注意事项）
├── .gitignore         忽略数据文件
├── public/
│   └── index.html     排行榜网页
└── data/              玩家数据存放目录（自动创建）
```

---

## 🚀 三种部署方式（任选其一）

### 方案 A：Render.com（推荐 · 免费 · 有 HTTPS）

1. 把整个文件夹传到 GitHub
2. 打开 [render.com](https://render.com) → New → Web Service
3. 选你的 GitHub 仓库
4. 配置：

   | 项 | 值 |
   |---|---|
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Health Check Path | `/api/health` |

5. 部署完成后会得到 `https://xxx.onrender.com`

> 仓库里有 `render.yaml` 时 Render 会自动读取，不用手填。

---

### 方案 B：Railway.app（免费额度 · 自动 HTTPS）

1. 把文件夹传到 GitHub
2. 打开 [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. 选仓库，Railway 会自动读 `railway.json`
4. 完成后得到 `https://xxx.up.railway.app`

---

### 方案 C：Vercel（免费 · ⚠️ 有数据丢失风险）

```bash
npm i -g vercel
cd frogger-leaderboard-deploy
vercel
```

> ⚠️ **Vercel 的文件系统是临时的**，服务重启后 `data/players.json` 会清空。
> 只适合临时演示或做纯前端网页。**要长期保存数据请用 Render / Railway**，
> 或换成 Vercel KV / Supabase 等外部数据库。

---

### 方案 D：自己的服务器

```bash
node server.js
# 或指定端口和数据目录
PORT=8080 DATA_DIR=/var/lib/frogger node server.js
```

建议用 pm2 或 systemd 守护进程。

---

## 🔌 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8848` | 监听端口。云平台会自动注入 |
| `HOST` | `0.0.0.0` | 监听地址。**必须 0.0.0.0**，否则容器外访问不到 |
| `DATA_DIR` | `./data` | 数据目录。Render 磁盘挂载点建议设为 `/data` |

---

## 📡 API 说明

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查（云平台探活用） |
| GET | `/api/board` | 获取完整排行榜 |
| GET | `/api/player?name=xxx` | 精确查询某玩家 |
| GET | `/api/search?q=xx` | 模糊搜索 |
| POST | `/api/score` | 提交成绩 |

### 提交成绩示例

```bash
curl -X POST https://你的域名/api/score \
  -H "Content-Type: application/json" \
  -d '{"name":"玩家名","level":10,"time":150,"score":11000}'
```

响应：

```json
{
  "ok": true,
  "improved": true,
  "record": { "name": "玩家名", "score": 11000, "level": 10, "totalTime": 150 },
  "board": [ /* 完整榜单 */ ]
}
```

`improved` 为 `false` 表示这次分数没超过历史最高，服务器**不会覆盖**旧记录。

---

## 🎮 让游戏连上线上服务

部署完成后，改 Godot 项目里 `leaderboard_service.gd` 第 11 行：

```gdscript
const SERVER_URL: String = "https://你的域名"
```

**注意事项**：

| 场景 | 要求 |
|---|---|
| 游戏在 Godot 编辑器运行 | 用 `http://localhost:8848` 或 `https://域名` 都行 |
| 游戏导出为 Web 版 | **必须用 `https://`**。浏览器会拦截 http 请求（混合内容） |
| 本地调试线上服务 | `http://localhost:8848/api/board` 确认本地服务正常 |

> 服务端已返回完整的 CORS 头（`Access-Control-Allow-Origin: *`），
> 跨域访问不受限。

---

## 🔐 内置保护

| 保护 | 说明 |
|---|---|
| 请求体大小限制 | 8 KB，超出直接拒绝 |
| 提交频率限制 | 同一 IP 每分钟最多 20 次提交 |
| 目录穿越防护 | 静态文件路径归一化校验 |
| 原子写入 | 先写 `.tmp` 再改名，防止中途崩溃损坏数据 |
| 写锁保护 | Node 单线程，杜绝并发写入互相覆盖 |
| 异常兜底 | 单个请求出错不会让整个服务挂掉 |
| 优雅退出 | 收到 SIGTERM 时先关闭服务再退出 |

---

## 📋 积分规则

```
积分 = 关卡数 × 1000 + max(0, 15秒/关 × 关卡数 − 总用时) × 40
```

- 关卡越多分越高
- 每关快于 15 秒才有时间奖励
- 慢慢通关不会扣分，只是没有额外奖励
- **只保留每位玩家的历史最高分**

> ⚠️ 这个公式在服务端（`server.js` 的 `computeScore`）和客户端
> （`leaderboard_service.gd` 的 `compute_score`）**各有一份实现**。
> 改公式时必须同步改两处，否则本地预估和服务端结果会不一致。

---

## 🆘 常见问题

**Q: 部署后网页打不开？**
检查 Render/Railway 的健康检查是否通过，日志里确认 `监听地址` 那行显示的端口正确。

**Q: 重启后数据丢了？**
用的是 Vercel 或其他无状态平台。换 Render/Railway 并挂载持久磁盘。

**Q: 游戏提示离线？**
1. 确认服务在跑：`curl https://你的域名/api/health`
2. 检查 `SERVER_URL` 是否写对（**https 不能漏**）
3. Web 导出不能用 http，会被浏览器拦截

**Q: 能改端口吗？**
可以，`PORT=8080 node server.js`。但游戏端的 URL 也要跟着改。
