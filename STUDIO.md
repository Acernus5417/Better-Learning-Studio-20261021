# Better Learning Studio 开发版

本项目从 DSH v0.1.7-rc.2 派生，运行形态为 Windows Electron 桌面应用。课程生成由应用内的 `better-learning` Agent 预设和随包提供的 skill 执行；视觉成员是 DSH 内部子代理，使用主代理选择的同一模型。

## 启动与 API 设置

在仓库目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\start-studio.ps1`。首次运行需要构建；后续可加 `-SkipBuild`。应用数据独立保存在 `%APPDATA%\BetterLearningStudio-DSH\dsh`，课程文件位于所选工作区。

在“设置 → 模型”中选择内置服务商，或通过“添加模型提供商 → 自定义模型 API”填写兼容 OpenAI / Anthropic 的 API 地址、协议、模型 ID 和密钥。把该模型的输入类型设为“文本＋图片”，并在输入框选择它。密钥由 DSH 凭据存储管理，设置页不会回显。账号页仅显示尚未开放的占位内容。

建议每个工作区对应一门课程。在空工作区的新会话中说明学习目标并添加 PDF、PPTX、DOCX 或资料文件夹；支持拖入、加号选择、发送前移除。Agent 汇总目标、资料范围与基础后在聊天中请用户一次确认。课程可位于工作区根目录或唯一子目录，右侧状态条会识别其进度；若同一工作区下有多门课程，状态条提示分别打开，以免把某门课的状态误归给另一门。建立另一门课程时选择新的工作区，以免覆盖。

视觉探针必须以当前模型真实识图且由内部子代理写回结果；失败时暂停。恢复时读取课程根目录的 `_工作区/生成进度.json` 与 skill 校验结果，从最近有效阶段继续。右侧文件区显示课程文件及小进度条，会话统计显示模型实际报告的 token 用量。PPTX、DOCX 的完整页面渲染使用随应用携带的 LibreOffice Kit，PDF 使用随附的 pypdfium2。

## 后续阅读与 Obsidian 接口

课程包以普通文件夹保存，核心内容是 Markdown，采用稳定的相对链接和 Obsidian wikilink。`开始学习.md` 是阅读入口；`_工作区/` 保存可校验的进度、资料索引和覆盖台账。生成过程只通过文件读写与 DSH skill/agent 工具运行；右侧预览通过 DSH 的文件地址和 tab 类型注册。因此后续可把 Obsidian vault 当成另一个课程目录来源，并以独立 tab / 插件增加阅读进度、标注和同步，而不用改变课程生成脚本或重写现有课程包。

当前开发版尚无 Obsidian 连接与账号功能。已用用户在设置中配置的模型完成一份小型 PDF＋PPTX＋DOCX 混合课程的真实端到端验收；`package` 和 `packaged` 校验通过。桌面底部的 token 计数包含缓存复用，用量和计费以服务商账单为准。

## 图标资源

原始图标是 `apps/desktop/resources/icon-windows.svg`。修改后运行 `pnpm --filter @deepseek-ai/dsh-desktop run render:studio-assets` 生成应用与安装器 PNG，再运行 `pnpm --filter @deepseek-ai/dsh-desktop run render:tray-icon` 生成 Windows 多尺寸托盘 ICO。桌面侧栏使用 `packages/client/ui-brand-official/src/client/Brand.tsx` 的同款矢量路径；欢迎页字标在 `apps/desktop/renderer/assets/welcome-brand.svg`。
