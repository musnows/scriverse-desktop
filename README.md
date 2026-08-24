<p align="center">
  <a href="https://scriverse.top/">
    <img src="./assets/icon-128.png" alt="叙界 Scriverse Desktop" width="96">
  </a>
</p>

<h1 align="center">Scriverse Desktop</h1>

<p align="center">
  叙界的独立桌面客户端
</p>

<p align="center">
  <a href="https://github.com/musnows/Scriverse">Scriverse 原项目</a> ·
  <a href="https://scriverse.top/">项目主页</a>
</p>

Scriverse Desktop 为长篇小说创作工作台 [叙界 Scriverse](https://github.com/musnows/Scriverse) 提供原生桌面入口。它既可以在当前设备上运行独立的本地工作区，也可以连接受信任的 Scriverse Server，并为每个工作区隔离登录状态、本机数据与离线副本。

本仓库只维护 Electron 桌面客户端、桌面端本地存储、离线与同步边界、本地 AI 配置和打包发布链路。Scriverse Server、Web 前端及完整产品能力由[原项目](https://github.com/musnows/Scriverse)维护，本仓库不复制其后端、Web、showcase 或 demo 源码。

## 主要能力

- 本地工作区：在当前设备上启动随包提供的兼容 Scriverse 运行时，数据与远程 Server 完全隔离。
- 远程工作区：直接使用 Scriverse Server 的 Desktop 登录能力，登录令牌由软件使用 Server 同款 `master.key` 加密保存，不依赖外部浏览器 Cookie 或操作系统凭据存储。
- 工作区隔离：每个 Server 使用独立的浏览器分区、登录状态、离线数据和本机副本。
- 离线访问：当 Server 提供兼容的 Desktop 协议时，可以打开已下载的离线副本，并跟踪待同步修改、冲突与拒绝状态。
- 本地 AI：单独配置只在本机使用的供应商、模型和追加系统提示词，支持本地部署的模型服务。

## 使用

当前 Desktop 版本为 `0.1.1`，对应 Scriverse Server `0.9.0`。兼容版本同时记录在 [`package.json`](./package.json) 的 `scriverseServerVersion` 字段中。

启动 Desktop 后，可以直接进入“本地工作区”，或在最外层工作区选择页新增 Scriverse Server。远程 Server 的地址、账号和离线数据彼此独立；“本地 AI 配置”也只保存在当前设备。

当前维护和本地打包以 Apple Silicon Mac 为主，Intel Mac 不在支持范围内；有需要的用户可以自行从源码构建。

## 开发

### 环境要求

- Node.js `>= 22.5.0`
- npm
- 与当前 Desktop 版本兼容的 [Scriverse](https://github.com/musnows/Scriverse) 构建产物

### 安装依赖与检查

```bash
npm ci
npm run check
```

### 启动

先在原 Scriverse 项目中生成 `dist`，再将其作为 Desktop 本地运行时传入：

```bash
SCRIVERSE_RUNTIME_DIR=/path/to/Scriverse/dist npm run start
```

### 打包

```bash
SCRIVERSE_RUNTIME_DIR=/path/to/Scriverse/dist npm run package
npm run verify:package
```

运行时 `dist/` 仅作为本地构建产物写入，不进入 Git。

## 项目结构

```text
assets/          桌面应用图标
src/main/        Electron 主进程、工作区与凭据存储
src/preload/     受限的 Desktop IPC 桥接
src/renderer/    工作区选择和本地 AI 配置界面
src/shared/      主进程、预加载与页面共享契约
src/utility/     本地 Server 和运行时验收子进程
tests/desktop/   Desktop 单元与契约测试
```

## 原项目

Scriverse 的作品管理、正文编辑、设定库、时间线、人物关系、AI 创作助手、部署方式和 Server 配置等完整说明，请阅读 [Scriverse README](https://github.com/musnows/Scriverse#readme)。

## 许可证

Copyright (C) 2026 musnows

本项目采用 [GNU Affero General Public License v3.0 only](./LICENSE)（`AGPL-3.0-only`）授权。
