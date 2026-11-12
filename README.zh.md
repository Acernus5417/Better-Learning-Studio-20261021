# Better Learning Studio

[English](README.md) | 中文

Better Learning Studio 是一个用于建课和自学的桌面工作台。可以用学习资料创建课程，也可以导入已有的 Markdown 课程文件夹，在应用里阅读和编辑讲义、查看文档关系、保存笔记。选中文段后，学习助手可以结合课程上下文讲解，并在对话内展示交互 SVG 和分步演示。

## 开发接手

准备 Windows x64、Git 2.26 或更新版本、Node.js 24 x64 和 pnpm 11.28.5。在 PowerShell 中克隆 Studio 开发分支。

```powershell
git clone --branch codex/basic-course-workbench https://github.com/Acernus5417/Better-Learning-Studio-20261021.git better-learning-studio
cd better-learning-studio
```

如果收到的是源码文件夹，在包含 `package.json`、`pnpm-lock.yaml` 和 `start.bat` 的根目录打开 PowerShell。依赖在各自的电脑上安装。需要共享示例课程时，单独发课程文件夹，由队友通过「导入课程」打开。

## Windows 快速启动

在仓库根目录安装锁定版本的依赖，再执行首次构建和启动。

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-studio.ps1
```

首次启动会构建 Studio，并可能下载 Electron 和其他运行时组件。看到 Studio 窗口后，可以新建或导入课程。使用 AI 课程生成或学习助手前，在应用内配置模型服务。

构建成功后，日常双击 [`start.bat`](start.bat) 启动已有产物。修改应用源码后，重新运行 `start-studio.ps1` 构建。启动日志在 `.desktop-cache/startup-*.log`。

## 从哪里继续

- [`apps/desktop`](apps/desktop) 存放桌面壳和随应用分发的[内置学习技能](apps/desktop/resources/skills)。
- [`apps/desktop-host`](apps/desktop-host) 存放本地课程 API 和学习助手工具。
- [`packages/client/ui-workspace`](packages/client/ui-workspace) 存放课程工作台界面。
- 详见[课程工作台指南](docs/studio-course-workbench.zh.md)、[开发指南](docs/development.zh.md)和[贡献指南](CONTRIBUTING.zh.md)。

Windows 上的课程保存在「文档」目录的 `Better Learning Studio/course` 下。启动脚本使用 `%APPDATA%\BetterLearningStudio-DSH\dsh` 存放模型配置和会话数据。队友各自配置自己的凭据。

<a id="run"></a>

## DeepSeek Harness Web 界面

Studio 基于 DeepSeek Harness。底层 Harness 的使用说明见[安全说明](SAFETY.zh.md)和 [Web 界面指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

要在当前仓库构建并启动 Harness Web 界面，安装依赖后运行 `pnpm run dev:web`。

## 许可证

[MIT](LICENSE)。依赖许可证见[第三方许可声明](THIRD_PARTY_NOTICES.md)。
