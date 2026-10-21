/**
 * 排行榜 API 地址配置
 * ============================================================
 * 把你部署排行榜【服务端】的地址填在这里（带 https://）。
 *
 * 场景 A：Render 一体化部署（网页 + API 同源）
 *   → 留空 '' 即可，同源请求最省事
 *
 * 场景 B：Netlify 托管网页 + Render 托管 API（不同源）
 *   → 填 Render 的网址，例如：
 *     window.LEADERBOARD_API = 'https://frogger-leaderboard.onrender.com';
 *
 * 场景 C：局域网联机
 *   → 填本机内网 IP，例如：
 *     window.LEADERBOARD_API = 'http://192.168.1.5:8848';
 * ============================================================
 */
window.LEADERBOARD_API = '';
