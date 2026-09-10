# TJUClaw Client

天津大学校园行动智能体的共享客户端，使用 React、Vite 和 Tauri。
同一份界面面向 Web、Linux、Windows 与 Android。

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

开发地址为 `http://127.0.0.1:1420`。`/api` 默认代理到
`http://127.0.0.1:8080`，可通过服务端环境变量 `API_PROXY_TARGET` 调整。
邮箱认证和任务草稿保存需要可用的 API；独立 UI/工作区测试使用明确的浏览器 mock。
真实 Kratos 认证与任务归属回归由私有集成仓库执行。

主题、组件与响应式规范见 [UI.md](UI.md)。
外观预览位于 `/preview/appearance`。本地 audit 模式只读取开发者的本地证据，
不携带或发布私有截图、研究资料和凭据。

## 构建

```bash
task web:build
task linux:build
task windows:build
task android:targets
task android:build
```

原生构建需要 Rust 和对应平台 SDK。Linux 需要 GTK 3、WebKitGTK 4.1、
AppIndicator 和 patchelf；Windows 需要 MSVC；Android 使用 Java 17、SDK 36、
Build Tools 35/36 和 NDK 27.2.12479018。具体安装步骤以 `.github/workflows/` 为准。

`package.json` 决定客户端安装包版本。Windows 输出未签名 NSIS 安装程序，
Android 输出 arm64 调试 APK。构建通过不代表已完成真机安装、原生登录或生产签名验收。

## CI 与比赛产物

GitHub Actions 分别运行检查、外观/工作区回归及各平台构建，产物按提交 SHA 命名。
日常构建不自动发布 Release。

## 两分支与 Web 发布

日常直接在默认分支 `dev` 开发；将验证后的提交合并到 `release` 后，CI 在代码检查、浏览器回归和 Web 构建通过后发布到 EdgeOne。
在 GitHub `production` 环境配置 `EDGEONE_TOKEN` Secret、`EDGEONE_PROJECT_NAME` Variable，以及可选的 `EDGEONE_AREA`。该环境只允许 `release` 部署。缺少配置会明确失败，不会跳过后显示发布成功。

仓库 Actions 白名单须包含工作流使用的固定 SHA，包括 `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`。本地 actionlint 无法检查 GitHub 仓库白名单；新增动作时必须同步核实服务端策略。

维护者可在 release 上手动执行 **Stage GitLab Packages**，指定已通过 CI 与 Windows
构建的客户端 SHA。流程验证 GitHub ZIP 摘要，将安装包和校验清单上传到 GitLab
包仓库。随后由私有集成仓库验证组件组合并创建比赛 Release。
客户端仅持有包仓库权限，不持有私有服务端源码的访问凭据。

源码可公开查看，但本项目尚未授予开源许可证；第三方依赖按各自许可证使用。
