# 当前进度

## 功能开关审计（2026-10-22）

已修复实际组合中视觉子代理全部文件工具被误屏蔽的问题，恢复转写的 4 个、探针的 2 个原定工具，并补齐真实 Desktop 课程策略的回归覆盖。另发现历史正文搜索和 Office 制作技能入口仍关闭，暂保留其他有意限制；详见[功能审计交接](WORKFLOW_MIGRATION_HANDOFF.md#2026-10-22-功能开关审计与视觉权限修复)。用户已有的联网启用改动保持原样。

## 模型调用修复（2026-10-22）

已修复课程预设中旧 `{{cwd}}` 变量导致模型请求发不出去的问题。工作目录继续由新版 DSH 的必需运行时上下文提供，课程工作流和模型设置不变。新增三种预设的真实组合请求回归测试均通过，使用隔离模拟模型，未消耗用户 API。现有窗口须完整退出后重新启动；详见[兼容修复交接](WORKFLOW_MIGRATION_HANDOFF.md#2026-10-22-模型请求兼容修复)。

## DSH 底层升级（2026-10-22）

已将 Studio 基础架构更新到与指定安装包同版本的 DSH 0.2.1-rc.2，并保留全部 98 个个性化工作流资源。构建、聚合类型检查、574 项聚焦测试及临时数据目录中的实际 Electron 启动通过，账号占位与 API 模型设置页正常。没有运行真实模型课程或修改现有用户数据。版本来源、备份分支、验证范围和既有文档检查问题见[升级交接记录](WORKFLOW_MIGRATION_HANDOFF.md#2026-10-22-dsh-底层升级)。

## 本轮复核：教学粒度整合（2026-10-10）

用户再次要求把同一份教学粒度修改说明接入当前工作流。逐文件复核原 skill 的 95 文件清单全部匹配当前源文件；16 个三方合并文件的上游输入和 Studio 输出均与上轮整合记录一致，2 个新增资源与上游一致，内置资源无缺失。教学单元、四档深度、标题映射、目标/练习/反馈回执、卡片快照、失效与恢复门禁已在当前工作流中；当前 Host 构建晚于相关源码。此次无需新增功能代码或覆盖既有整合。

使用随包 Python 复验教学单元专项 24 项通过；直接使用现有 Vitest 复验宿主工具、指南快照与原生阶段门禁，13 项通过、1 项既有真实课程环境测试跳过。五份文档链接、内置预设与禁用 skill 加载检查通过。没有调用模型 API、重启用户窗口或改动历史课程。完整逐文件核对脚本保存在 `.desktop-cache/audit-teaching-integration.mjs`。当前教学粒度整合已就绪，真实学生教学效果仍不在本地机械验收结论内。

## 正在排查：启动后的历史会话显示（2026-10-10）

- 用户确认工作区可见，但未看到历史会话。`start.bat` 的启动日志指向原数据目录 `%APPDATA%/BetterLearningStudio-DSH/dsh`，Electron 用户数据目录也沿用原开发目录；尚无证据表明启动器改用了空目录。
- 已用当前构建的持久化与会话查询组件执行只读 `list` 验证：均返回 81 份记录，工作区登记的 14 个主会话全部能找到。没有读取完整聊天正文、调用模型或改动历史数据。
- 当前“复变”的主会话处于归档状态，默认界面会隐藏它；工作区列表默认收起也会隐藏会话行。已请用户选择“显示已归档”并展开“复变”，同时提供截图。其余工作区的显示情况仍待确认，不能将该发现直接当作全部问题的根因。
- computer-use 的 Node 运行时初始化持续失败，未能直接检查窗口。诊断脚本保存在忽略的 `.desktop-cache/inspect-persisted-list.mjs`、`inspect-root-history.mjs` 与 `inspect-history-dates.mjs`；目前没有应用代码修复，仍需完成界面定位与验收。

## 最新整合：教学粒度（2026-10-09）

已读取用户指定的 `开发文档/教学粒度优化/修改说明与接入.md` 并将原 skill 本轮教学单元修改三方合并到内置工作流，保留 Studio 暂存链接、Office、视觉调度与恢复实现。整合前的当前未提交成果备份在 `../backups/bls-pre-teaching-units-20261009-233239/workflow-before.zip`，SHA256 为 `5A972D8DE6A52BBA7A4166A322E49419B72C76F93A04267D8A215FD1BBE562AA`。新增教学单元解析器、规范与 Studio 全章校验适配器；模型工具增加 `guide teaching-granularity`、`run-step units-resolve/units-validate`。讲义支持一单元多 K、独立 TEACH、真实标题映射、分区 EX 池和目标/任务/反馈回执；单元设计进入讲义、卡片与有界局部输入/快照，变更后 refresh 不能绕过重写。原生路径拒绝无效单元，未配置旧章明确报告兼容回退，不自动改写课程；默认仍禁用 skill 加载与 bounded-v1。

验证为新单元专项 24 项通过（原版 20＋Studio 4）、已有教学模板 12 项通过、链接 27 项通过；Host 工具/门禁 13 项通过、1 项既有真实课程环境跳过，新增真实工具输出的教学规范快照通过。类型检查、聚焦 lint、Host emit/bundle、模板目录、预设 YAML、五份文档链接、中英配对与差异格式检查通过。当前 Host 已重建，重启应用后加载新指南与步骤。未调用模型 API，未操作原 skill、全局安装、用户课程和凭据；本轮未进行真实模型/学生教学效果验收。详情见交接文档最新节。

## 既有进度

- 桌面应用基于 DSH v0.1.7-rc.2，完整源码已导入本仓库；旧版代码与用户指定的旧数据已按授权处理。当前开发版在 Windows Electron 中启动过。
- 随包 `better-learning` skill、专用 Agent 预设、DSH 内部可写视觉子代理、同模型路由、内置 Python/Office 运行时已接入。
- 桌面端已有 Codex 风格三栏、底部输入、拖入与加号附件、发送前可点击文件标签预览并点“×”移除、右侧文件预览和课程进度小状态条；模型设置支持内置服务商与兼容地址，账号占位页已显示。实际 Electron 窗口中验证了 PDF 标签的添加与移除。
- 随附 Python 的 pypdf/pypdfium2、Office 依赖经过运行时 smoke；LibreOffice Kit 已由 0.1.1 升至 0.1.2，PPTX 与 DOCX 实际渲染成功。
- 用户在应用中配置模型后，已用三份小型 PDF＋DOCX＋PPTX 附件完成一次真实端到端课程生成：视觉探针通过，7/7 单元转写、知识库、两讲讲义、10 张卡片、链接重建、package 与 packaged 校验均通过。课程位于 `C:/Users/win11/Documents/deepseek-harness/default-workspace/从概念图示到练习趋势`；`_工作区/打包检查.json` 记录 `passed: true`、错误 0。用户在会话里手动切换和重试了模型，不能据此判断应用自动选模异常。
- 用户另用 `C:/Users/win11/Desktop/转写2/复变函数与积分变换` 完成了较大课程测试；交付台账为 1 份来源、270/270 单元、10 讲、51 张卡，packaged 收据 `passed: true`、错误 0。旧 packaged 摘要把来源和单元数显示为 0；脚本已修正为从保留的台账统计，并用小型课程只读复核得到 3 来源、7 单元、12 知识点、2 讲、10 卡，全部通过。
- 真实生成会话的桌面用量计数约 82.1M token、缓存命中约 98%；这是累积模型 token 口径，包含缓存复用，不等于未缓存用量或账单。此后只做本地代码与校验收据检查，没有再次调用模型生成课程。
- 端到端测试发现：课程在工作区子目录时右栏原先误显示“等待课程资料”，打包通过后旧进度文件仍为 `working`。已让右栏识别唯一子课程并以通过的 packaged 收据显示“课程已完成”，同时让今后的 packaged 校验写入完成阶段。应用重新加载后实测右栏显示“课程已完成”。
- 当前开发版配置目录包含测试会话和存储文件；自动审批拒绝递归删除，需保留。新安装使用新的 `Documents/Better Learning Studio/Courses` 默认工作区路径，既有测试会话仍指向此前 DSH 路径。
- 已重建 Host、Client、Web、Electron 并启动；Python/Office runtime smoke、TypeScript 客户端构建和 UI 文案归属检查均通过。最终窗口中确认了品牌和“文件／文件夹”并列菜单。全量 GUI 测试 9200 项通过、1 项跳过、1 项失败；失败项是在此 Windows 环境临时目录创建 symlink 时返回 EPERM，和本次改动无关。
- 恢复专项验收已在隔离工作区 `.desktop-cache/recovery-e2e-20260927` 执行：复制已通过校验的小课程，仅移除副本的 packaged 收据并将进度设为 `working`，模拟 package 完成而最后校验中断；关闭并重启 Electron 后，工作区、会话和检查点保留。右栏原先误写“正在生成课程”且不显示 `next_action`，现改为“课程未完成”并显示待确认的下一步；`package` 命令今后也会把“运行 packaged 校验”写入持久进度。模型在新会话仅检查已有进度/索引/收据，补跑 `validate_package.py --mode packaged`，结果 `passed: true`、错误 0、进度 `complete`；除进度与打包收据外，副本中的所有原产物与原课程逐文件哈希一致。再次重启后，完成状态和会话仍保留。本次模型用量约 128K token、缓存命中 82%；未重复生成课程。本试验覆盖有持久检查点的末阶段恢复。
- 又在隔离工作区 `.desktop-cache/recovery-active-20260927` 执行了真正的运行中断测试：让同一模型会话用随包 Python 启动 45 秒的受控探针，确认 `started` 已写入且 `finished` 尚未写入时强制结束 Electron。探针子进程随宿主停止，等待超过 45 秒后 `finished` 与 packaged 收据仍不存在；重启后原会话、`working` 状态及“运行 packaged 校验”的下一步仍在。直接在同一会话继续，模型没有重跑探针，而是依据已有 final 收据只执行 packaged 校验，结果 `passed: true`、错误 0、进度 `complete`。原课程文件逐文件哈希差异 0（除预期进度、打包收据及探针标记）。该测试会话累计约 102K token、缓存命中 86%。
- Office 原生图形转换在 DSH 工作区沙箱中曾请求一次扩大权限，仍需改善这条运行路径。打包脚本与链接校验的单元测试通过；对大资料的运行时间和 API 用量仍需持续观察，现有会话统计含大量缓存复用。
- 按用户要求新增 Better Learning Studio 原创双页环图标：深绿色圆角底、浅色连续书页，参考 ChatGPT 图标的简洁单色与圆润几何风格而不使用其六瓣结造型。统一替换 Windows/macOS 应用 PNG/SVG、Windows 多尺寸托盘 ICO、侧栏/会话品牌标记、欢迎页字标、安装器浅色/深色与 2x 资源；桌面协议的浅色/深色 favicon 也改为此标记。加入 `render-studio-assets.mjs` 供以后重生成位图。已在实际 Electron 窗口确认侧栏图标和 favicon 服务返回新 SVG；Host/Client/Web 构建通过，品牌/托盘 9 测试、安装器 6 测试及协议专项 1 测试通过。
- 用户否决上述双页环视觉方案，要求先提供黑白线条简约风格的多案选择。已在 `.desktop-cache/icon-options/` 生成 A 展页、B 字母 B、C 学习回环、D 书签四个矢量方案及 `choices.png` 总览；尚未把未选择的新方案安装到应用。后续按用户所选方案替换现有深绿色双页环，再重建并验收。
- 用户选定 A 展页作为基础，要求白底黑线并加入几何元素。已在 `.desktop-cache/icon-options/` 生成 A1 圆点、A2 书脊菱形、A3 四角框线三个矢量细化方案与 `a-refinements.png` 对比图，包含 36px 缩略预览；等待用户选择最终几何处理后安装。
- 用户随后明确选定新概念图的左上角折页标记，取代此前 A1/A2/A3 待选状态。已将选中的折页轮廓重绘为白底黑色矢量，并统一替换桌面应用 SVG/PNG、Windows 托盘 ICO、侧栏/会话品牌组件、欢迎页及安装器明暗两套字标资源；`.desktop-cache/icon-options/selected-top-left-preview.png` 展示大图、128/64/32/24px 和暗色界面预览。已用 `DSH_CLIENT_BUILD_PROFILE=better-learning` 重建 Client 与 Web，构建产物中的品牌组件注册及新路径均存在；托盘/安装器/品牌三组测试通过，桌面协议 favicon 专项测试通过。旧产品名造成的 9 个 main-startup 断言与快照已更新，109/109 测试通过。Web 构建在沙箱内读取 Vite 配置受限，获自动审查批准后在扩大权限下完成。确认旧实例无活动课程子进程、会话文件约三小时未更新后重启开发版；沙箱内启动因 AppData 锁文件与 GPU 权限失败，以扩大权限重试后成功。实际 Electron 窗口已重新打开，侧栏展示新黑白折页标记，课程会话与完成状态保留。
- 用户指出 Windows 应用图标仍显示 Electron 默认图标。已从折页 SVG 新增 16–256px 的独立 `icon-windows.ico`（与托盘放大版分开），设置到 Windows BrowserWindow 和 electron-builder 的 exe 图标，并随包附带 `icon.ico`。开发版通过 `resedit` 在 `.desktop-build/development/branded-electron` 生成带品牌图标及 ProductName 的私有 Electron 可执行文件，原始依赖不变；保留文件名 `electron.exe` 以维持 Electron 的未打包开发模式。`start-studio.ps1 -SkipBuild` 改用 `node --import=tsx` 直接启动，避免当前 pnpm 的交互式重装提示。已核验私有 exe 可运行 Electron 44.0.0、PE 含 9 个图标尺寸与正确产品名；桌面图标/安装器/主进程专项 119/119 通过、桌面端构建通过。开发版重新启动后，进程路径指向私有品牌 exe，实际窗口加载成功并保留课程列表。未调用模型 API。
- 新增根目录 `start.bat`，双击后从自身所在目录隐藏启动 `start-studio.ps1 -SkipBuild`；批处理窗口随即关闭，桌面应用继续运行。路径带空格时也通过引号正确传入；启动前检查 PowerShell 脚本是否存在。已用 `cmd.exe /c start.bat` 实测返回码 0，品牌版 Electron 进程启动，Better Learning Studio 主窗口正常显示；未调用模型 API。
- 2026-09-29 开始把 better-learning 从强制加载 skill 迁移到应用内置工作流。迁移前在 `../backups/bls-pre-workflow-20260929/source.bundle` 备份完整源码 Git 历史并通过 `git bundle verify`；在用户 AppData 的同名备份目录保存应用配置和凭据 ZIP（敏感文件未进入仓库），记录 SHA-256。源码从干净的 `e1ffbe8` 建立 `codex/built-in-course-workflow` 分支。Host 已加入七阶段原生游标、原子持久化、阶段凭证复核、中断后待检查恢复、模型变更失效处理、认证工作区内的操作接口；启动时会核对已有原生课程并标出中断阶段。首动作仍由应用运行 `--mode plan`；原有确认位通过脚本写回。转写看门狗已接入 DSH `subagent/end` 与 90 秒定时检查，实际成员状态和异常摘要落盘；右栏在有原生游标时优先显示待检查／暂停与看门狗异常。Host/Client TypeScript 检查及 23 个聚焦测试通过（1 个环境变量控制的真校验测试默认跳过）；对已完成小课程的副本使用随包 Python 做 plan、materials 与 packaged 真校验通过，全程未调用模型 API。当前仍保留 skill 作为实际内容生成路径，聊天输入尚未接原生接口，原生看门狗暂只提示异常而不代替主代理收集、派发；完整迁移需继续实现视觉批次调度、知识与讲义写作驱动及混合资料验收。
- 2026-09-29 后续迁移：专用 Agent 预设已关闭 skill 加载，随包资源由 `resources/skills/better-learning` 移到 `resources/workflows/better-learning`；新增 `runtime-policy.md` 和模型工具的 `guide` 操作，按阶段读取规范与模板。修正了 Host 脚本根路径少一层目录的问题。模型工具与认证 HTTP API 共用游标，工具绑定当前根 Agent 的 Session 工作区；`propose` 先保存需求摘要，`confirm` 只能在后续真实用户回合提交。`inspect` 保持只读，避免把运行中的课程误判为中断。原生 `probe` 新建独立 DSH 视觉成员进行随机读图＋写入挑战，失败暂停；`transcribe-batch` 整批预约、启动全新子代理、登记真实 ID、等待真实终态后收集，并处理暂停时的启动竞争。`resume` 在转写阶段先拒绝仍存活成员，再对已停止尝试执行脚本 `recover`，释放未登记预约。看门狗对未变化静默异常只提醒一次。旧课程不自动建原生游标，仍可通过 `guide` 读取内置规范继续旧台账流程。Host/桌面 TypeScript 与 bundle 构建、22 项聚焦测试、27 项随包 Python 测试通过；Python 测试有一条 Windows 子线程 UTF-8 解码噪声但测试进程返回 0。未调用模型 API。迁移版真实混合资料端到端验收、UI 对话与原生确认动作的直接接线、后续写作阶段的更多宿主机械动作仍待完成。
- 同日继续：宿主新增 `prepare-transcription`、`diagnose-transcription`、`assemble-transcription` 和 `run-step` 阶段白名单，执行知识合并、逐章讲义准备/提交、卡片与 Obsidian 链接收口、final 校验及 package 预览/正式打包；另以 `native-transcription.md` 替代会要求模型手动派发成员的旧转写说明，并把参考文档中的 `SKILL/scripts` 替换为 `guide` 返回的 `<scriptsRoot>` 占位。Host TypeScript、聚焦 lint、6 个测试文件 23 项通过。安装器脚本测试因本机缺 Visual Studio C++ Build Tools 与 Windows SDK，在准备阶段被环境阻断；尚未运行新路径的真实 Electron／模型端到端验收。
- 同日隔离桌面 smoke：原运行中的开发版仍占默认 19387 端口，因此新加可配置的 `BLS_WEB_PORT`，用独立 `DSH_HOME`／Electron 用户数据、19388 端口启动迁移版。首次发现当前工作区 `apps/desktop-host/node_modules` 缺新旧四个 DSH workspace 依赖链接，现已补齐本机忽略的 junction；`pnpm-lock.yaml` 已记录新增直接依赖。隔离实例随后成功启动，已认证工作流路由对 `{}` 返回预期 400，证明路由已挂载；测试实例已关闭，原窗口未受影响。模型 API 未调用。宿主还增加 `create-course`（根工作区会话中安全创建唯一直接子课程）和实际选模与课程模型不一致时阻止继续的保护，相关测试通过。仍需真实 UI／模型转写及中断恢复验收。
- 同日继续把聊天资料接入原生游标：Better Learning 专用桌面输入现在把单个文件以 DSH 持久上传附件发送，文件夹仍保留原有 `@目录/` 芯片。宿主 `create-course` 从当前真实用户消息中导入文件／图片附件，解析用户明确引用的文件夹，并调用随包 `inventory_materials.py`；资料阶段另有 `import-attachments` 用于本轮补充。导入文件写入课程 `原始资料/`，用哈希、字节数和原子发布校验；来源清单持久保存在 `_工作区/附件导入.json`，脚本只接收这份清单的文件与目录。Host 脚本强制 UTF-8 输出。聚焦 Host 与输入界面测试 47 通过、2 条环境型测试跳过；启用随包 Python 的中文路径真实盘点专项也通过。Host 和 Conversation TypeScript、bundle、Better Learning 配置的 Web 构建、聚焦 lint、72 包依赖检查通过；翻译配对门槛因未改动的 `apps/desktop/README.i18n.yaml` 旧同步记录失败。未调用模型 API，原窗口未重启；迁移版混合资料全流程与中断恢复仍待验收。
- 2026-09-29 再续：资料已导入但盘点脚本中断时，`course_workflow refresh-inventory` 会从持久来源清单核对文件哈希与目录后重跑盘点，不必重新上传；`create-course` 导入失败也会返回已创建课程名和可用恢复动作，避免误建第二门课程。9 个 Host 聚焦测试文件共 33 通过、2 跳过；Host TypeScript、lint 和 bundle 构建通过。用独立数据目录与 19388 端口启动新 Electron，进程及 Host 端口可用，随后已单独关闭，原用户窗口未受影响。隔离启动日志出现一次 `mandatory-status` IPC 未注册错误，尚需判断是否影响 UI。未调用模型 API；真实多模态探针、子代理批次、看门狗中断恢复和最终 packaged 仍待验收。
- 2026-09-29 图形界面续验：隔离 Electron 主窗口正常呈现 Better Learning Studio 与底部输入，但加号菜单起初缺“文件夹”。原因是浏览器运行时不能可靠读取 `DSH_CLIENT_BUILD_PROFILE` 构建标志；改由仅限 `dsh-app://app` 的 preload 暴露 `__BLS_STUDIO__`，前端据此注册文件夹动作并把单个文件作为持久附件上传。重建后在隔离窗口实际看到“文件／文件夹”并列菜单，原用户窗口未操作。桌面与输入聚焦测试 35/35、TypeScript、桌面及 Web 构建、聚焦 lint、`git diff --check` 均通过。隔离测试进程已关闭；未调用模型 API。用户周额度当时约 99%，迁移版完整混合资料端到端、真实视觉子代理与中断恢复仍未验收。
- 资料导入恢复续作：在复制第一份附件与保存整批来源清单之间，旧实现若中断会留下未登记来源，下一回合无法仅靠 `refresh-inventory` 恢复。现先原子保存当前真实用户消息中的待导入附件引用及已确认文件夹，再发布来源文件；`refresh-inventory` 会从 DSH 持久附件库完成未结束批次，复核哈希后写入正式台账，才运行资料盘点。旧版无 pending 字段的清单仍可读取。模拟第二份附件流中断后，仅靠持久台账恢复两份来源且不重读已复制的第一份；8 个 Host 聚焦文件 33 通过、2 跳过。未调用模型 API。
- 迁移版实机准备：已确认原桌面课程会话显示“已完成工作”，从应用菜单正常退出；在 `AppData/Roaming/BetterLearningStudio-DSH/backups/bls-pre-native-live-e2e-20260929/profile.zip` 备份退出后的当前配置与会话（8310 项、约 349 MB 原始数据，ZIP SHA-256 见交接文档），然后重启并确认原课程列表保留。于“我的课程”新建验收会话，选择 DSH 官方 `DeepSeek-V41-Flash`（源码目录声明 text+image），与旧会话使用的另一个同名近似工作模型区分。真实窗口中确认“文件／文件夹”菜单；原生文件对话框未完成资料选择。桌面自动操作检测到新的人工输入后已停止交互，尚未上传资料、发送消息或调用模型 API。
- 2026-09-30 混合资料机械验收发现并修复 Office 原生图形阻塞：隔离的 PDF＋PPTX＋DOCX 三份资料首次 `prepare` 生成 7 单元，其中 DOCX 原生形状 1 单元因缺整页渲染而 blocked。现在宿主 `prepare-transcription` 先用随包 LibreOffice Kit 自动渲染需要完整视觉覆盖的 Office 来源，校验源哈希、每页 PNG、页码和 PPTX 幻灯片顺序，原子写入 `office渲染映射.json` 后交给提取脚本；缺失字体单独写 `office渲染报告.json` 并随工具结果返回。相同资料复测为 4 个可靠文本单元完成、3 个视觉单元待转写、0 blocked；重跑复用完整渲染，故意损坏缓存 PNG 后会生成新渲染并重映射。Host TypeScript、bundle、聚焦 lint 与 8 个测试文件 24 项通过（2 跳过）；这一轮没有调用模型 API。真实迁移版模型探针、子代理整批、强制中断恢复、最终课程包仍待验收。
- 右侧课程状态条补充原生游标已通过阶段数（N/7），转写阶段若 Office 渲染报告存在缺失字体，显示受影响来源数，仍只占用小状态条。界面组件与读取器类型检查、lint、7 项进度组件测试及 Better Learning 配置的 Web 构建通过。Vite 在当前沙箱读配置被拒，扩大权限后仅执行本地构建成功；未调用模型 API。
- 清理迁移残留的交付说明：内置工作流的 delivery 指南现在由 `run-step package-preview/package` 和 `complete-stage` 完成收尾，不再引导模型手动停止 `watchdog.py` 或调用其他宿主的子代理接口。打包清理集加入 `_工作区/office渲染/`，避免新引入的整页 PNG 缓存滞留在最终课程包；映射与缺字字体报告仍留作过程证据。Python 27 项测试通过，Windows 上仍有此前已知的一条子线程 UTF-8 解码噪声；已打包的小型测试课程无法再执行 package dry-run（缺原位知识文件），因此此项尚待未打包课程的最终验收确认。
- 恢复门禁检查发现 cards 阶段的复核链原先只查路径和卡片，不直接重验上一阶段讲义；现加入 `verifyLessons`，使重启或进入交付前若讲义证据失效就退回待检查状态。Host TypeScript、bundle、lint 与 11 项聚焦测试通过（2 项环境型跳过）。
- 隔离宿主级混合资料恢复验收（无模型 API）：在新课程目录复制三份小资料，真实运行 inventory、plan、内置游标 initialize/propose/confirm、materials start/complete、transcription start、Office 自动渲染与 prepare。得到 3 来源、4 单元直接完成、3 视觉单元待转写、0 失败；模拟宿主重启的 `reconcile` 把运行中 transcription 变为 `needs_review`，显式 `resume` 后才回到 ready。另在副本中改动已通过校验的 DOCX，下一次 `reconcile` 正确把阶段退回 materials/needs_review；试图在 3 个视觉单元未完成时调用 `completeStage` 被拒绝。尚未覆盖真实模型探针、子代理与强制结束进程。
- 修正文件夹来源与 Office 渲染的接线：初版渲染器只接受课程 `原始资料/`，会误拒用户明确选择的外部文件夹。现在从持久附件导入台账读取已登记文件夹，验证真实目录、非课程祖先和未完成导入状态，只允许其内的真实 Office 来源；未登记路径仍拒绝。新增测试证明边界，并用外部 `Materials` 文件夹中的同一组三份资料真实运行 inventory＋渲染＋prepare：3 来源、4 done、3 pending、0 failed。未调用模型 API。
- 2026-09-30 继续：转写 `prepare` 摘要增加跨来源唯一的 `blocked_units`，宿主遇到受阻单元或渲染／脚本失败时将课程暂停并保存原因，阻止后续视觉成员在不完整资料上空转。无受阻的混合夹具返回 `blocked_units: []`；Host TypeScript、bundle、聚焦 12 项与随包 Python 27 项测试通过。尚未调用迁移版模型 API。
- 同日桌面与看门狗续验：在标准 Windows 会话启动最新 Host 开发版，主界面、better-learning 预设、DeepSeek-V41-Flash、文件／文件夹菜单均实际显示；通过系统文件对话框选择合成 PDF，发送前出现可移除的附件卡片，移除后卡片消失。继续读取文件选择器完整辅助功能树被自动审批拒绝（可能暴露无关私人文件名），已停止该 UI 路径并关闭测试进程，未发送课程消息或调用模型 API。看门狗现在在宿主批次结束后，对仍未收口的已停止／未知成员发一次异常提醒，批次正常收尾时抑制误报；Host TypeScript、聚焦 13 项通过。真实迁移版混合课程与强制中断仍待验收。
- 同日修复资料确认前的恢复断点：`create-course` 导入中断后原生游标处于 `waiting_confirmation`，旧 `refresh-inventory` 却拒绝此状态；现在资料阶段各状态都可从持久来源清单重跑盘点。用户在资料阶段补交附件时会先重开 intake，清除旧摘要、已确认标志与模型，须重新归纳并由下一真实用户回合确认；避免新资料沿用旧范围确认。Host TypeScript、聚焦 lint 与 22 项相关测试通过；尚未做迁移版模型验收。
- 新课程目录已创建但初始化前的运行时／计划校验失败时，`create-course` 现在返回课程名、错误与 `initialize` 恢复入口，避免同名重试只得到“目录已存在”而丢失恢复路径；API 聚焦测试在故意缺运行时的情况下验证目录保留、游标未伪造。Host TypeScript、lint 与该文件 7 项测试通过，未调用 API。
- 重启校验器暂时抛错时，原生游标现在保存 `needs_review` 与短原因，保留此前通过的阶段凭证；若已完成课程的 packaged 复验无法运行，则退到 delivery 待确认，不继续显示虚假的 complete。两种恢复路径均有持久状态测试；Host TypeScript、lint 和工作流 12 项测试通过。
- 关闭未接线的 HTTP `confirm` 入口：之前模型工具有“已提议摘要＋更晚真实用户回合”门槛，但认证 HTTP 路由能直接调用 confirm。现在确认仅由模型工具完成，未来独立界面确认控件需绑定真实用户动作后再开放。中英 Host 文档与 API 测试同步；TypeScript、lint、7 项测试通过。
- 补交资料重开 intake 时同步把旧 `_工作区/生成进度.json` 的 goal/materials/baseline 确认位清为 false，避免原生游标与旧校验脚本读取的状态分叉。用真实随包 Python 在一份已盘点的合成 PDF 课程上执行确认→重开烟测，三位从 true 全部回到 false；Host TypeScript、lint、9 项聚焦测试通过，未调用模型 API。
- 课程 Host 全部聚焦文件复跑为 41 通过、2 项环境跳过；DSH SDK 的假模型子代理生命周期测试 55/55 通过，均未调用用户 API。真实多模态视觉探针、混合资料成员以及 packaged 仍待用户完成合成文件夹的系统选择器步骤后验收。当前开发版窗口保持运行；用户尚未发送测试课程请求。
- 右侧课程文件预览未默认展开的原因已定位并修复：`ui-sidebar-files` 仍用浏览器运行时不可依赖的 `process.env.DSH_CLIENT_BUILD_PROFILE` 判断 Better Learning，现改为桌面 preload 的 `__BLS_STUDIO__` 标记，与底部文件夹入口一致。测试对两个 Session 各自动打开一次、同 Session 不重复打开；UI TypeScript、lint、12 项聚焦测试通过。尚需在用户完成当前选择器操作后重建 Web 并重启实机确认。
- Better Learning 配置下的 Vite Web 构建已在标准文件权限中通过（受限沙箱内 esbuild 无法读取其配置路径）；当前运行窗口尚未重启，因此右栏自动展开仍需实机复验。构建没有调用模型 API。
- 2026-09-30 隔离桌面窗口复验发现右栏仍未展开：Web 外壳已构建，但 `ui-sidebar-files/lib/client.js` 仍是旧版，旧条件在插件打包后被折叠成恒假。重建文件插件后，隔离 Electron 窗口刷新即默认出现“文件”页和“等待课程资料”状态条。其余 Studio 客户端标记判断也改用 preload 的 `__BLS_STUDIO__`，重建文件、侧栏、品牌和账号四个插件 bundle；39 项聚焦 UI 测试、四包类型检查与 lint 通过。全量 GUI 测试尝试中断于本机 Node `uv_os_get_passwd` 的 ENOMEM，并出现既有系统对话框等环境失败，未将其记为通过。隔离窗口已结束，原用户窗口保留；此轮未调用模型 API。主窗口仍运行较早 Host，需要在用户完成附件操作后重启以加载最新后端。迁移版真实模型视觉探针、成员批次、强制中断恢复与 packaged 尚未验收。
- 第三方声明生成检查暴露迁移时新增的 `pypdf`、`pypdfium2` 尚未进入 Python 分发元数据表；已按项目许可证补齐并重生 `THIRD_PARTY_NOTICES.md`，相关 37 项测试在标准文件权限下通过。受限沙箱内读取 Vite 配置失败，故生成与最后一项测试使用了获准的标准文件权限；提交钩子的 shell 不在其 PATH 中，已单独执行 lint、空白、声明生成及 vendor 守卫后提交。
- 内置转写阶段的本地强制中断烟测使用三份合成 PDF＋PPTX＋DOCX、随附 Office 渲染与 Python 脚本；只为恢复路径写入明确的合成探针凭证，未声称读图能力通过。子进程在 3 个 DSH 尝试已预留、其中 1 个登记为运行中且尚无结果时被结束；新进程 `reconcile` 持久显示 transcription/needs_review，watchdog 报告 3 个未知状态尝试，`recoverStoppedCourseAttempts` 回收该运行中尝试并释放 2 个未启动预留。台账活跃尝试从 3 归零、3 个视觉单元仍可重试；显式 `resume` 后为 ready，再 `start` 为 running，watchdog 新监测结果为 0 个活跃尝试／3 个待派单元。没有模型 API 调用，也没有重复生成课程包。真实模型探针、子代理实际批次与最终 packaged 仍待验收。
- 2026-09-30 续查恢复与启动：`CourseWorkflow.reconcile` 现在在未进入正式打包时，先复核已完成的资料来源及转写凭证，再核最近阶段；较后阶段原始资料或转写变化会退回相应可修复阶段。新增 cards 阶段回退 materials/transcription 两例，游标 14 项与新端口 2 项测试、Host 类型检查及构建通过。主开发版启动时发现已安装 DeepSeek Harness 占用原默认 19387，导致 `EADDRINUSE`；Host 改为默认选择空闲 loopback 端口，保留 `BLS_WEB_PORT` 显式指定，实机与已安装 DSH 同时运行成功。隔离窗口的原生文件夹选择器未能通过自动化工具正确定位，路径误进隔离聊天并因隔离配置无 API 凭据立即失败；该窗口已关闭，未发生模型用量。主开发版已打开，等待用户手动添加合成文件夹并确认目标，之后才可验收真实视觉探针、子代理批次与 packaged。不要把上述本地烟测称为真实模型端到端完成。

- 2026-10-09 按用户指定的原 skill 和 AGENT_HANDOFF.md 整合新增教学模板系统。改动前已备份内置资源、Host 源码/测试及预设到 `../backups/bls-pre-subject-templates-20261009/workflow-before.zip`（校验和见同目录 README）。内置资源新增 22 类学科＋generic、9 活动模块、4 目标模式和路由，合并四个共用模板、讲义 teaching_design/快照、卡片 teaching_designs/快照和有界任务局部输入；保留 Studio 的 staged 链接修复、Office 渲染、DSH 子代理、watchdog 和打包适配，默认仍不启用 bounded-v1。Host guide 新增 subject-routing/teaching-catalog，run-step 新增 teaching-resolve/teaching-validate；从真实章节与知识索引检查全部覆盖，原生知识/路径阶段须有有效显式教学设计，旧台账直接用原脚本保留 generic 回退。随包 Python 模板/适配器 12 项、原有链接 27 项通过；Host 10 文件 46 项通过、1 项环境跳过，包含真实阶段接受/拒绝测试和工具 schema/目录快照。扩展原 skill v2/有界回归 60 中 51 通过、9 项因测试专用 reportlab 缺失而报环境错误，不称全通过。Host 类型检查、lint、bundle、预设 YAML 解析、两对中英 README 配对与链接检查通过。最新 Host 已构建，完全退出后用 start.bat 重开加载；未操作用户课程、凭据和原 skill，未调用模型 API。本次未验收真实模型的学科教学质量；原迁移任务完整混合资料真实端到端仍待验收。交接见 WORKFLOW_MIGRATION_HANDOFF.md 最新章节。

- 2026-10-09 修复用户报告的 start.bat 无响应。原脚本实测约一分钟后才打开桌面窗口，原因是每次启动前都重新准备完整运行资源。新增开发资源复用检查（锁定版本/摘要、执行入口、Python 包元数据、Office 文件内容），资源缺失或变化时仍执行正常准备，发布打包路径保持原检查。当前资源复用检查约 1.1 秒。启动器使用 Windows PowerShell 绝对路径，记录脱敏启动日志，命令失败时弹窗给出日志位置，PATH 中无 Node 时使用已准备的随包 Node。两个新增测试文件共 6 项通过，聚焦 lint、正确带供应库引用的类型检查、桌面 README 中英文配对和 diff --check 通过。实际通过 cmd.exe 执行 start.bat 返回 0，日志确认复用资源，约 11 秒完成再次启动并聚焦现有 Studio 窗口；未强制关闭正在运行的应用，因此不声称修复后完成了全新进程冷启动验收。computer-use 内核因主机沙箱异常无法初始化，未做截图验收。应用当前保持打开，未调用模型 API；此前模板整合修改全部保留。

- 2026-10-09 已整合教学单元与讲解深度优化；最新备份、接口、验证与生效方式见本文顶部的教学粒度节和 WORKFLOW_MIGRATION_HANDOFF.md 首节。Host 已重建，重启应用加载，未调用模型 API。
