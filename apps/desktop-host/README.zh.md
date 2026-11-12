---
description: "Better Learning Studio 桌面宿主的工作流控制、校验、恢复和视觉派发。"
kind: "package-reference"
---

# Better Learning Studio 宿主工作流

[English](README.md) | 中文

设置 `BLS_WORKFLOW_ROOT` 后，桌面宿主提供已认证的 `POST /api/better-learning/workflow` 和模型可调用的 `course_workflow` 工具。二者共享持久化的 `_工作区/内置工作流.json` 游标。课程必须是已登记工作区根目录或直接子目录，并核对真实路径。HTTP 接口支持 `inspect`、`initialize`、`change-model`、`start`、`complete-stage`、`pause`、`reconcile`、`resume`、`watchdog`；intake 的 `confirm` 留在模型工具，以校验已保存的摘要和更晚的真实用户回合，桌面端目前没有独立的确认控件。模型工具另外支持 `guide`、`create-course`、`propose`、`probe`、`transcribe-batch` 和按阶段限制的机械动作。`create-course` 要求工作区根会话的真实用户回合，在计划初始化前创建一个新的直接子目录。

Web 监听端口在启动时自动选择空闲的本机 TCP 端口，避免与已安装的 DSH 实例冲突；隔离桌面实例可用 `BLS_WEB_PORT` 指定固定端口。

`initialize` 在建立游标前运行随包计划校验。模型用 `propose` 保存需求摘要，`confirm` 要求下一轮真实用户消息。`guide` 按名称读取随应用发布的阶段规范或模板。模型名称来自当前 Session 请求。每个阶段只有经过宿主对实际产物和脚本收据的校验才可前进。切换模型会使转写和后续凭证失效。普通 `inspect` 只读；启动扫描和显式 `reconcile` 才把中断状态改为 `needs_review`。

`probe` 和 `transcribe-batch` 分别采用独立的 `better-learning-probe` 和 `better-learning-vision` 预设，新建由 DSH 管理的激活实例。二者各自提供任务角色说明，并继承父代理当前的服务商、模型和推理强度。探针仅开放 `read_image` 和 `write`，转写另开放 `read` 和 `edit`；各自的允许列表保留预设提供的文件工具，并屏蔽其余继承工具，包括宿主课程控制工具。探针读取随机测试图，再校验落盘答案；主代理不读取图片或预期答案，失败时暂停课程。转写整批预约，登记真实子代理 ID，并仅在真实终止且资源释放后收集结果。取消会释放对应的激活实例，包含取消期间才完成发布的子代理。结果交回宿主，由宿主发送批次摘要，不再额外自动发送单个子代理通知。工作流游标使用 `schemaVersion: 1`，阶段顺序和旧课程恢复方式不变。

宿主看门狗按时及收到 `subagent/end` 后检查台账，保存异常，对未变化的静默尝试只提醒一次。显式 `resume` 核对当前宿主成员：仍运行的成员会阻止恢复；已停止的登记尝试先收集，未登记预约先释放，然后游标才变为就绪。

专用 Agent 预设通过 `guide` 读取应用策略，skill 加载已关闭。角色后缀只插入当前模型；工作目录服务通过必需的运行时上下文提供当前课程目录。`run-step` 只在匹配阶段执行白名单内的知识合并、讲义提交、卡片与链接处理、打包命令。聊天输入保留 DSH Session 发送与附件流程。没有原生游标的旧课程继续原有路径；右侧状态条优先显示原生状态。教学内容和语义复核仍由模型编写，宿主执行阶段校验。迁移路径尚未进行真实 API 端到端验收。

<a id="teaching-templates"></a>

## 教学模板

`guide subject-routing` 说明选择和继承，`guide teaching-catalog` 列出 22 类学科、通用回退、9 个活动模块和 4 个目标模式。写作者依据可靠资料和已确认需求，将选择保存为独立的 `_工作区/教学设计.json`。`run-step teaching-resolve` 返回默认或可选 `lesson` 的组合及资源路径、哈希；Studio 适配器从真实章节和知识索引校验全部覆盖，调用者不能自填知识 ID。`teaching-validate` 要求显式配置，原生知识与路径阶段也执行此检查；旧台账直接调用原脚本时仍保留无配置回退。

讲义 manifest 带 `teaching_design`，卡片计划带 `teaching_designs`。输入快照记录有效选择和选中资源哈希，不含安装路径；修改选中资源会使受影响的讲义和卡片过期，未选学科及其他章节的选择不会单独使本章过期。写作输入改变后须复核并重新生成、提交受影响产物，不能删除凭证绕过新鲜度检查。实验有界流水线收到局部模板副本，但默认不开启。模板校验不证明教学质量。

四个共用模板位于 `apps/desktop/resources/workflows/better-learning/assets/templates`；学科、活动和目标模式文件在 `subjects/catalog.json` 登记。维护后用随包 Python 运行 `templates.py check` 和 `apps/desktop-host/tests/python` 的离线测试。运行时只读应用内置资源，不依赖原 skill 目录或全局安装；配置格式见[学科路由](../desktop/resources/workflows/better-learning/references/subject-routing.md)。

<a id="teaching-units"></a>

## 教学单元

`guide teaching-granularity` 说明如何按目标组合知识记录，并选择提醒、标准、深入或拓展深度。新课程在知识与路径编排后、`lesson-prepare` 前保存 `_工作区/教学单元.json`；学科选择仍放 `教学设计.json`。`run-step units-resolve` 必须带 `lesson`；`units-validate` 从已保存的知识归属校验全部章节。原生路径校验拒绝无效单元。未配置章在 `legacy_lessons` 中明确报告，保留一 K 一 section，不改写旧正文。显式单元要求 v2 课程身份。

讲义 manifest 和卡片计划传递 `teaching_units`。一个 section 可覆盖多个 K，每个 K 在 `knowledge_headings` 登记互不重叠的真实标题，装配仍保留独立 TEACH 身份。练习使用当前 section 的独占预留 ID 和真实题目/反馈标题。提交要求 `unit_reviews` 把全部计划目标映射到实际练习，记录必要推理、删减复核和限制。恢复时已完成 checkpoint 的标题映射受保护。单元变化使受影响讲义与卡片输入过期，`refresh` 不能代替 prepare 和 commit。分组、深度与停止依据不新增固定篇幅或题量要求。机械检查不证明答案正确或学生已掌握；详见[单元规范](../desktop/resources/workflows/better-learning/references/teaching-granularity.md)。

原生讲义提交和卡片定稿在内容发布前运行固定的 semantic-v1 语义排版步骤。宿主使用当前模型，在独立、有日志、无工具的会话中请求原文绑定的标注计划和独立审核，每组最多一轮修复。卡片按完整单元分组，其他卡片失败时保留已通过结果。固定语义样式、精确引句、保护范围、条件句检查及讲义8%／卡片6%的荧光上限约束采用范围。Markdown 字节、链接、来源身份、掌握证据及既有内容哈希保持不变。可选的 `.betterlearning/presentation/` 清单在派生关系变化后重新绑定；教学内容绑定失效时使用基础排版。新原生课程要求每个单元都有通过或基础排版终态，旧课的阶段证据保持。卡片元信息和核对区默认折叠，关闭颜色后仍可展开。旧课和导入课程不自动收费重排，外部 Markdown 阅读器仍显示完整原文。打包保留排版目录，不增加全局哈希检查。

表格单元格内双链的别名分隔符在 GFM 分列前受到保护，UTF-16 原文位置不变。表格采用语义表头，长内容换行，多列表格仅在自身横向滚动；引用和选段仍对应原始 Markdown。

受认证的课程API提供不修改正文的`graph`操作：课程库排除私有和隐藏条目，解析本地目标、归一标签并按文件目标去重后返回有界元信息，不创建Workspace或Session，也不改写课程Markdown。控件及边界见[课程工作台说明](../../docs/studio-course-workbench.zh.md)。

图谱仅读取索引元信息，不加载索引正文；精确路径和basename查表保留相对目录优先与重名歧义。最多八个课程独立的关系索引复用未变源文件，只使引用新增或删除文件名的关系失效。仅索引解析按内容哈希复用复制、改名及时间戳变化后的元信息，重启后也可复用持久记录，额外内存内容缓存上限16 MiB。这些派生缓存不替代写入或引用前的磁盘原文核验。

图谱扫描在单次读取批次中复用已准入的目录前缀与文件状态，遍历前排除私有工作目录，变化文件在解析前后重新核验路径。规范叶路径和根目录身份检查拒绝目录被替换后的重定向；写入和引用仍单独重新准入。`graphProfile`记录扫描、索引、投影耗时与批次文件系统操作次数。生成、导入后的公开文件变化合并为串行后台索引。原子写入且有界的`.studio/index/graph.json`快照独立于SQLite源文索引，保存关系元信息和可选视角、坐标；读取校验格式、课程身份和元信息摘要，失效时重建。初次条件图谱视图可先返回暂存快照，随后立即获取已核验元信息；普通`graph`调用仍返回核验结果。布局消息限制大小，只接受已准入图谱路径。快照上限16 MiB，内存最多保留八门课程。

图谱独立投影从YAML属性值提取双链并解析别名，不向规范改名链接写入伪造偏移。属性遍历上限为八层、20000个值。图谱重名候选按来源目录优先、路径长度及确定顺序裁决；其他链接消费者仍保留显式歧义。未解析名字归一化，未引用附件不入图，标签显示保留原形并合并大小写变体。

条件`view`响应返回版本，内容未变时省略载荷。课程库拥有排队的解析Worker，在后台准备阅读投影，有界缓存合并重复读取。每课可重建的`.studio/index/course.sqlite`保存元信息和FTS行，更新变化文件并移除已删除记录；仅索引任务不返回阅读树或排版计划。文件元信息检查及受影响路径的监听失效刷新缓存提示，保存、重命名提交和引用准入仍重新核对磁盘原文。Host停止时取消任务并释放Worker，空闲解析线程也会释放。发布包包含解析入口，不要求另装运行时。

课程接口预留讲解动作，在创建引用或学习会话之前拒绝该请求。举例、要点、自测和追问继续使用带版本的选段流程。
