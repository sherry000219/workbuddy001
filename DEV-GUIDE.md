# 竞赛平台搭建经验分享

> 给 WorkBuddy 另一个任务看的操作手册——架构、踩坑、凭据全在这。

---

## 一、项目定位

一个内部赛事平台，功能：钉钉登录 → 投稿 → 投票 → 评委打分 → 管理后台。

**核心原则：零成本、零运维。** 不用数据库、不用 CI/CD、不用 Docker。一个 `server.js` + 几个静态 HTML 就打完了。

---

## 二、技术栈

| 层 | 选型 | 为什么 |
|---|------|--------|
| 后端 | Node.js + Express | 轻量，一个文件写完 |
| 前端 | 原生 HTML/CSS/JS | 不用框架，直接 `<script>` 写逻辑，零构建步骤 |
| 数据库 | JSON 文件 (`data/contest.json`) | 省掉 MySQL/MongoDB，读写在内存里，落地到本地文件 |
| 数据持久化 | GitHub API（`data` 分支） | 每次写入后推到 GitHub，重启时拉回来。免费、稳定 |
| 部署 | Render Free Tier | 免费 HTTPS + 自动从 GitHub 部署 + 环境变量管理 |
| 登录 | 钉钉 OAuth 2.0 | 企业内部全员有钉钉，免注册 |
| Session | 服务端 Cookie（JSON 文件存 token→用户映射） | 配合 `httpOnly + sameSite:none + secure:true` |

---

## 三、项目结构

```
contest-platform/
├── server.js              ← 唯一的后端文件（所有 API + 路由 + 中间件）
├── render.yaml            ← Render 部署配置
├── package.json           ← 依赖：express, cookie-parser, multer
├── data/
│   ├── contest.json       ← 投稿/投票/打分数据（.gitignore，GitHub 单独同步）
│   └── sessions.json      ← 登录 session（.gitignore，GitHub 单独同步）
├── uploads/               ← 附件上传目录（.gitignore）
└── public/
    ├── index.html         ← 宣传首页
    ├── contest-promo.html ← 独立宣传页
    ├── ip-*.webp          ← IP 图片（PNG→WebP 压缩到 10KB 以下）
    └── app/
        ├── index.html     ← 竞赛大厅（排名 + 投票）
        ├── submit.html    ← 投稿页
        ├── browse.html    ← 作品浏览
        ├── judge.html     ← 评委打分
        └── admin.html     ← 管理后台
```

**核心设计原则**：前端页面之间**无共享状态**。每个页面独立 `checkAuth()` 调 `/api/auth/me` 验证登录，不依赖 localStorage / URL 传参。

---

## 四、部署配置 (`render.yaml`)

```yaml
services:
  - type: web
    name: workbuddy-contest
    runtime: node
    repo: https://github.com/sherry000219/workbuddy001
    plan: free
    buildCommand: npm install
    startCommand: node server.js
    envVars:
      - key: PORT
        value: "3000"
      - key: NODE_ENV
        value: production
      - key: GITHUB_TOKEN
        sync: false        ← 必须在 Render Dashboard 手动填
      - key: JUDGE_PASSWORD
        sync: false
      - key: ADMIN_PASSWORD
        sync: false
```

部署流程：**Git push → Render 自动检测 → npm install → node server.js → 上线。** 没有任何手动步骤。

---

## 五、凭据清单

> ⚠️ 以下凭据仅供铭瑞在另一个 WorkBuddy 项目中使用，切勿外传。

| 凭据 | 值 | 用途 |
|------|-----|------|
| 钉钉 AppKey | `dingrdgv8ra8guvuj6pm` | 钉钉 OAuth 登录 |
| 钉钉 AppSecret | `oo65T3Lew-22gSG_FwLKqSLfqEP9XZv0Kgtpn2r7IjFwG1FliqCSKAzAvcKz7SdJ` | 钉钉 OAuth 登录 |
| 钉钉 OAuth 回调 | `https://workbuddy-contest.onrender.com/auth/dingtalk/callback` | 钉钉开发者后台配置的回调地址 |
| GitHub Token | （Render Dashboard 中查看） | GitHub API 读写数据 |
| GitHub 仓库 | `sherry000219/workbuddy001` | 代码 + 数据分支 `data` |
| 评委密码 | （Render Dashboard `JUDGE_PASSWORD`） | 评委登录用 |
| 管理员密码 | （Render Dashboard `ADMIN_PASSWORD`） | 管理后台登录用 |
| Render 服务名 | `workbuddy-contest` | 部署在 Render |
| 公网地址 | `https://workbuddy-contest.onrender.com` | 最终访问 URL |

---

## 六、钉钉登录流程图

```
用户点击「钉钉登录」
  → /api/auth/dd-url?redirect=/app/submit.html
  → 生成 state，存储 state→redirect 映射
  → 跳转钉钉 OAuth: login.dingtalk.com/oauth2/auth
  → 用户授权后回调 /auth/dingtalk/callback?code=xxx&state=xxx
  → exchangeDingTalkCode(code):
       POST api.dingtalk.com/v1.0/oauth2/userAccessToken  → accessToken
       GET  api.dingtalk.com/v1.0/contact/users/me       → nick, mobile, unionId
  → 生成 session token，存 cookie + sessions.json
  → 根据 state 找到 redirect，302 跳回去
```

**曾踩过的坑：**
- `scope=openid+profile` 是有效的，`scope=openid+profile+contact` 会报错（`contact` 不是有效 scope）
- `sameSite:'none'` 必须配 `secure:true`，且 Render 需要 `app.set('trust proxy', 1)`
- 后续没有用企业 API 获取部门信息（反复失败），改为用户手动选择

---

## 七、数据持久化方案

```
saveDB() → 写本地 contest.json
    ↓ 1秒后
ghPush() → 推送到 GitHub data/contest.json

saveSessions() → 写本地 sessions.json
    ↓ 2秒后
ghPushSessions() → 推送到 GitHub data/sessions.json

启动时：
ghPull() → 从 GitHub 拉 contest.json
ghPullSessions() → 从 GitHub 拉 sessions.json

进程退出前：
SIGTERM/SIGINT → forceSyncBeforeExit() → 立即 push 最后一次
```

**曾踩过的坑：**
- GitHub Contents API 请求必须带 `?ref=data` 查询参数，否则 404。曾经 `url.pathname` 丢掉了 `url.search`，导致同步全挂
- Render 免费实例会休眠，重启后本地文件全清。**数据必须同步到 GitHub**
- 如果 `GITHUB_TOKEN` 没配，所有数据重启即丢失

---

## 八、踩坑合集

### 1. GitHub API — 查询参数丢失
```javascript
// ❌ 错误
path: url.pathname
// ✅ 正确
path: url.pathname + url.search
```

### 2. SameSite cookie 不生效
```javascript
// 必须加这行，否则 Render 代理层不认
app.set('trust proxy', 1);
```

### 3. 钉钉 OAuth scope 报错
只支持 `openid` 和 `profile`，其他 scope 会导致无法跳转。

### 4. 登录后跳不回原页面
OAuth callback 写死 `res.redirect('/')` 不够，需要 state→redirect 映射表。

### 5. IP 图片加载慢
原始 PNG 371KB-890KB，转 WebP 后 8-10KB，加 `preload` + `fetchpriority="high"`。

### 6. 评委密码验证时机
最初的代码是进入评分界面后才验证密码（打分时才发现密码不对），改为登录时先调 `/api/judge/my-scores` 验证。**登录即校验，不进则退。**

### 7. 管理后台无登录门禁
最初管理后台只需输密码，不需要钉钉登录。后来加上 DD 登录门禁：**必须先钉钉认证，显示姓名，再输管理员密码。**

### 8. 文本安全
评委姓名从自由输入改为强制钉钉读取，防止随便起名导致打分记录不可追溯。

---

## 九、关键代码片段

### Ping-Pong 登录状态检查（每个页面都用）
```javascript
async function checkAuth() {
  const resp = await fetch('/api/auth/me', { credentials: 'include' });
  const data = await resp.json();
  if (data.user) {
    ddAuthed = true;
    ddUser = data.user;
  }
}
```

### 钉钉用户信息获取（最简版）
```javascript
async function exchangeDingTalkCode(code) {
  // 1. 换 accessToken
  const tokenResp = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, code, grantType: 'authorization_code' })
  });
  const { accessToken } = await tokenResp.json();

  // 2. 获取用户信息
  const userResp = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    headers: { 'x-acs-dingtalk-access-token': accessToken }
  });
  const user = await userResp.json();
  // user: { nick, mobile, openId, unionId, avatarUrl, email }
}
```

### 本地 JSON 数据库模式
```javascript
const db = loadDB();           // 启动时读文件
// ... API 操作中直接改 db.entries / db.votes ...
saveDB();                      // 写入本地文件 + 触发 GitHub 推送
```

---

## 十、Render Dashboard 检查清单

部署后在 Render Dashboard 确认：
- [ ] `GITHUB_TOKEN` 已填写
- [ ] `JUDGE_PASSWORD` 已填写
- [ ] `ADMIN_PASSWORD` 已填写
- [ ] 访问 `/api/sync-status` 确认 `githubToken` 不是 `NOT SET`
- [ ] 访问首页确认奖项文案是最新版

---

## 十一、如果新项目也要这么搭

1. 复制 `server.js` 骨架（Express + cookie-parser + multer）
2. 改钉钉 AppKey/AppSecret（另建一个钉钉应用）
3. 改 GitHub 仓库名和 branch
4. 改 `render.yaml` 中的 `name` 和 `repo`
5. 前端 HTML 直接手写，每个页面独立写 `<script>`，不用框架
6. 密码/Token 全部走 Render 环境变量，源码零硬编码
7. 数据持久化套用 GitHub API 方案（`ghPush` / `ghPull` 模式）
