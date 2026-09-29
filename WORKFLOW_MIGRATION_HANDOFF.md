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

## 2026-09-29 后续实现：原生策略、视觉探针、整批派发、恢复

本节优先于上文“尚未完成”的旧状态描述。迁移版现在**不再强制调用 skill**：专用预设禁用 `skill-filesystem` 与 `tool-skill`，资源移到 `apps/desktop/resources/workflows/better-learning`，新增 `runtime-policy.md`；`course_workflow guide` 读取应用拥有的规范与模板。Electron 和 `start-studio.ps1` 改用 `BLS_WORKFLOW_ROOT`，打包资源目录也改为 `workflows`。Host 入口以该根目录下的 `scripts` 调用 Python；此前 `BLS_SKILL_ROOT` 指向 skills 父目录而少拼一层 `better-learning`，已修正。

Host `course_workflow` 工具与 HTTP 共用游标。模型工具限定当前真实根 Agent 的 Session 目录或其直接子课程；`propose` 保存目标／范围／基础摘要，`confirm` 要求后续真实用户回合。`inspect` 只读，启动扫描和显式 `reconcile` 才把运行中阶段标为 `needs_review`。旧课程不被自动转换，但可用 `guide` 读阶段规范。`probe` 启动只带 `read_image` 与 `write` 的全新 DSH 子代理，读取随机挑战图、写结果，由 Python 验证；主代理不看图。失败暂停课程。`transcribe-batch` 通过脚本整批预约，启动每个独立子代理，登记真实 DSH ID，等待真实终态并 `dispose` 后收集；启动失败释放预约。暂停期间启动／停止的竞争已用启动屏障处理。看门狗将静默异常去重提醒给根 Agent。

转写阶段显式 `resume` 会先检查当前 Host Agent 名册及应用内活动批次；有成员仍存活就拒绝。对当前进程已不存在的登记成员运行脚本 `recover`，对未登记预约运行 `fail-attempt SPAWN_FAILURE`，然后才把游标改为 `ready`。这依赖 DSH 子代理受本 Host 进程所有的生命周期；**尚需真实强制中断测试**验证重启时的名册和租约路径。`course-transcription-recovery.ts` 的本地测试覆盖已停止、未登记与仍运行的情况。

验证：Host 与 Electron TypeScript 检查、各自 `tsdown` bundle、6 个 Host 聚焦 Vitest 文件（22 项；之后另加一个批次停止竞态测试与一个 guide 兼容测试，局部重跑通过）、聚焦 oxlint、中英文档配对、27 项随包 Python 测试通过；新位置的 `convert_materials.py --help` 用随包 Python 成功运行。Python 测试中一条 Windows 子线程出现 UTF-8 解码堆栈噪声，但总结果 27/27 与进程返回码 0。没有调用用户模型 API，也没有修改原课程产物或配置。`verify-cordis-config.ts` 上次仍被不相关的 `apps/cli/tests/profiles/acp/cordis.yml` 阻断；第三方声明预提交门槛的 `pypdf PYTHON_METADATA` 问题仍待修复。按本节新增的代码还需做最终全套聚焦测试与 Git 提交。

下一步：先验证真实 Electron 开发版能装载新 `BLS_WORKFLOW_ROOT` 与专用预设，检查 `course_workflow guide` 实际注册；在隔离小课程里跑一次不花模型 token 的 `initialize` 与恢复脚本。然后审视聊天附件与课程目录绑定，把用户发起的课程目标和附件稳妥接入原生游标，不绕开 Session admission；继续补齐材料盘点、知识／讲义／卡片的宿主机械阶段动作。最后用小型 PDF＋PPTX/DOCX 资料做真实迁移版端到端和强制中断验收，注意 API 用量。当前尚不能声称完整迁移验收完成。

### 此后新增的机械步骤与测试限制

- 当前模型工具还包含 `prepare-transcription`、`diagnose-transcription`、`assemble-transcription` 和 `run-step`。后者按当前游标阶段严格限制白名单：知识合并/检查、讲义准备/提交/检查、卡片准备/校验、Obsidian 链接重建、final 校验、package 预览及正式打包。教学正文、来源语义检查仍由主代理按应用规范编写。新 `references/native-transcription.md` 是 `guide image-first` 的实际返回内容；旧 `image-first.md` 仍在资源内供内部参考，但不作为当前模型指令。参考文件的旧 `SKILL/scripts` 路径已换成 `guide` 返回的 `<scriptsRoot>` 占位。
- 对第二批变更，Host `tsc`、聚焦 oxlint、6 个 Host 测试文件 23 项通过。Windows installer 脚本测试尝试后在准备阶段因本机没有 Visual Studio C++ Build Tools / Windows SDK 退出；不代表应用图标或资源打包逻辑失败。原生 Host 和 Desktop bundle 在前一迁移提交后编译过，第二批 `run-step` 变更需要提交前重建 Host。
- 仍缺：聊天附件与新课程目录的真实文件定位及用户界面交互验收、资料盘点输入来源的宿主校验、新路径视觉子代理与重启租约恢复、混合 PDF＋PPTX/DOCX 的迁移版端到端课程包。不要把此节点标成全目标完成。旧版已生成课程不应作为无提示转换对象。

### 隔离桌面启动结果及新增课程入口

- `course_workflow create-course` 现支持根工作区会话在真实用户回合创建**新的直接子课程目录**，随即调用 plan 和原生初始化。拒绝路径穿越、Windows 保留名、重复目录和子课程会话再嵌套；返回课程名供后续工具调用。模型执行阶段时会核对当前实际选模与游标模型，手动切模后必须暂停并 `change-model`，避免静默混用模型。Host 单测覆盖这些边界。
- 为不打断仍运行的旧开发窗口，用 `.desktop-cache/native-workflow-smoke-20260929` 下的独立 `DSH_HOME` 和 Electron 用户数据、`BLS_WEB_PORT=19388` 启动新 Host。首次发现当前机器 `apps/desktop-host/node_modules` 尚缺 `dsh-llm`、`dsh-tools`、`dsh-session-projection` 和此前已声明的 `dsh-subagent` workspace junction，已在忽略的 `node_modules` 里补齐；源码 manifest/lock 包含新增依赖，干净安装应由 pnpm 建立链接。用扩大沙箱权限启动后，Host 在 19388 成功监听，已认证 `/api/better-learning/workflow` 对无效 JSON 对象返回预期 400，证明路由挂载。测试实例 PID 从隔离记录读取后已单独停止；原用户窗口没有重启。**未发起模型请求。**
- 当前安装器脚本测试仍受本机缺 Visual Studio C++ Build Tools / Windows SDK 阻断。隔离实例只验证应用启动与 HTTP 路由，尚未验证模型工具实际调用、视觉子代理生命周期、材料附件定位或生成质量。迁移版用户界面与这些内容需后续验收。重新启动原开发窗口后才能加载新编译的 Host；不要在用户正操作时覆盖其会话。

## 当前恢复检查点

最近的代码提交为 `a9c7440`，前两次迁移提交是 `c310ad2` 和 `f6a4adb`；分支仍为 `codex/built-in-course-workflow`。完成交接文档补记后应确认工作区干净。最后一次检查：Host TypeScript、聚焦 oxlint、6 个 Host 测试文件共 24 项通过；隔离 Electron Host 启动并通过已认证路由 400 校验。用户原开发窗口继续运行旧进程，下一次正常启动才加载新的 Host bundle。不要为验证而重读大型课程产物或重新跑完整生成；本轮没有调用课程模型 API。

优先处理：① 在独立会话中实际调用 `course_workflow` 的 `create-course`/`guide`/`propose`/后续回合 `confirm`，核对附件文件路径与课程目录绑定；② 以最小混合 PDF＋PPTX/DOCX 材料验证 `prepare-transcription`、真实 `probe`、一批 DSH 视觉成员、看门狗、暂停和重启 `resume`，预算内只读摘要与收据；③ 补完未覆盖的材料输入来源约束和必要 UI 交互，验证最终 `run-step` 与 packaged 校验。出现探针失败应暂停，待用户调整模型。真实端到端验收之前，不写完成标记。

## 2026-09-29 当前续作：聊天附件与材料盘点

本节覆盖上文“附件文件路径尚未绑定”的旧状态。现在 Better Learning 专用桌面输入会将单个文件作为 DSH 持久附件上传（通用 DSH 界面仍用原有路径引用）；文件夹选择与拖入保持 `@目录/` 芯片。Host 的 `course_workflow create-course` 读取**当前根 Agent 真实用户消息**中已准入的 file/image 引用及明确的文件夹提及，复制文件／图片到新课程 `原始资料/`，并以真实绝对路径调用随包 `inventory_materials.py`。资料阶段的 `import-attachments` 可接收后续用户回合补充。二者都不接收模型提供的任意资料路径。文件以 SHA-256 和字节数核对，临时文件校验后用硬链接原子发布，避免覆盖已存在来源；目录若包含输出课程会拒绝。持久登记在 `_工作区/附件导入.json`。Python 脚本进程现固定 UTF-8，中文来源名在 Node 端可解析。

验证：Host 聚焦 9 文件共 32 通过、1 跳过，加 Conversation 输入测试 15 通过、1 跳过；另启用 Codex 随包 Python 跑了中文课程／资料名的真实 inventory 测试 1 通过。Host、Conversation 的 TypeScript 与 tsdown、聚焦 oxlint、Host bundle 导入、72 包依赖检查通过；Better Learning 配置下的 Vite Web 前端构建也成功。没有调用用户模型 API。翻译配对门槛在未修改的 `apps/desktop/README.i18n.yaml` 旧同步记录处失败；不是本轮源码改动所致。原开发窗口仍运行旧进程，**尚未重启并实际桌面验收新交互**。直接 `pnpm run build:web` 曾被 pnpm 的全仓在线供应链元数据核验阻塞；已停止重试并用本地 Vite 直接构建成功。

**仍需继续**：① 审核当前 `course-attachments.ts` 的多次导入及失败恢复，特别是创建目录成功但导入中途失败时的重试入口；为本轮用户消息中多个附件／文件夹及大目录检查成本与状态展示。② 在隔离新 Electron 会话用最小 PDF＋PPTX＋DOCX 实际调用 `create-course`、导入、`propose`、下一回合 `confirm`，观察 UI 附件可预览和文件夹芯片；不要读取完整课程产物。③ 在同一隔离课程运行真实视觉探针、独立子代理批次及 watchdog 停止／恢复，继续知识、路径、讲义、卡片到 packaged 收据；只在必要时调用用户配置的模型并记录实际用量。④ 恢复时避免动原用户课程和当前运行窗口。开发版 `start.bat` 带 `-SkipBuild`；本轮 Web 已构建，但旧窗口要重新启动才加载新 Host。

本节代码检查点提交为 `a63c8a8 feat: inventory course materials from admitted chat input`。续做前先运行 `git status --short` 与 `git log -1 --oneline`。2026-09-29 此次记录时 Codex 五小时额度约用 29%，周额度约用 95%；应优先保留本交接信息再做大规模验收。

## 2026-09-29 续作：盘点中断恢复与隔离启动

新增 `course_workflow refresh-inventory`，在资料阶段从持久 `附件导入.json` 读取已导入文件／文件夹，校验文件哈希、字节数、路径仍位于课程来源区，以及文件夹可用且不包含输出课程，然后重跑盘点。测试模拟脚本第一次失败、第二次无需重新上传即成功。`create-course` 若已经建好课程但附件导入失败，会返回课程名、错误与恢复提示，避免误以为整个创建动作可安全重做。同一用户回合可调用 `import-attachments`，已保存来源清单时可调用 `refresh-inventory`。若宿主恰好在来源清单落盘之前退出，并且用户回合已经结束，仍可能需要重新附加资料；这是下一个恢复边界。

Host 聚焦 9 文件 33 通过、2 跳过；TypeScript、oxlint、Host tsdown 通过。使用此前隔离配置启动新 Electron：进程存活且 19388 端口监听；测试后该隔离进程与端口都已关闭，原用户窗口未动。stderr 有 `dsh-desktop:mandatory-status` “No handler registered” 一条；目前未做图形界面交互检查，不能判断影响。没有调用课程模型 API。

该 IPC 日志的源码路径已定位：Windows `preload-mandatory-overlay.ts` 总会尝试读取更新状态并捕获失败；`main.ts` 仅在存在强制更新策略配置时创建注册该 handler 的 `DesktopMandatoryUpdateWindow`。隔离开发配置没有该策略，所以这条日志符合当前分支条件；尚不能据此推断主界面失败。下一步仍需实际查看窗口与附件交互。

**后续优先级**：先在隔离窗口核对该 IPC 错误与底部输入／附件交互，并用一个小型混合 PDF＋PPTX＋DOCX 在真实模型会话验证 `create-course`、资料清单、聊天归纳与后续回合确认；再跑视觉探针、独立子代理批次、强制中断后 `resume`，最后完成知识、讲义、卡片与 packaged。用户配置的模型凭据在应用内，勿输出凭据；记录实际 token 用量和失败点，避免重复生成已通过阶段。当前周额度接近上限；停下前确认 Git 提交和工作区干净。

## 2026-09-29 隔离图形界面验收与附件菜单修复

用 `.desktop-cache/native-workflow-smoke-20260929/launch-ui.ps1` 的独立配置启动可见 Electron 窗口，实际确认主界面、底部输入和模型选择显示正常。加号菜单起初只有“文件”：`packages/client/ui-conversation/src/client/apply.ts` 用 `process.env.DSH_CLIENT_BUILD_PROFILE` 判断是否注册“文件夹”，前端运行时该值未可靠注入。现在 `apps/desktop/src/preload-app.ts` 仅对本地应用页面暴露 `__BLS_STUDIO__ = true`，客户端据此显示文件夹动作，并把普通文件走 DSH 持久上传。非应用页面没有此标志；预加载测试对此作了断言。

重建 Client、Desktop 和锁定的 `apps/web/node_modules/.bin/vite.CMD` 后，隔离窗口的加号菜单实际显示“文件”和“文件夹”；此步只检查入口，**未进行真实文件选择／上传或模型生成**。先前误用仓库根部 Vite 8 导致 `getWatchFiles` 构建错误，改用应用自带 Vite 6 后完整构建通过，源码不需要为此修改。桌面与输入聚焦测试 35/35、Client/Desktop TypeScript、聚焦 oxlint、桌面和 Web bundle、`git diff --check` 均通过。已按记录的测试 PID 73452 单独关闭隔离窗口；原用户课程窗口未触碰。`mandatory-status` 日志为没有强制更新策略时预加载探测被捕获的情况，主界面可正常加载。

本节的源码变更为 preload 标志、客户端两个运行时分支和对应测试，以及此交接记录；提交后以 `git log -1 --oneline` 确认最新检查点。续做优先验证完整附件导入与一次真正的迁移版小型 PDF＋PPTX＋DOCX 流程：先从聊天归纳目标、用户下一回合确认，再做图片读取探针和批次转写，观察 watchdog；强制中断后从最近凭证恢复，完成 packaged 收据。隔离配置没有用户密钥，不应假称已完成真实模型验收；要在用户已配置的应用中做实测时，保护其现有课程和凭据，记录实际 token 用量。不要读取整门旧课程产物。当前 Codex 周额度约 99%，本节保证额度耗尽后能从此节点继续。

追加校验：前端输入测试现直接模拟桌面文件夹选择器返回含空格的路径，检查命令可用性和输入草稿中的目录引用；该测试文件 16/16 通过。可见菜单、preload IPC 与草稿引用三段均已分别验证，尚未通过真实系统对话框选择资料。

## 2026-09-29 资料导入批次的中断恢复

`apps/desktop-host/src/course-attachments.ts` 原先在整批附件复制后才写 `_工作区/附件导入.json`。若复制到一半退出，已经发布的文件仍在磁盘上，但 ledger 无法指明剩余的 DSH 附件；用户下一回合无法直接用 `refresh-inventory` 继续。现在在复制开始前把**当前真实用户消息已准入的附件引用**和已验证的文件夹写进同一个原子 ledger 的 `pending` 字段。成功复制并逐件复核哈希后，清掉 pending、保存正式条目，才运行 inventory。旧版 ledger 没有 pending 仍可读取。

`course_workflow refresh-inventory` 现在会用 Host 持久 `AttachmentStore` 补齐 pending 中尚未发布的文件，并核对已经复制好的文件，不再要求用户在下一回合重新附加。模拟第二个附件的流中断后，从磁盘 ledger 恢复两份资料且第一份不重复读取；8 个 Host 聚焦测试文件 33 通过、2 跳过。尚需在真实 Electron/Host 强制退出场景证明 `AttachmentStore` 重启后也可读取同一引用。该改动没有调用模型 API。此前本文件所述“ledger 落盘前中断可能要求重新附加”的边界已缩小为**原子 pending ledger 写入前**，此时尚未开始复制任何文件。

## 2026-09-29 当前用户配置与迁移版实机准备

原桌面窗口的狼人杀课程显示已完成。使用应用“退出”菜单正常结束主进程后，把当前 `AppData/Roaming/BetterLearningStudio-DSH/dsh` 另备份为 `C:\Users\win11\AppData\Roaming\BetterLearningStudio-DSH\backups\bls-pre-native-live-e2e-20260929\profile.zip`，ZIP 156345962 字节，SHA-256 `831D46CA843F25F6EB05788C9CA00F7EEBCB11F26AD2ED736F4D8C1D406690C6`；只读打开 ZIP 核对 8310 项、解压前总字节 348531911。**含凭据，不进入仓库，不输出内部内容。** 这份备份包含之前迁移备份后新增的用户课程会话。

应用以当前 bundle 重启，旧课程和侧栏会话保留；“我的课程”下新建了空的验收会话，预设为 `better-learning`。从模型菜单选择 DSH 官方目录 `DeepSeek-V41-Flash`（源码 `packages/llm/llm-deepseek/src/models.ts` 映射为 `deepseek-flash`、声明 text+image）；原会话使用的 `Deepseek-V4.1-Flash` 是另一个 work 目录项，先前真实视觉探针曾失败，两个条目切勿混淆。加号菜单实际有“文件”和“文件夹”。原生文件对话框已关闭，未选入资料；**没有发送新消息、没有 API 调用**。桌面自动操作收到“user input was detected in this window”后停止触碰该窗口，避免和用户手动操作相冲突。当前主进程由前台诊断启动的 `start-studio.ps1 -SkipBuild` 维持；无需为下面的本地测试关闭。

下一步可先在隔离 profile/测试框架中完成小型混合资料的原生附件和流程验证；若再操控原用户窗口，先确认用户没有正在操作。可用 `.desktop-cache/mixed-course/附件/` 里的 `lesson.pdf`、`simple-slides.pptx`、`lesson.docx` 三个小文件，不必读取旧大型课程产物。用户明确要求注意 API token，用 DSH 会话用量记录实际消耗。完整迁移版端到端、真实 probe/视觉成员、watchdog 强制中断及 packaged 尚未验收。

## 2026-09-30 混合 Office 视觉准备修复

用隔离目录 `.desktop-cache/native-mixed-script-20260929` 的小型 PDF＋PPTX＋DOCX 资料运行随包 Python：来源盘点 3 份成功，但原本 `convert_materials.py prepare` 把 DOCX 原生图形单元 `SRC-001/U00004` 标为 blocked，原因是没有注册整页 PNG 映射。脚本进程返回 0 不代表单元无阻塞，应看 `_工作区/转写任务.json` 的 processing_route 和 counts。

现在新增 `office_render_requirements.py`，复用提取器的原生视觉特征检测，列出须整页覆盖的 Office part 及 PPTX 实际幻灯片顺序。Host 的 `prepare-transcription` 先调用应用捆绑的 LibreOffice Kit CLI 渲染 DOCX/PPTX 全页，在宿主而非 Agent 沙箱执行；校验 manifest 来源哈希、页数、每页 PNG 路径／大小／签名，再以原子文件写 `_工作区/office渲染映射.json` 并传给 `convert_materials.py prepare`。`_工作区/office渲染报告.json` 保存页数和缺失字体。完整渲染按来源哈希缓存，应用退出后可复用；残缺或被改动的图片不会复用，重试会另建渲染目录及映射。

实测同一组三份资料 prepare 后 7 单元：4 deterministic_text、3 vision、0 blocked，CLI 输出 counts 为 done 4、pending 3、failed 0。二次运行渲染目录数不增加且映射哈希不变；故意增改缓存 PNG 一字节后，下一次运行新增完整渲染目录并重新映射。该测试资料报告缺 `Courier` 字体，需在真实 UI 的异常摘要中如实呈现。Host `tsc -b`、`tsdown`、聚焦 oxlint 与 8 个相关 Vitest 文件 24 项通过（2 项环境跳过）；未调用模型 API，用户原窗口未触碰。

下一步仍是迁移版真实端到端：在用户不操作窗口时，用应用界面或隔离配置完成直接附件发送、跨用户回合目标确认，随后当前实际多模态模型做视觉探针及一批成员，核验 watchdog 与强制中断后的 `resume`，最终生成 packaged 收据。注意 token 用量和缓存口径；不要为检查而读取整门旧课程正文。当前源码变更尚需提交；提交后以 `git status --short` 确认工作区干净。
