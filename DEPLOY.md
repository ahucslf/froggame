# 📦 部署清单 · 只需上传这一个文件夹

> 整个部署包 **60KB、零依赖**，拷到哪都能跑。
> 已实测：复制到任意目录后独立启动，API 与网页均正常。

---

## 📁 需要上传的文件（共 8 个）

```
frogger-leaderboard-deploy/
├── server.js           ★必需  服务主程序（API + 网页托管）
├── package.json        ★必需  项目描述，npm start 用它
├── public/
│   └── index.html      ★必需  排行榜网页
├── data/                        玩家数据目录（自动创建，可空）
│   └── players.json             初始空数据，实际由服务运行时写入
├── render.yaml          可选    Render 平台自动配置
├── railway.json         可选    Railway 平台自动配置
├── vercel.json          可选    Vercel 平台配置（⚠️ 见下方警告）
├── .gitignore           可选    忽略数据文件
└── README.md            可选    完整文档
```

**必需 4 个**：`server.js`、`package.json`、`public/index.html`、`data/`（空目录）

---

## ❌ 千万不要上传这些

| 内容 | 原因 |
|---|---|
| `game.gd` / `game.tscn` / `car.gd` 等游戏文件 | 游戏本体，留在本地跑 |
| `1 Frogger - 青蛙过河/` 课程素材 | 几十 MB 贴图，用不上 |
| `leaderboard/`（旧版网页目录） | 已复制进 `deploy/public/`，重复了 |
| `server/`（旧版服务端目录） | 已由 `deploy/server.js` 取代 |
| `node_modules/` | 零依赖，根本没有这个目录 |

---

## 🚀 三步部署

### 第 1 步：上传到 GitHub

```bash
cd /Users/fei/youxi-1
git init
git add frogger-leaderboard-deploy
git commit -m "排行榜服务"
git remote add origin https://github.com/你的用户名/你的仓库.git
git push -u origin master
```

> 只 add `frogger-leaderboard-deploy` 这一个文件夹，不要 add 整个项目。

### 第 2 步：连接平台

**Render（推荐）**
1. [render.com](https://render.com) → New → Web Service
2. 选你的仓库 → Render 自动读 `render.yaml`
3. 点 Deploy

**Railway**
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. 选仓库 → 自动读 `railway.json`

### 第 3 步：拿到网址

```
https://你的项目名.onrender.com
```

**验证部署成功**（浏览器打开）：
```
https://你的项目名.onrender.com/api/health
```
看到 `{"ok":true,"status":"healthy",...}` 就成了 ✅

---

## 🎮 第 4 步：让游戏连上（Yoyo 来做）

部署完把网址告诉 Yoyo，我改这一行：

**`leaderboard_service.gd` 第 24 行**
```gdscript
const SERVER_URL: String = "http://127.0.0.1:8848"
```
改成：
```gdscript
const SERVER_URL: String = "https://你的项目名.onrender.com"
```

> ⚠️ **必须用 `https://`**。网页部署后是 https 加密的，
> 游戏如果还用 http 会被浏览器的混合内容策略直接拦掉。

---

## ⚠️ Vercel 的坑

**不要用 Vercel** —— 它的文件系统是**临时的**，服务每次重启
`data/players.json` 就会清空，玩家全丢。

要长期保存数据请用 **Render / Railway**（自带持久磁盘），
或换成 Vercel KV / Supabase 等外部数据库。

---

## 🧪 本地自测（部署前先跑一遍）

```bash
cd frogger-leaderboard-deploy
node server.js
```

然后浏览器打开：
- `http://127.0.0.1:8848/` → 排行榜网页
- `http://127.0.0.1:8848/api/health` → 健康检查

**注意用 `127.0.0.1` 而不是 `localhost`**：
macOS 上 `localhost` 会优先解析成 IPv6 的 `::1`，
Godot 的 HTTPClient 不回退 IPv4，会导致游戏连不上。

---

## 📡 API 一览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查（平台探活） |
| GET | `/api/board` | 完整排行榜 |
| GET | `/api/player?name=xxx` | 查某个玩家 |
| GET | `/api/search?q=xx` | 模糊搜索 |
| POST | `/api/score` | 提交成绩（只保留最高分） |

---

## 💾 数据持久化

数据存在 `data/players.json`。

| 平台 | 默认情况 | 需要额外配置吗 |
|---|---|---|
| Render | 免费版重启会丢 | 挂持久磁盘：Settings → Disks → `/data`，设 `DATA_DIR=/data` |
| Railway | 有卷就持久 | Volumes → 挂到 `/data`，设 `DATA_DIR=/data` |
| 自有服务器 | 一直持久 | 不用管 |

环境变量一览：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8848` | 云平台会自动注入，不用管 |
| `HOST` | `::` | 双栈监听，同时接 IPv4/IPv6 |
| `DATA_DIR` | `./data` | 想用持久磁盘就改成 `/data` |
