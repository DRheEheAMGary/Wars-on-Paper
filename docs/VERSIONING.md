# 版本约定 — Wars on Paper

> 适用对象：项目版本、协议版本、状态版本、数值数据版本。
> 本文是唯一权威版本规范；`AGENT.md` 与发布流程均引用本文。

---

## 1. 总原则

1. **项目版本遵循语义化版本 [SemVer 2.0.0](https://semver.org/lang/zh-CN/)**：`MAJOR.MINOR.PATCH`。
2. **单一事实来源**：`package.json` 的 `version` 字段是项目版本的唯一来源；Git tag、CHANGELOG、页面展示必须与之一致。
3. **0.y.z 为开发期**：`1.0.0` 在 M6 公网上线时发布；1.0 之前不承诺兼容性。
4. **文档版本 ≠ 项目版本**：`docs/PLAN.md` 顶部的 `v0.2` 是文档修订号，与项目版本无关，不要混用。
5. **不重复造版本号**：除项目版本外，只允许三个独立的兼容性编号（协议、状态、数值），见第 5 节。

---

## 2. 项目版本号含义

格式：`MAJOR.MINOR.PATCH[-prerelease.N]`，Git tag 加 `v` 前缀。

| 位置 | 含义 | 何时递增 |
| --- | --- | --- |
| MAJOR | 不兼容的大版本 | 1.0.0 之前恒为 0；1.0 之后：协议/存档/外部接口不兼容时 +1 |
| MINOR | 里程碑或新玩法 | 每个里程碑完成时 +1（M0→0.1.0，M1→0.2.0 …） |
| PATCH | 修复 / 平衡 / 文档 / 性能 | 里程碑之间需要发布的修复 +1；纯内部改动不 bump |
| prerelease | 预发布标识 | `-alpha.N` 开发中、`-beta.N` 联调、`-rc.N` 发布候选 |

规则细节：

- 1.0 之前，破坏性改动通过 **MINOR** 递增表达（SemVer 的 0.x 惯例）。
- **数值平衡调整**（只改 `data/balance.json`，不改数据结构与接口）归为 **PATCH**。
- 不使用 build metadata（`+build`）；tag 保持 `vX.Y.Z` 简洁形式。
- 版本号只允许在发布时修改；开发过程中 `package.json` 保持上一个已发布版本，改动记录在 CHANGELOG 的 `[Unreleased]` 下。

### 里程碑与版本映射

| 阶段 | 版本 | 内容 |
| --- | --- | --- |
| 当前（仅文档） | 无（尚未创建 package.json） | 仓库初始化、计划、版本/协作约定 |
| M0 | `0.1.0` | 工程骨架 + 免编译开发服务器 |
| M1 | `0.2.0` | 地图生成 + Canvas 渲染原型 |
| M2 | `0.3.0` | 单机核心循环 |
| M3 | `0.4.0` | AI + 单机完整（首个可玩版本） |
| M4 | `0.5.0` | 多人联网（多人可玩） |
| M5 | `0.6.0` | 科技 / 外交 / 建筑 / 平衡 |
| M6 | `1.0.0` | 视觉打磨 + 性能 + 公网上线 |

- 里程碑内的紧急修复：`0.3.1`、`0.3.2` …
- 发布候选：`1.0.0-rc.1` → `1.0.0-rc.2` → `1.0.0`
- 1.0.0 之后：新玩法 = MINOR，修复/平衡 = PATCH，不兼容变更 = MAJOR。

---

## 3. 唯一来源与一致性

以下位置必须同步，缺一不可：

| 位置 | 要求 |
| --- | --- |
| `package.json` → `version` | 唯一事实来源 |
| Git tag | annotated tag `vX.Y.Z`，指向发布提交 |
| `CHANGELOG.md` | 存在 `## [X.Y.Z] - YYYY-MM-DD` 小节 |
| 页面页脚 | 显示 `vX.Y.Z`（多人时附带协议版本） |
| 服务器启动日志 | 打印 `app version`、`protocol version`、`state version` |

一致性检查（发布前人工执行）：

```bash
node -e "console.log(require('./package.json').version)"   # 应与 tag 一致
git tag --points-at HEAD
git log -1 --oneline
```

---

## 4. 发布流程（无需构建）

1. `npm test` 全绿，并完成当前里程碑的手动验收清单。
2. 更新 `CHANGELOG.md`：把 `[Unreleased]` 改为 `[X.Y.Z] - YYYY-MM-DD`，补一条新的 `[Unreleased]`。
3. 修改 `package.json` 的 `version`。
4. 提交：`chore(release): vX.Y.Z`。
5. 打 annotated tag 并推送：
   ```bash
   git tag -a vX.Y.Z -m "Wars on Paper vX.Y.Z"
   git push origin main --tags
   ```
6. 部署**该 tag**（不是分支头），按部署文档执行。
7. 冒烟验收：单机开一局、双浏览器多人一局、版本握手正常、页脚版本正确。
8. 出问题回滚：重新部署上一个 tag；**禁止删除或重写已发布 tag**。

---

## 5. 兼容性版本（与项目版本独立）

这三个编号不参与 SemVer 递进，只用于运行时兼容判断。

### 5.1 协议版本 `PROTOCOL_VERSION`

- 位置：`src/shared/constants.js`，整数，首个联网版本（M4）为 `1`。
- 递增条件：消息字段改名/删除、语义变化、请求-响应顺序变化等**任何客户端与服务器不兼容**的改动。
- **不**递增：新增可选字段（双方必须忽略未知字段）、纯文案改动、纯服务端内部改动。
- 握手：客户端 `hello` 携带 `protocol`；服务器不一致时返回
  `error { code: 'PROTOCOL_MISMATCH' }`，客户端提示「版本已更新，请刷新页面」。
- 开发期两端同源部署，正常不会不一致；主要用于防止上线后旧标签页继续连接。

### 5.2 状态版本 `STATE_VERSION`

- 位置：`src/shared/constants.js`，整数，初始为 `1`。
- 用于 `MatchState` 结构与快照格式；不兼容变更 +1。
- v1 **不做状态迁移**：版本不一致时服务器重开对局、客户端丢弃本地缓存并请求全量快照。
- 快照/增量消息中携带该版本号，客户端不匹配则强制刷新。

### 5.3 数值版本 `balance.version`

- 位置：`data/balance.json` 顶层的 `"version"`（整数，每次数值调整 +1）。
- 每局开始时记录到对局元数据（日志/结算），便于复盘「这局用的是哪版数值」。
- 纯数值调整不改变 `PROTOCOL_VERSION` / `STATE_VERSION`，但项目版本按 PATCH 递增并写入 CHANGELOG。

---

## 6. 分支与提交

- 主分支 `main` 始终可部署；发布点即 tag。
- 功能分支命名：`feat/<简短描述>`、`fix/<简短描述>`、`docs/<简短描述>`，完成后合并回 `main`。
- 提交信息使用 Conventional Commits：`<type>(<scope>): <summary>`（英文）。
  - type：`feat` `fix` `docs` `refactor` `test` `perf` `balance` `chore`
  - scope：`sim` `map` `ui` `net` `server` `data` `docs` `release`
- 一个提交只做一件事；禁止在功能提交里夹带无关格式化。
- 禁止 `force-push main`；禁止改写已发布的 tag。

---

## 7. 缓存与部署（无构建的注意事项）

- HTML 入口使用 `Cache-Control: no-cache`，保证刷新拿到最新模块。
- JS/CSS 静态资源可用 `ETag` + 短缓存（如 5 分钟），发布后自然过期。
- 不使用文件名 hash（无构建），因此**协议/状态版本号是防止旧客户端连新服务器的最后一道保险**。
- 回滚以 tag 为单位整体回滚，不单独回滚单个文件。

---

## 8. 常见问题

**Q：改了一个数值，要发新版本吗？**
A：不强制。只留在 `[Unreleased]`；如果要把这次调整交付给玩家，按 PATCH 发布。

**Q：M3 完成后发现一个 bug，修在 M4 期间，版本怎么走？**
A：M3 = `0.4.0`；修复期间保持 `0.4.0` + Unreleased 记录；若需立即发布修复 → `0.4.1`；M4 完成 → `0.5.0`。

**Q：协议加了一个可选字段，要不要动 `PROTOCOL_VERSION`？**
A：不动。双方解析时必须忽略未知字段；若做不到忽略，就必须 +1。

**Q：文档里的 v0.2 需要跟着改吗？**
A：不需要。文档修订号独立维护，只在文档内容有结构性变化时 +1。
