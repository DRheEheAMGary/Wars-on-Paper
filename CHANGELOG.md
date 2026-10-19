# Changelog

本文件记录 Wars on Paper 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)，版本规则见 [`docs/VERSIONING.md`](docs/VERSIONING.md)。

## [Unreleased]

## [0.1.0] - 2026-10-19

### Added

- 工程骨架：零依赖静态服务器、开发服务器（SSE 热刷新）、主菜单空壳、亮色纸面主题
- `npm run dev` / `npm run server` / `npm test` 脚本与 Node 内置测试基线
- 静态服务器路径安全测试（路径穿越、非法编码）
- 游戏设计与开发计划 `docs/PLAN.md`（玩法、数值、架构、里程碑）
- 版本约定 `docs/VERSIONING.md`（项目版本、协议版本、状态版本、发布流程）
- AI 协作约定 `AGENT.md`
- 项目 README 与 GitHub 公开仓库

### Changed

- 计划 v0.2：城市数上调（单机默认 160、多人默认 240，可选至 360）；多人中途加入改为优先空降空白区域
- 本地开发端口改为 8787（8080 常被其他工具占用）
