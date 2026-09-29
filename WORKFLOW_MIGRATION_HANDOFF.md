# Better Learning Studio 内置工作流迁移交接

更新日期：2026-09-29。当前分支：`codex/built-in-course-workflow`，从干净的 `main` 提交 `e1ffbe83f716feb637e567b6378dc755212bacbc` 开始。此文档用于额度刷新后直接继续；先看 `PROGRESS.md` 最后一条及本文件，不要重新读取整门课程的生成产物。

## 用户目标与约束

- 先备份，再将随包 `better-learning` skill 的强制加载执行逐步迁移为 Better Learning Studio 自有的内置课程工作流；保留原功能，包括视觉、子代理、阶段恢复、watchdog、课程包交付。
- Windows Electron 桌面端，Codex 风格三栏和底部附件输入体验保留。模型凭据由用户在应用设置中填写。真实测试注意 API token 用量；不要为了验证本次代码而重新生成课程。
- 用户此前确认混合 PDF＋PPTX/DOCX 资料、单一多模态模型、聊天内归纳需求后一次确认、视觉探针失败暂停、重启从最近验证阶段恢复并显示待确认状态、界面仅显示总体进度和异常、未来 Obsidian 扩展接口。当前任务尚未达到全部验收。

## 迁移前备份

- Git 完整历史 bundle：`C:\Users\win11\Documents\ChatGPT\good\backups\bls-pre-workflow-20260929\source.bundle`，已用 `git bundle verify` 验证；SHA-256：`9F60283E024952D7228E1FAAB327CFA4D01B16EDD1E018EAC3460AFF281D4467`。
- 应用配置备份：`C:\Users\win11\AppData\Roaming\BetterLearningStudio-DSH\backups\bls-pre-workflow-20260929\profile.zip`，156 项，约 24.2 MiB；SHA-256：`C8F67228AF4AA3E0A2B4F3B0F4338FF72636CA73747E60C7CB5C7D2160AB571E`。包含凭据，绝不能加入 Git 或输出内容。
- 清单：`C:\Users\win11\Documents\ChatGPT\good\backups\bls-pre-workflow-20260929\README.md`。不要删除备份。原课程与原用户配置没有被本次迁移修改。

## 已完成的迁移节点

1. `apps/desktop-host/src/course-workflow.ts`：七阶段原生游标（资料、转写、知识、路径、讲义、卡片、交付），原子写入 `_工作区/内置工作流.json`，确认、阶段凭证、暂停、恢复、模型变更失效。重启后运行中阶段进入 `needs_review`，需要显式 `resume`。
2. `apps/desktop-host/src/course-stage-verifier.ts`：宿主调用随包 Python 脚本进行计划、来源哈希、视觉探针、转写、知识、路径、讲义、卡片及最终 packaged 校验。`initialize` 的第一步是 plan；确认需求会同步旧进度格式。运行脚本时清理凭据环境变量。
3. `apps/desktop-host/src/course-workflow-api.ts`、`index.ts`：在现有 Connection 认证通道注册 `POST /api/better-learning/workflow`；限定已注册工作区根目录或直接子目录，核对真实路径。支持 `inspect`、`initialize`、`confirm`、`change-model`、`start`、`complete-stage`、`pause`、`reconcile`、`resume`、`watchdog`。宿主启动时发现已有原生游标并做恢复核对。
4. `apps/desktop-host/src/course-watchdog.ts`、`course-watchdog-service.ts`：转写运行时默认每 90 秒、且收到 DSH `subagent/end` 时检查持久尝试台账与实时 Agent 列表；异常摘要落盘 `_工作区/内置看门狗.json`。重启后无法确认的旧子代理标为未知。界面在原生游标存在时优先显示其状态、待确认与异常；旧课程保持原有展示路径。
5. 新增宿主和 UI 聚焦测试，更新中英配对文档、依赖和 `PROGRESS.md`。

## 已做验证

- Host 与 `ui-sidebar-files` 的 TypeScript `--noEmit` 均通过。
- 六个聚焦 Vitest 文件：23 通过、1 个需要显式环境变量的真实脚本测试默认跳过。
- 在**副本** `.desktop-cache/workflow-smoke-20260929` 上，用随包 Python 对已完成的小课程执行 plan、materials、packaged 真校验，均通过；未调用模型 API。原课程是 `C:\Users\win11\Documents\deepseek-harness\default-workspace\从概念图示到练习趋势`。
- 宿主和 UI 的 `tsc` emit、`tsdown` 均通过；聚焦 `oxlint`、`verify-package-dependencies.ts`（72 packages）、`verify-client-ui-i18n.ts`（922 files）、文档配对检查均通过。
- `git diff --cached --check` 已通过。首次直接调 `pnpm` 遇到沙箱网络／锁文件问题，因此用仓库内 Node 工具直调完成验证；`node --import=tsx -e` 在沙箱内触发 `uv_os_get_passwd ENOMEM`，改用 Vitest 执行真校验。
- 提交前的 Lefthook 在此 PowerShell 环境以 `exec: "sh": executable file not found in %PATH%` 失败。单独运行第三方声明生成器（扩大权限后）又因随包 Python `pypdf` 缺少 `PYTHON_METADATA` 而失败；这是后续需修复的仓库门槛，不能把提交成功当作该门槛通过。其余上述静态、构建、测试检查独立通过。

## 尚未完成，继续时按此顺序

1. **将聊天输入接到宿主原生 API**：从目标与附件创建或选择课程目录，展示计划归纳并在聊天中一次确认，控制 `start`／`complete-stage`／`pause`／`resume`。确保附件与课程文件预览仍可用；避免重复创建游标或隐式绕过确认。
2. **实现应用自有的视觉转写派发与回收**：复用已有 DSH 子代理能力和脚本台账，但由宿主控制批次、租约、收据、重试与探针失败暂停。watchdog 目前只有监测／展示，尚不能主动收集完成尝试、释放租约、补派卡住的批次；这部分是核心缺口。考虑宿主关闭时的子代理生命周期与恢复幂等性。
3. **实现知识库、学习路径、讲义、卡片、交付的原生驱动**：把现有 skill 中的约束、质量门槛与语义复核转为版本化应用工作流配置和执行器；每阶段只在校验通过后前进。保持单一多模态模型路由、实际用量显示和高成本时优先完整处理。
4. **完成后才移除 Agent 预设的强制 skill 加载**：现在内容生成仍依赖旧 skill，贸然删除会让课程无法生成。做双路径兼容／升级策略，审视 `_工作区/内置工作流.json` 持久格式与旧进度的兼容性。
5. **桌面端和真实混合资料验收**：重建并启动 Electron，检查新交互和状态条；用 PDF＋PPTX/DOCX 小样跑一次端到端，确认视觉探针、真实子代理、watchdog 中断恢复、最终 packaged 收据。优先使用隔离副本／最小测试，只有需要模型推理的环节才调用 API，记录用量。
6. **修复提交门槛**：检查 Lefthook 的 Windows `sh` 调用路径和 `scripts/gen-third-party-notices.ts` 的随包 Python `pypdf` 元数据来源；在 CI／可用环境中重新跑完整钩子。不要默认为此次提交已经通过这些门槛。

## 已知界限与注意事项

- 当前 Agent 预设仍强制加载 skill，聊天输入尚未调用新接口；此次提交是**迁移节点，不是完整迁移**。
- 原生 watchdog 仅在宿主运行期间检查和写异常，尚未自动恢复任务。宿主启动的游标发现失败会记日志并继续启动，后续应保证 UI 能提示未完成的恢复扫描。
- 当前原生接口需设置 `BLS_SKILL_ROOT`，校验脚本仍来自随包 skill 资源；最终内置化需明确资源归属并保留校验行为。
- 旧课程没有原生游标，不会自动转换。此前真实课程及敏感配置不要作为代码测试数据提交。
- 2026-09-29 写此交接时 Codex 五小时额度约用 89%，周额度约用 74%。额度刷新后从本分支最新提交继续，不必重新扫描大课程产物。

## 恢复入口

在仓库 `C:\Users\win11\Documents\ChatGPT\good\better-learning-studio`：先运行 `git status --short`、`git log -1 --oneline`，阅读本文件与 `PROGRESS.md` 最后一条，再检查上述六个 Host 关键文件及现有 composer／Agent 预设。先确定目前是否仍停在本节点，随后从“聊天输入接原生 API”继续。需要恢复基线时使用上面的 Git bundle；勿直接解压含凭据的 profile ZIP 到仓库。

## 2026-09-29 续查：聊天接线位置

本次续查未修改运行代码，也未调用课程模型 API。仓库从 `4a1c64b` 保持干净起步；五小时额度在续查末约用 97%，所以先记录结论：

- 普通聊天发送经过 `packages/client/ui-conversation/src/client/input/hub.ts` 的 `InputHub.sink()`，调用同包 `service.ts` 的 `sendSession()`；后者负责文本与附件的真实 Session admission。不要直接改 composer 编辑器或绕过此处的附件失败恢复语义。
- Better Learning 定制文件夹入口已在 `packages/client/ui-conversation/src/client/apply.ts`，由 `DSH_CLIENT_BUILD_PROFILE=better-learning` 控制。下一步可在产品专用的发送入口／会话控制层上接原生课程初始化，但应保留 DSH 的 Session 日志和附件 admission；避免原生 API 与聊天各自重复发送、重复落盘。
- 强制加载 skill 的预设在 `packages/bundle/web-app/presets/standard.patch.yml`：persona 前缀明确要求加载 better-learning；`skill-filesystem` 和 `tool-skill` 也在同一预设。**原生执行器有等价能力之前不要删除这些配置**。
- 宿主现有控制 API 在 `apps/desktop-host/src/course-workflow-api.ts`，认证路由为 `POST /api/better-learning/workflow`，其 `initialize` 要求课程目录已经存在且属于注册工作区的根目录或直接子目录。目前既无“聊天附件 → 课程目录”创建动作，也无 UI 调用此 API。应先定义由哪个层创建目录、绑定 Session 与课程、持久化用户确认，再连接阶段推进。不要仅在客户端拦截发送后创建空游标。
- DSH 有模型可调用工具注册模式：`packages/skill/tool-skill/src/index.ts` 使用 `defineTool` 和 `ctx.tools.register`，可作为宿主原生课程操作工具的参考。工具执行可从当前 Agent 的 Session 取得 `cwd`，但应复用宿主的课程边界校验和同一游标实例，避免工具与 HTTP API 各持一份状态。
