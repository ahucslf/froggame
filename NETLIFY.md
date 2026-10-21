# 🚀 部署指引 · Netlify 404 解决方案

> 📌 主人遇到的问题：**Netlify 打开显示 "Page not found"**
> 根因有两个，Yoyo 都修好了。但还有一件事 Netlify 做不到 —— 看下面第 2 步。

---

## 🔍 为什么 404

### 原因 1：index.html 不在根目录（已修复）

Netlify 默认在**仓库根目录**找 `index.html`，而我们的网页在 `public/index.html`。

**修复**：加了 `netlify.toml`
```toml
[build]
  publish = "public"
  command = "echo '静态站点，无需构建'"
```
推送后 Netlify 会自动重新部署，404 消失。

### 原因 2：★ Netlify 跑不了 Node 服务端 ★

这是**更重要**的一点。就算网页正常显示了，API 依然是 404：

| 路径 | Netlify 静态托管 | Node 服务端 |
|---|---|---|
| `/` | ✅ 返回 index.html | ✅ 返回 index.html |
| `/api/board` | ❌ **404**（没这个文件） | ✅ 返回 JSON 榜单 |
| `/api/score` | ❌ **404**（不会执行） | ✅ 写入成绩 |
| `/api/health` | ❌ **404** | ✅ 健康检查 |

**Netlify 是纯静态托管 —— 它只发文件，不执行代码。**
提交成绩、拉取榜单这些逻辑必须跑在能执行 Node 的地方。

---

## 📋 两步走

### 第 1 步：Netlify（网页）— 已修好，推送即生效

```bash
cd /Users/fei/youxi-1/.deploy_push
cp -R ../frogger-leaderboard-deploy/. .
git add -A
git commit -m "fix: 添加 netlify.toml 修复 404，API 地址改为可配置"
TOKEN=$(gh auth token)
git push "https://x-access-token:${TOKEN}@github.com/ahucslf/froggame.git" main
git config --unset-all branch.main.remote
```

推完 Netlify 会自动重新部署（一般 1~2 分钟），网址就能打开了。

### 第 2 步：部署 API 服务（这步必须做）

**方案 A（推荐）：Render 一体化** —— 一个网址同时提供网页 + API

1. 打开 [render.com](https://render.com) → New → Web Service
2. 选 `ahucslf/froggame` 仓库
3. Render 自动读 `render.yaml`，直接点 **Create Web Service**
4. 完成后得到 `https://frogger-leaderboard.onrender.com`

然后：
- **游戏端**：改 `leaderboard_service.gd` 的 `SERVER_URL` 为这个地址
- **Netlify 网页**：把这个地址填进 `public/config.js` 的 `window.LEADERBOARD_API`
- **或者更简单**：Netlify 那个站点可以不要了，直接用 Render 的地址（网页和 API 同源）

**方案 B：Railway** —— 同上，railway.app → New Project → 选仓库

---

## ⚙️ public/config.js 说明

Netlify 托管网页时，API 地址写在这里：

```js
window.LEADERBOARD_API = 'https://frogger-leaderboard.onrender.com';
```

| 场景 | 填什么 |
|---|---|
| 网页和 API 同源（Render 一体化） | 留空 `''` |
| Netlify 网页 + Render API（不同源） | 填 Render 的完整网址 |
| 局域网联机 | 填 `http://192.168.x.x:8848` |

---

## 🔍 怎么看有没有连上

网页顶部现在有个**连接状态徽章**：

- 🟢 **● 已连接排行榜服务** → API 正常
- 🔴 **○ 未连接到排行榜服务** → API 没通，把鼠标悬停在徽章上看错误详情

如果 Netlify 部署后徽章是红的，说明第 2 步的 API 服务还没弄好。

---

## ⚠️ 三个提醒

**① 别用 Vercel** —— 文件系统是临时的，重启 `players.json` 就清空，玩家全丢。
Render / Railway 自带持久磁盘。

**② Web 导出的游戏必须用 `https://`** —— 网页是加密的，游戏用 http 会被浏览器混合内容策略直接拦掉。

**③ Render 免费版会休眠** —— 没人访问时会休眠，首次请求可能等几秒才响应。游戏端超时设的是 5 秒，够用。

---

## 📡 快速自检

部署完在浏览器打开这两个地址：

```
https://你的域名/api/health
```
看到 `{"ok":true,"status":"healthy",...}` → 服务活着 ✅

```
https://你的域名/api/board
```
看到 `{"ok":true,"board":[...]}` → 榜单接口正常 ✅
