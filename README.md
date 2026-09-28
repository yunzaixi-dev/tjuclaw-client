# TJUClaw Client

天津大学校园行动智能体的共享客户端，使用 React、Vite 和 Tauri。
同一份界面面向 Web、Linux、Windows、macOS、Android 与 iOS。

本仓库独立管理依赖、版本与多平台构建。服务端和校园 CLI 分别维护；
集成仓库通过 Git submodule 锁定组合版本。

## 开发

需要 Node 24、pnpm 11.3.0 和 Task 3.49.1。

```bash
pnpm install --frozen-lockfile
task web:dev
task check
task ui:install
task ui:test
task workspace:test
```

开发地址为 `http://127.0.0.1:5173`。`/api` 默认代理到
`http://127.0.0.1:8080`，可通过服务端环境变量 `API_PROXY_TARGET` 调整。
邮箱认证和知识工作区需要可用的 API；独立 UI/工作区测试使用明确的浏览器 mock。

真实 Kratos 认证与任务归属回归由私有集成仓库执行。

主题、组件与响应式规范见 [UI.md](UI.md)。
外观预览位于 `/preview/appearance`。本地 audit 模式只读取开发者的本地证据，
不携带或发布私有截图、研究资料和凭据。

## 构建

```bash
task web:build
task linux:build
task windows:build
task macos:build
task android:targets
task android:build
task android:release:check
task ios:build
```

原生构建需要 Rust 和对应平台 SDK。Linux 需要 GTK 3、WebKitGTK 4.1、
AppIndicator 和 patchelf；Windows 需要 MSVC；Android 使用 Java 17、SDK 36、
Build Tools 35/36 和 NDK 27.2.12479018；macOS/iOS 需要 Xcode、
对应的 Apple Rust targets，iOS 还需要设备与模拟器 SDK、XcodeGen 和 CocoaPods。
具体安装步骤以 `.github/workflows/` 为准。

`package.json` 决定客户端安装包版本。Windows 输出未签名 NSIS 安装程序，
Android 输出 arm64 调试 APK。构建通过不代表已完成真机安装、原生登录或生产签名验收。
Android 的 edge-to-edge 安全区由 `src-tauri/android/MainActivity.kt` 在原生
Activity 中处理；`scripts/native.mjs` 在 `tauri android init/build/dev` 时将其同步到
被忽略的生成工程。生成文件若与已知模板不符，构建会中止以避免覆盖原生修改。
`android:release:check` 额外编译并核对仅含 arm64 库的 release APK；
CI 同时执行这项检查并单独保存该产物；它未签名，不能安装或作为发布包。
当前打包 WebView 的本地来源没有 `/api` 代理：Android 模拟器实测
`/api/auth/session` 返回应用 HTML 而非认证 JSON，原生登录尚不可用。
原生会话传输必须单独设计和验收，不应放宽后端同源校验或把会话 Cookie 暴露给前端。
macOS 构建 unsigned universal `.app`（CI 中以 tar.gz 保留符号链接）；
iOS 分别保留 unsigned 设备和模拟器 `.xcarchive`（CI 中以 tar.gz 保留符号链接），
只做编译门禁，不是可安装 IPA。
Apple 平台的发布和真机运行仍需签名、凭据与设备验收。

## CI 与比赛产物

GitHub Actions 分别运行检查、外观/工作区回归及五个原生平台构建，产物按提交 SHA 命名。
macOS 应用和 iOS 无签名归档都是短期 CI 产物。
日常构建不自动发布 Release。

## 两分支与 Web 发布

日常直接在默认分支 `dev` 开发；将验证后的提交合并到 `release` 后，CI 在代码检查、浏览器回归和 Web 构建通过后发布到 EdgeOne。
在 GitHub `production` 环境配置 `EDGEONE_TOKEN` Secret、`EDGEONE_PROJECT_NAME` Variable，以及可选的 `EDGEONE_AREA`。该环境只允许 `release` 部署。缺少配置会明确失败，不会跳过后显示发布成功。

仓库 Actions 白名单须包含工作流使用的固定 SHA，包括 `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`。本地 actionlint 无法检查 GitHub 仓库白名单；新增动作时必须同步核实服务端策略。

维护者可在 release 上手动执行 **Stage GitLab Packages**，指定已通过 CI 与 Windows
构建的客户端 SHA。流程验证 GitHub ZIP 摘要，将安装包和校验清单上传到 GitLab
包仓库。随后由私有集成仓库验证组件组合并创建比赛 Release。
## 许可证

本客户端源码仓库公开地址：[yunzaixi-dev/tjuclaw-client](https://github.com/yunzaixi-dev/tjuclaw-client)。源码采用 **GPL-3.0-only**。再发布客户端或其修改版本时，须遵守 GPLv3 的源代码、版权声明和许可证保留要求；完整文本见仓库根目录的 `LICENSE`。第三方依赖继续遵循各自许可证。

客户端不包含私有服务端源码；服务端的接口、部署和运行不构成对私有服务端实现的授权。
## 下载安装包与发布

公开下载同时发布到 Cloudflare R2 与 [GitHub Releases](https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest)。
提供 Windows x64 EXE（未签名）、Linux amd64 DEB、Android arm64 APK（debug 签名），
以及 `SHA256SUMS` 和记录来源提交/构建运行的 `manifest.json`。

| 地址 | 内容 |
| --- | --- |
| `https://tjuclaw-release.zaixi.dev/client/latest/<文件名>` | 最新版直链，Wiki 下载按钮使用 |
| `https://tjuclaw-release.zaixi.dev/client/v<版本>/<文件名>` | 不可变的版本目录，含 `.sig` 更新签名 |
| `https://tjuclaw-release.zaixi.dev/client/latest.json` | 桌面端应用内更新清单 |

`release` 推送时，CI 的 `publish-downloads` 任务在全部构建成功、并等到同一提交的
Windows Installer 成功后自动发布：**只有 `package.json` 版本号尚未发布时才会发布**，
版本未变则跳过。要发布新版本，先提升版本号再推送。已发布的版本目录、Release 和标签
不会覆盖；`latest/` 与 `latest.json` 只会前进、不会回退，并在全部文件上传后最后切换。
需要补发时可手动运行：

```bash
gh workflow run publish-downloads.yml --repo yunzaixi-dev/tjuclaw-client --ref release -f source_sha=<40位源码提交SHA>
```

桌面端（Windows NSIS、Linux DEB）启动后检查 `latest.json`，下载前用内置公钥校验
Tauri 更新签名。签名私钥与口令只存于仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`，
私钥丢失后已安装的客户端将无法再自动更新。Android/iOS 不支持应用内更新。
GitLab 比赛交付维持独立流程。
