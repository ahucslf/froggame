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

---

## 💾 数据持久化（重要）

### 问题

Render **免费版**的 web service 用的是**临时文件系统**：

- 部署新代码 → 实例重启 → 数据全没
- **空闲 15 分钟 → 实例休眠 → 唤醒时又重启 → 数据再没**

玩家玩一局中间停顿一下，排名就没了。

### 解决方案：数据存到 GitHub 仓库

服务支持可选的 GitHub 存储后端。**配两个环境变量就自动启用**：

| 环境变量 | 值 |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token（需 `repo` 权限） |
| `GITHUB_REPO` | `ahucslf/froggame` |

在 Render 后台配置：
1. **Environment** 页面 → Add Environment Variable
2. `GITHUB_TOKEN` = 你的令牌（类型选 **Secret**，不要提交到仓库）
3. `GITHUB_REPO` = `ahucslf/froggame`

### 令牌怎么拿

GitHub → 右上角头像 → Settings → Developer settings →
Personal access tokens → Tokens (classic) → Generate new token
→ 勾选 **`repo`** → Generate → 复制（只显示一次）

### 工作原理

```
启动时  → 从 GitHub 拉取 data/players.json 恢复数据
提交时  → 先写本地文件（同步、立即生效）
        → 再后台异步推送一份到 GitHub（不阻塞响应）
```

本地文件只是缓存，**真正的数据源是 GitHub**。所以实例重启、休眠唤醒都不会丢。

### 验证是否生效

打开 `https://你的域名/api/health`，看 `storage` 字段：

```json
{ "ok": true, "status": "healthy", "players": 0, "storage": "github" }
```

`storage` 是 `github` 就说明启用成功，是 `local` 说明环境变量没配对。

### 不用 GitHub 存储行不行？

行，但数据会在实例重启后丢失。只适合临时演示。


---

## 🔥 数据丢失问题（重要）

### 现象
「成绩传上去了，但网页上又没了」

### 根本原因
**Render 免费版用的是临时文件系统：**
- 重新部署 → 数据清空
- **空闲 15 分钟休眠 → 唤醒时重启 → 数据再清空**

`render.yaml` 里原来的 `DATA_DIR` 指向 `/opt/render/project/src/data`，
那是**项目源码目录**，每次重新部署都会被整个重置 —— 数据必丢。

### 验证方法
```bash
curl https://froggame.onrender.com/api/health
# 看 storage 字段：
#   "storage": "local"   ← 临时盘，重启就丢
#   "storage": "github"  ← 持久化，OK
```
再看 `uptime`：如果它刚变成很小的数字，说明实例重启过，
这时榜单多半已经空了。

### ✅ 解决：配 GITHUB_TOKEN

**代码已经就绪**（不需要改任何代码），只要在 Render 后台加一个环境变量：

1. GitHub → 右上角头像 → **Settings** → **Developer settings**
2. 左侧最下面 → **Personal access tokens** → **Tokens (classic)**
3. 点 **Generate new token (classic)**
4. 勾选 **`repo`** 权限 → 滑到底 → **Generate token**
5. **复制令牌**（只显示一次！）
6. 回到 Render → 你的服务 → **Environment** → **Add Environment Variable**
   - Key: `GITHUB_TOKEN`
   - Value: 粘贴刚才的令牌
7. 保存 → Render 会自动重新部署

### 验证是否成功
```bash
curl https://froggame.onrender.com/api/health
# 看到 "storage": "github" 就说明生效了 ✅
```

之后数据会存在 GitHub 仓库的 `data/players.json`，
实例重启、休眠唤醒、重新部署都不会丢。

### 顺便修的：0 关成绩被丢弃
之前服务端有这层防护：
```js
if (levelCount <= 0) { return { skipped: true, ... } }
```
玩家**第 1 关就被撞死**时，整局成绩完全没上报，网页上永远看不到。
现在改成只有非法值才拒绝，0 关照常上榜（分数是 0）。

