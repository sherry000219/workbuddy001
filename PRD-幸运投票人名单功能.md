# PRD · 幸运投票人名单（奖池瓜分 / 抽奖资格公示）v1.1

版本：v1.1（已按确认决策更新）
日期：2026-07-23
关联：赛段投票功能（现有）

---

## 1. 背景与目标

现有赛段投票已按人记录（`db.votes`：`voterId`/`voterName`/`voterAvatar`/`entryId`/`stage`/`createdAt`）。
新增诉求：**作品晋级/获奖时，当初在对应赛程投票支持它的人，获得该赛程抽奖资格**。本期只做"计算各赛程支持者名单 + 网页公示"，抽奖/奖池执行与获奖公布在线下员工社区完成。

---

## 2. 确认的设计决策（用户拍板）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 晋级口径 | **晋级即算（口径 A）**：作品只要"晋级过任一轮"或"获奖"，其对应赛程的支持者即合格（参考原 PRD 决策点 1 的选项 A） |
| 2 | 去重 / 重名 | 投票人经钉钉实名认证，每人每赛程最多 5 票；基本不会重名；若重名，**头像不同**足以区分 → 展示头像+昵称，去重主键用 `voterId` |
| 3 | 抽奖票数 | **每赛程参与 1 次抽奖**，即每个合格投票人在该赛程 = 1 票（不按支持作品数叠加） |
| 4 | 公布时机 | **进入下一赛程时，管理员手动开启** `luckyListEnabled` 展示本赛程支持者名单 |
| 5 | 隐私 | 公开仅展示：头像 + 昵称 + 支持作品 + 结果；不暴露 openId / 手机号 |
| — | 奖池/获奖 | 奖池金额与最终获奖情况在**员工社区**公布，本平台不展示 |

### 关键模型：按赛程分轮（每轮 = 一次晋级事件）
- 初赛投票支持、且最终**晋级出初赛**（→semi_finalist / finalist / eliminated_final / awarded）者 → 进入**初赛轮**抽奖名单
- 复赛投票支持、且最终**晋级出复赛**（→finalist / eliminated_final / awarded）者 → 进入**复赛轮**抽奖名单
- 决赛投票支持、且最终**获奖**（→awarded）者 → 进入**决赛轮**抽奖名单
- 每个赛程轮次独立成表；同一人可在多轮出现（各计 1 票）。
- 名单**动态计算、不落库**，永远与当前赛况一致；`luckyListEnabled` 仅控制是否公开。

---

## 3. 数据模型变更（极小）

1. `DEFAULT_DB.settings` 新增 `luckyListEnabled: false`（自动迁移，向后兼容）。
2. `db.votes` 投票记录新增字段 `voterAvatar`（写入时取 `req.ddUser.avatarUrl`）；旧数据缺该字段时展示占位头像。
3. 不改动 `entries` 任何字段。

---

## 4. 后端接口

### 4.1 `POST /api/votes/:entryId`（现有，增量）
投票落库时增加：
```js
db.votes.push({
  entryId, voterId: userId, voterName: req.ddUser.nick,
  voterAvatar: req.ddUser.avatarUrl || '',   // 新增
  stage, createdAt
});
```

### 4.2 `GET /api/lucky/list`（新增，公开，无需登录）
计算各赛程轮次名单：
```js
const STAGE_ADV = {
  preliminary: ['semi_finalist','finalist','eliminated_final','awarded'],
  semi_final: ['finalist','eliminated_final','awarded'],
  final:       ['awarded']
};
// 对每个来源赛程 S：qualIds = 当前 roundStatus 命中 STAGE_ADV[S] 的作品 id 集合
// 支持者 = 在赛程 S 投过票 且 entryId ∈ qualIds 的投票人（按 voterId 去重）
// 每人 tickets = 1；展示 entries = 其在本赛程支持且晋级的作品列表（含 result 徽章）
```
返回：
```json
{
  "enabled": false,
  "summary": { "rounds": 2, "totalVoters": 18, "totalTickets": 18 },
  "rounds": [
    {
      "stage": "preliminary", "label": "初赛", "total": 12,
      "voters": [
        { "voterName": "张三", "voterAvatar": "https://...", "tickets": 1,
          "entries": [ { "title": "PDF工具箱", "result": "复赛晋级" } ] }
      ]
    }
  ]
}
```
隐私：仅返回 `voterName` / `voterAvatar` / `entries`，**不含 openId / 手机号**。

### 4.3 `POST /api/settings`（现有，增量）
新增接受 `luckyListEnabled` 字段，写入 `db.settings` 并触发 GitHub 同步（与现有 currentStage 等一致）。管理员"进入下一赛程时"开启。

---

## 5. 前端页面

### 5.1 公开公示页 `public/app/lucky.html`（新增，无需登录）
- 拉取 `/api/lucky/list`。
- `enabled === false` → 显示"🎁 幸运名单公布中，敬请期待"。
- `enabled === true` → 按轮次渲染：每轮标题（如"🎁 初赛 · 幸运支持者（参与本赛程抽奖）"）+ 支持者卡片（头像 + 昵称 + 支持作品 + 结果徽章 + 1 票）。

### 5.2 管理员面板 `public/app/admin.html`（新增"🎁 幸运名单"标签）
- 始终可预览各轮名单（不受 `enabled` 限制，作为"获取名单"操作台）。
- **导出 CSV** 按钮（昵称、头像URL、支持作品、结果、票数）。
- **`luckyListEnabled` 开关**（开启/关闭公开公示）。

### 5.3 首页 `public/app/index.html`
- 拉取 `/api/lucky/list` 的 `enabled` 标志；为 `true` 时显示"🎁 幸运投票人名单"入口链接到 `lucky.html`。

---

## 6. 实施步骤

1. `server.js`：`DEFAULT_DB.settings` 加 `luckyListEnabled:false`；`POST /api/votes` 加 `voterAvatar`；新增 `getLuckyRounds()` + `GET /api/lucky/list`；`POST /api/settings` 接受 `luckyListEnabled`。
2. 新增 `public/app/lucky.html`（公开公示页）。
3. `admin.html`：新增"🎁 幸运名单"标签（预览 + CSV 导出 + 开关）。
4. `index.html`：按 `enabled` 条件显示入口。
5. 本地起服务 + 种子数据验证：晋级/获奖作品支持者正确分轮入名单、去重、1 票、头像、开关控制可见性、CSV 导出。
6. `node --check` 全量校验 → 提交 → 推 `origin/main` 触发 Render 部署。
