# Scriverse Desktop 开发指南

本文件适用于 Scriverse Desktop 仓库全部目录。子目录存在更具体的 `AGENTS.md` 时，以其补充约束为准。

## 1. 项目边界

Scriverse Desktop 是 Scriverse 的 Electron 桌面客户端，当前版本为 `1.0.2`。仓库只维护桌面壳、本地工作区编排、远端 Server 连接、软件内登录、本地 AI、离线同步和打包安装能力。

- Scriverse Server 与 Web 源码由 `musnows/Scriverse` 维护，禁止复制前后端、showcase 或 demo 源码到本仓库。
- Desktop 通过 `scripts/prepare-runtime.mjs` 引入已构建 Server runtime，并通过 `runtime-overlay/` 维护必要的 Desktop Web 差异。
- 禁止把 Desktop 源码提交到 Scriverse 前后端仓库。
- 工作区选择只存在于最外层 Selector；进入工作区后的页面应尽量与对应 Server Web 保持一致。

## 2. 目录职责

```text
src/main/                 Electron Main、窗口、认证、存储和本地服务编排
src/preload/              最小化、具名、只读边界清晰的 contextBridge
src/renderer/selector/    工作区选择、软件内登录和系统设置
src/renderer/local-ai/    本地 AI 配置入口
src/shared/               Main、Preload 与 Renderer 共用的严格契约
src/utility/              Electron UtilityProcess 中运行的本地 Server
runtime-overlay/          Desktop Web patch 与离线同步模块
tests/desktop/            Desktop 单元、契约和静态集成测试
scripts/                  runtime 准备、打包和产物验证
```

## 3. 认证与凭据存储硬约束

### 禁止操作系统凭据存储

所有平台均禁止调用或依赖操作系统凭据存储：

- macOS Keychain、Electron `safeStorage`；
- Windows DPAPI、Credential Manager；
- Linux Secret Service、GNOME Keyring、KWallet；
- 任何会弹出系统密码、钥匙串或凭据授权提示的实现。

`FuseV1Options.EnableCookieEncryption` 必须保持 `false`。禁止以安全加固为由重新开启。

### 允许的本地 `master.key`

Desktop 使用与 Scriverse Server `CredentialVault` 一致的方式保存有限的敏感字段：

1. 在 Desktop 私有数据目录生成权限为 `0600` 的 `master.key`；
2. 对主密钥字符串做 SHA-256；
3. 使用 AES-256-GCM，并分别保存 `encrypted`、`iv`、`tag`。

只允许以下内容使用该加密：

- 本地或远端 Server 的 Desktop 登录令牌或等价登录凭据；
- AI 供应商 API Key，包括 Desktop 本地 AI Key。

禁止加密作品、章节、设定、离线快照、冲突记录、IndexedDB、缓存、窗口状态、工作区配置或其他客户端数据。本项目不考虑终端被同一用户权限恶意读取的攻击模型，不得增加新的客户端静态加密层。

### 禁止浏览器 Cookie 登录

- 本地和远端工作区都必须使用 Scriverse Desktop Bearer 会话。
- 登录由软件内 UI 和 Main/UtilityProcess 直接完成，禁止依赖 Safari、Chrome 或其他外部浏览器。
- 工作区 partition 只能按精确 origin 注入 `Authorization: Bearer ...`，并剥离请求 Cookie 与响应 `Set-Cookie`。
- 禁止在 Main、Preload、Renderer 或 Web overlay 中调用 `cookies.set` 保存登录态。

## 4. 数据与测试边界

- 默认数据目录包含真实用户数据，禁止用于写入型测试、删除、覆盖或重建。
- Desktop 开发、原生验收和写入型测试必须使用第 5 节的隔离启动方式；禁止把用户已安装的 Desktop 作为测试目标。
- 离线内容按 profile 与用户隔离，但不加密；不得重新引入离线密钥桥接或 AES-GCM 快照字段。
- 文件写入使用原子替换和受控权限；不得把密码、Bearer Token 或 AI API Key 写入日志、错误消息或测试快照。
- 禁止使用 `rm`，清理临时文件使用 `rmtrash`。数据库 `DROP`、`DELETE` 仅可针对本次构造的测试数据库，否则必须先征得用户同意。

## 5. 开发与测试 Electron 实例隔离（强制）

开发或测试必须创建当前 worktree 的独立 Electron 实例，不得启动、覆盖、替换或退出用户正在使用的已安装 Desktop。macOS 上的 `/Applications/叙界.app` 是用户应用，任何开发验收都不得以它为目标。

- 默认使用 `npm run start`。该命令会准备兼容 Server runtime、构建当前 worktree，并调用 `scripts/start-dev-isolated.mjs` 启动 `node_modules` 中的 Electron 和当前 worktree 的 `build/main/main.js`；它不会打开或修改 `/Applications/叙界.app`。
- `start-dev-isolated.mjs` 每次启动都创建新的系统临时数据根目录，并在 `20001` 到 `60000` 范围内分配独立的本地 Server 首选端口，然后注入 `SCRIVERSE_DESKTOP_DEV_MODE=isolated`、`SCRIVERSE_DESKTOP_DATA_DIR` 和 `SCRIVERSE_DESKTOP_DEV_PORT`。必须记录启动日志中的数据目录、端口和进程；并行启动多个实例时每个实例都要单独执行该命令，不得复用数据目录或端口。
- Main 进程只允许带有完整隔离环境的非打包正常启动。缺少隔离模式、绝对数据目录或有效开发端口时必须拒绝启动；`app.setPath("userData")`、`sessionData`、`crashDumps` 和日志路径必须在申请单实例锁之前指向该实例目录。这样每个实例的 profile、master key、本地数据库、浏览器会话、远端媒体缓存、日志、崩溃转储、Electron 锁和本地 Server 端口都彼此独立。
- 禁止直接执行没有隔离环境的 `electron build/main/main.js`、`npm run start` 之外的自定义 Electron 启动命令，或通过 `open` 启动已安装应用。若必须调试主进程，仍需显式设置 `SCRIVERSE_DESKTOP_DEV_MODE=isolated`、绝对且本次新建的 `SCRIVERSE_DESKTOP_DATA_DIR` 和未占用的 `SCRIVERSE_DESKTOP_DEV_PORT`；优先复用隔离启动脚本。
- `npm run gate` 是只做 runtime gate 的例外，不打开正常 Desktop 窗口，也不申请正常 UI 的单实例锁；打包验收必须运行当前 worktree `out/` 下刚生成的 App，并使用专用 gate 数据目录，禁止把产物复制或安装到 `/Applications`、用户桌面或其他实际安装位置。
- 写入型 E2E 必须使用专用测试数据目录和端口；禁止指向默认 Desktop 数据目录、用户本地数据库或已安装应用。临时目录只允许在确认目标是本次创建的目录后使用 `rmtrash` 清理，不得使用 `rm`，也不得清理整个系统临时目录。

## 6. 窗口、端口与 UI

- 本地 Server 端口必须大于 `20000`；首选端口占用时向上探测最多 20 个端口。
- 涉及 bind port 的开发服务使用 tmux 启动，并显式指定有效工作目录或独立 socket。
- 切换工作区不得表现为软件重启，窗口必须保持在原显示器。
- 新 UI 复用现有 Selector 或 Server Web 的组件、字体、尺寸和交互，不另起一套视觉语言。
- 前端修改必须使用 Computer Use 或内置浏览器检查真实截图；至少覆盖桌面和 `390×844` 窄屏、控制台错误、溢出、遮挡和可访问名称。
- 不使用 Emoji；中文使用非衬线字体，英文和标识符使用等宽字体。

## 7. 构建与验证

常用命令：

```bash
npm run typecheck
npm test
npm run build
SCRIVERSE_SOURCE_DIR=/absolute/path/to/Scriverse npm run runtime:prepare
SCRIVERSE_SOURCE_DIR=/absolute/path/to/Scriverse npm run package
npm run verify:package
```

- Vitest 默认使用 8 workers。
- 每次变更至少运行直接相关测试、类型检查和构建。
- runtime overlay 变更必须验证 `runtime:prepare` 可对最新兼容 Server runtime 正向应用。
- Runtime overlay 启动节点必须保持完整闭环：`runtime-overlay/web.patch` 中新增或保留的启动期 `querySelector`、`$("#...")`、`getElementById` 和 `addEventListener` 引用，必须在同一 overlay 应用后的 `public/index.html` 中存在对应静态节点；禁止只保留事件监听而遗漏 HTML 对话框、按钮或容器。
- 每次重生成、rebase 或切换兼容 Server runtime 后，必须使用精确的 Server Release tag 在干净目录执行 `runtime:prepare`，运行 `node --check dist/public/app.js`，并用回归测试核对启动期 DOM 引用和静态节点一一对应；不得只根据 patch 文件能提交或 TypeScript 测试通过就判定客户端可启动。
- 发布前必须实际启动打包后的 Desktop，确认工作区选择页或目标工作区能离开加载遮罩，并检查控制台没有 `Cannot read properties of null`、`addEventListener` 或其他新增启动错误；若发现启动错误，必须先修复并单独提交，再继续版本发布。
- 最终安装前必须运行 `verify:package`、`codesign --verify --deep --strict`，并使用 Computer Use 验证安装后的 App。
- 本地维护和安装只要求 Apple Silicon Mac；不在本机尝试 Intel Mac 打包。不得因此删除 CI。

## 8. Git 分支、CI 与发布规范

### 分支职责

- `develop` 是唯一日常开发与功能集成分支。所有功能、修复、文档、CI 和构建改动都必须从最新的 `origin/develop` 派生，并通过指向 `develop` 的 PR 集成；禁止基于 `main` 开发或直接向 `main` 提交开发改动。
- `develop` 是长期保留的集成分支，禁止删除远程或本地 `develop`；从 `develop` 向 `main` 发布时不得使用删除源分支的合并选项，合并后必须核对 `develop` 仍存在且指向预期提交。
- `main` 只用于发版。只有准备发布时，才允许创建从 `develop` 指向 `main` 的 PR；禁止功能分支、修复分支或维护分支直接指向 `main`。
- 指向 `develop` 的 PR 不运行 GitHub CI，也不要求远端状态检查；这不免除本地验证，提交者仍必须完成与改动直接相关的测试、`npm run check` 和必要的真实打包验证。
- 指向 `main` 的 PR 才运行 `Desktop checks`。禁止为 `push`、指向 `develop` 的 PR 或其他普通分支自动触发该检查。

### Desktop 与 Server 版本号约定

- 从 Desktop `1.0.1` 版本开始，Desktop 与 Scriverse Server 使用相同的版本号；当前 `1.0.2` Desktop 对应 `1.0.2` Server。
- 版本升级时，`package.json` 的 `version` 与 `scriverseServerVersion` 必须保持一致，并且必须对应 Scriverse Server 的同版本 Git tag 与 GitHub Release；禁止使用不同版本、`develop` 或未发布 commit 作为运行时来源。

### `main` PR 的 Server Release 能力对齐门禁

创建从 `develop` 指向 `main` 的发版 PR 前，必须确认 Desktop `develop` 与其声明兼容的 Scriverse Server Release 完整对齐，不得遗漏该后端 Release 已提供能力的 Desktop 适配：

1. 读取 `package.json` 的 `scriverseServerVersion`，确认对应的 Scriverse Git tag 与 GitHub Release `vX.Y.Z` 已正式存在；禁止使用后端 `develop`、未发布 commit 或可变分支替代。
2. 审计该 Server Release 相对上一兼容版本的全部用户能力和外部契约，包括页面与路由、API 请求和响应、认证与权限、AI 供应商和模型、Prompt、Agent tools、流式事件、配置与数据库契约、导入导出及静态资源。
3. 逐项确认 Desktop 壳、Preload、Web runtime overlay、本地与远端工作区、本地供应商、离线同步和打包 runtime 已适配所有相关变化；Server Web 已有能力不能因进入 Desktop 而缺失、退化或使用不同逻辑。
4. 使用该精确 Server Release tag 执行 `runtime:prepare`、相关测试、`npm run check` 和必要的 Desktop 打包验收。存在任何缺少适配、补丁无法正向应用或契约不一致时，必须继续在 `develop` 修复，禁止创建指向 `main` 的 PR。

### CI 触发边界

- `.github/workflows/desktop-checks.yml` 只能由指向 `main` 的 `pull_request` 触发，只执行代码检查，不执行打包。
- `.github/workflows/desktop-release.yml` 只能由 GitHub Release 的 `published` 事件触发正式六架构打包；禁止提供人工触发、分支 push 触发或 PR 触发入口。
- `.github/workflows/desktop-develop-package.yml` 只允许 `workflow_dispatch` 人工触发，且始终检出 Desktop `develop`，用于六架构开发包验收；不得自动触发，也不得上传到 GitHub Release。
- 正式发布与 `develop` 人工打包都必须根据 `package.json.scriverseServerVersion` 检出精确的 Scriverse Server Release tag，禁止通过可变仓库变量或人工输入绕过版本对齐。

### Commit 与发布操作

- Commit message 使用 Angular 格式：`<type>(<scope>): <subject>`，subject 使用英文祈使语气。
- 每个独立功能或缺陷修复完成测试后立即单独提交，禁止把多个问题堆进同一个 commit。
- 提交前运行 `git diff --check` 并确认没有混入用户原有改动。
- 未经用户明确要求不得 bump 版本、创建 `main` 合入 PR、创建 tag 或发布 Release。
- Desktop 仓库要求的提交必须推送；Scriverse 主项目变更通过以 `develop` 为目标的 PR 集成。
