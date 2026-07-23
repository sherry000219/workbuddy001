# PRD｜投稿自编辑功能（我的投稿 · 可修改 / 可重传附件）

> 版本：v1.1（决策点已确认）
> 日期：2026-07-23
> 关联项目：云帐房 WorkBuddy 实战应用大赛平台
> 仓库：`sherry000219/workbuddy001`｜线上：`https://workbuddy-contest.onrender.com`

---

## 1. 背景与目标

当前投稿流程为「一次性提交」：用户提交后**无编辑入口**，想改只能找管理员删除旧作品再重新提交；附件（海报）也无法单独重传。

**目标**：提供「我的投稿」入口，允许用户**仅修改本人作品**的内容与附件，降低修改成本、减轻管理员负担，同时保证评审公平不被破坏。

---

## 2. 功能范围

### ✅ In Scope
| 能力 | 说明 |
|------|------|
| 我的投稿列表 | 登录后显示「我的投稿 (N)」，列出本人全部作品 |
| 编辑本人作品 | 打开预填表单，修改允许的字段后提交 |
| 附件保留 / 重传 | 编辑时可「保留当前海报」或「重新上传替换」 |
| 阶段锁定 | 已获奖作品锁定，不可再改 |
| 权限隔离 | 只能编辑 `mobile` 与本人钉钉登录一致的作品 |
| 评委更新提醒 | 编辑后标记「内容有更新」，评委/管理员可见提醒，可标记已读 |

### ❌ Out of Scope（本期不做）
- 管理员代编辑（仍走现有「删除 + 用户重投」）；
- 多人协作编辑同一作品（团队作品仅提交人可改）；
- 编辑留痕 / 版本历史；
- 撤回已提交投稿（如需下线仍走管理员删除）。

---

## 3. 权限模型（已确认）

**匹配标识：`mobile`**
- 钉钉 OAuth 登录返回 `req.ddUser.mobile`，作品入库时已存 `entry.mobile`；实测现有 4 条作品 mobile 全部非空且唯一。比 `openId` 可靠（`openId` 在用户重新授权钉钉时可能变化）。
- 规则：编辑接口校验 `entry.mobile === req.ddUser.mobile`，不一致返回 `403`。

**阶段锁定规则（已确认：未获奖即可改）**

| roundStatus | 含义 | 是否可编辑 |
|-------------|------|-----------|
| `approved` | 初赛待评 | ✅ 可编辑 |
| `semi_finalist` | 复赛晋级 | ✅ 可编辑 |
| `finalist` | 决赛晋级 | ✅ 可编辑 |
| `eliminated_semi` / `eliminated_final` | 淘汰 | ✅ 可编辑 |
| `awarded` | 已获奖 | 🔒 锁定 |

> 锁定后前端不显示「编辑」按钮，接口也拒绝（`403 locked`）。

---

## 4. 可编辑字段（已确认）

| 字段 | 可编辑 | 说明 |
|------|--------|------|
| `title` 作品标题 | ✅ | 必填 |
| `track` 赛道 | ✅ | 含「其他」选项 |
| `scene` 场景描述 | ✅ | 200 字以内文字 |
| `process_text` / `process_link` 使用过程 | ✅ | 文字简介 + 链接 |
| `result_text` / `result_link` 效果呈现 | ✅ | 文字简介 + 链接 |
| `attachment` 海报 | ✅ | 保留原图 / 重传替换 |
| `entryType` 参赛形式 | ❌（已确认不可改） | 个人/团队属性冻结，防评审维度错乱 |
| `name` / `dept1~3` / `mobile` | ❌ | 取自钉钉身份，防冒名 |

**编辑不影响**：`roundStatus`、`award`、`已有投票数`、`评委打分`、`createdAt`、`entryType`、`teamName`、`teamMembers`。
**编辑会写入**：内容字段 + `updatedAt` + `lastEditedAt` + `editNotice=true`（提醒评委）。

---

## 5. 服务端 API 设计

### `PUT /api/entries/:id`
- 中间件：`requireAuth` + `upload.single('attachment')`（附件可选）
- 流程：
  1. 查 `entry`；不存在 → `404`
  2. `entry.mobile !== req.ddUser.mobile` → `403`（非本人）
  3. `entry.roundStatus === 'awarded'` → `403 locked`
  4. 字段校验：标题必填；`scene` ≤ 200 字；`process_text`/`result_text` 必填；链接格式校验（空链接允许）
  5. 附件：若 `req.file` 存在 → 校验图片 MIME → 替换 `attachmentName` + `attachmentBase64`；否则保留原值
  6. 更新内容字段 + `updatedAt` + `lastEditedAt` + `editNotice=true`
  7. `saveDB()`，返回 `{ success: true }`

### `POST /api/entries/:id/ack-edit`
- 中间件：`requireAuth`（评委或管理员）
- 将 `entry.editNotice` 置 `false`，返回 `{ success: true }`
- 用途：评委/管理员看到更新提醒后标记已读。

> 两者均复用现有 GitHub 同步（saveDB → 1s 推送 `data` 分支），无需额外改动。

---

## 6. 前端改动

| 页面 | 改动 |
|------|------|
| `public/app/index.html` | 登录态下顶部增加「我的投稿 (N)」按钮 → 弹窗列出本人作品（按 `mobile` 过滤）；每条带「编辑」按钮（awarded 隐藏）；详情弹窗增加「📝 最近编辑提醒」横幅（当 `editNotice`） |
| `public/app/submit.html` | 抽离编辑模式：URL 带 `?edit=<entryId>` 时预填原值、隐藏参赛形式区块、附件区显示「保留当前海报 + 重新上传」；提交走 `PUT` 而非 `POST` |
| `public/app/browse.html` | 同步增加「我的投稿」入口（与首页一致） |
| `public/app/judge.html` | 详情弹窗增加「📝 内容有更新」提醒横幅 + 「已知悉」按钮（调用 ack-edit） |
| `public/app/admin.html` | 详情弹窗增加「📝 内容有更新」提醒横幅 + 「已知悉」按钮 |

**编辑表单交互**：打开即预填；附件区默认「保留当前海报」（显示缩略图），提供「重新上传」切换；提交后提示「已更新」并刷新。

---

## 7. 数据兼容性
- 现有 4 条作品：mobile 均非空，均非 awarded → 全部可正常编辑。
- 旧附件丢失：pre-base64 时代 4 张海报已丢，编辑时重传即可补全。
- 字段缺失兼容：缺 `process_link` 等按空值处理，保存时补全；`lastEditedAt`/`editNotice` 旧数据缺省为 `null`/`false`。

---

## 8. 测试要点
1. 本人登录 → 「我的投稿」列表数量正确；
2. 编辑标题/赛道/场景 → 保存后列表与详情更新，GitHub `data` 分支同步；
3. 附件「保留」→ 原图不变；「重传」→ 新图生效、可下载；
4. 他人账号访问编辑 → `403`；
5. 将某作品 roundStatus 改 `awarded` → 编辑按钮消失、接口拒绝；
6. 编辑后评委页弹窗显示「内容有更新」提醒；点「已知悉」后消失；
7. 编辑后投票数 / 评委分 / 获奖状态不变；
8. 重新部署（Render 重启）→ 编辑内容不丢失。

---

## 9. 上线与回滚
- 改动文件：`server.js`、`public/app/index.html`、`public/app/submit.html`、`public/app/browse.html`、`public/app/judge.html`、`public/app/admin.html`
- 提交后 Push 至 `main`，Render 自动部署；回滚 `git revert` 即可，数据不受影响。

---

## 10. 决策点确认记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 锁定阶段边界 | ✅ **未获奖即可改**；`awarded` 锁定 |
| 2 | 团队作品编辑权 | ✅ 仅提交人（mobile 匹配）可改 |
| 3 | 能否改参赛形式 | ❌ **不可改**（个人/团队属性冻结） |
| 4 | 编辑后是否重审 | ✅ 无需重审；但标记 `editNotice` 提醒评委，可「已知悉」消除 |
| 5 | 附件默认行为 | ✅ 默认保留原图，可选重传 |
