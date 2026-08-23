# Scriverse Desktop

叙界（Scriverse）的独立桌面客户端。

本仓库只维护 Electron 桌面壳、桌面端本地存储、离线同步、本地 AI 配置和打包发布链路，不复制 Scriverse Server、Web 前端、showcase 或 demo 源码。

## 开发

```bash
npm ci
npm run check
```

启动、运行时验收或打包前，需要提供由兼容版本 Scriverse 构建得到的 `dist` 目录：

```bash
SCRIVERSE_RUNTIME_DIR=/path/to/Scriverse/dist npm run start
```

`dist/` 仅作为本地构建产物写入，不进入 Git。
