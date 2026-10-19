# Wars on Paper

网页端实时领土争夺游戏：地图由上百个城市节点组成，每座城市拥有一块边缘随机的领土并铺满全图；玩家占领城市吞并领土，在 10–20 分钟内以城市数量与领土占比决出胜负。

- **单机**：与 1–7 个 AI 抢先扩张、争夺城市。
- **多人**：单房间 16–32 人在线乱斗。
- **技术**：免编译 —— 原生 ES Module + Canvas 2D + Node.js，改完刷新即生效。

## 当前状态

规划阶段，尚未开工。首个版本 `0.1.0` 将在 M0（工程骨架）完成时发布。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | 玩法设计、数值、技术架构、里程碑计划 |
| [docs/VERSIONING.md](docs/VERSIONING.md) | 版本号规则、协议/状态版本、发布流程 |
| [AGENT.md](AGENT.md) | AI 协作约定（面向 Agent 与协作者） |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录 |

## 计划中的启动方式

```bash
npm install          # 仅安装 ws（唯一运行依赖）
npm run dev          # 开发服务器，浏览器打开 http://localhost:8080
npm run server       # 静态资源 + 多人 WebSocket 服务器
npm test             # node --test
```

> 以上命令将在 M0 里程碑落地。
