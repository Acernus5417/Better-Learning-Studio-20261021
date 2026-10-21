---
description: "Better Learning Studio 桌面宿主的工作流控制、校验、恢复和视觉派发。"
kind: "package-reference"
---

# Better Learning Studio 宿主工作流

[English](README.md) | 中文

设置 `BLS_WORKFLOW_ROOT` 后，桌面宿主提供已认证的 `POST /api/better-learning/workflow` 和模型可调用的 `course_workflow` 工具。二者共享持久化的 `_工作区/内置工作流.json` 游标。课程必须是已登记工作区根目录或直接子目录，并核对真实路径。HTTP 接口支持 `inspect`、`initialize`、`change-model`、`start`、`complete-stage`、`pause`、`reconcile`、`resume`、`watchdog`；intake 的 `confirm` 留在模型工具，以校验已保存的摘要和更晚的真实用户回合，桌面端目前没有独立的确认控件。模型工具另外支持 `guide`、`create-course`、`propose`、`probe`、`transcribe-batch` 和按阶段限制的机械动作。`create-course` 要求工作区根会话的真实用户回合，在计划初始化前创建一个新的直接子目录。

Web 监听端口在启动时自动选择空闲的本机 TCP 端口，避免与已安装的 DSH 实例冲突；隔离桌面实例可用 `BLS_WEB_PORT` 指定固定端口。

`initialize` 在建立游标前运行随包计划校验。模型用 `propose` 保存需求摘要，`confirm` 要求下一轮真实用户消息。`guide` 按名称读取随应用发布的阶段规范或模板。模型名称来自当前 Session 请求。每个阶段只有经过宿主对实际产物和脚本收据的校验才可前进。切换模型会使转写和后续凭证失效。普通 `inspect` 只读；启动扫描和显式 `reconcile` 才把中断状态改为 `needs_review`。

`probe` 新建具有读图和写入工具的 DSH 子代理读取随机测试图，再校验落盘答案；主代理不读取图片或预期答案。探针失败会暂停课程。`transcribe-batch` 整批预约，创建独立子代理，登记真实 ID，并仅在其真实终止后收集结果。宿主看门狗按时及收到 `subagent/end` 后检查台账，保存异常，对未变化的静默尝试只提醒一次。显式 `resume` 核对当前宿主成员：仍运行的成员会阻止恢复；已停止的登记尝试先收集，未登记预约先释放，然后游标才变为就绪。

专用 Agent 预设通过 `guide` 读取应用策略，skill 加载已关闭。`run-step` 只在匹配阶段执行白名单内的知识合并、讲义提交、卡片与链接处理、打包命令。聊天输入保留 DSH Session 发送与附件流程。没有原生游标的旧课程继续原有路径；右侧状态条优先显示原生状态。教学内容和语义复核仍由模型编写，宿主执行阶段校验。迁移路径尚未进行真实 API 端到端验收。

<a id="teaching-templates"></a>

## 教学模板

`guide subject-routing` 说明选择和继承，`guide teaching-catalog` 列出 22 类学科、通用回退、9 个活动模块和 4 个目标模式。写作者依据可靠资料和已确认需求，将选择保存为独立的 `_工作区/教学设计.json`。`run-step teaching-resolve` 返回默认或可选 `lesson` 的组合及资源路径、哈希；Studio 适配器从真实章节和知识索引校验全部覆盖，调用者不能自填知识 ID。`teaching-validate` 要求显式配置，原生知识与路径阶段也执行此检查；旧台账直接调用原脚本时仍保留无配置回退。

讲义 manifest 带 `teaching_design`，卡片计划带 `teaching_designs`。输入快照记录有效选择和选中资源哈希，不含安装路径；修改选中资源会使受影响的讲义和卡片过期，未选学科及其他章节的选择不会单独使本章过期。写作输入改变后须复核并重新生成、提交受影响产物，不能删除凭证绕过新鲜度检查。实验有界流水线收到局部模板副本，但默认不开启。模板校验不证明教学质量。

四个共用模板位于 `apps/desktop/resources/workflows/better-learning/assets/templates`；学科、活动和目标模式文件在 `subjects/catalog.json` 登记。维护后用随包 Python 运行 `templates.py check` 和 `apps/desktop-host/tests/python` 的离线测试。运行时只读应用内置资源，不依赖原 skill 目录或全局安装；配置格式见[学科路由](../desktop/resources/workflows/better-learning/references/subject-routing.md)。

<a id="teaching-units"></a>

## 教学单元

`guide teaching-granularity` 说明如何按目标组合知识记录，并选择提醒、标准、深入或拓展深度。新课程在知识与路径编排后、`lesson-prepare` 前保存 `_工作区/教学单元.json`；学科选择仍放 `教学设计.json`。`run-step units-resolve` 必须带 `lesson`；`units-validate` 从已保存的知识归属校验全部章节。原生路径校验拒绝无效单元。未配置章在 `legacy_lessons` 中明确报告，保留一 K 一 section，不改写旧正文。显式单元要求 v2 课程身份。

讲义 manifest 和卡片计划传递 `teaching_units`。一个 section 可覆盖多个 K，每个 K 在 `knowledge_headings` 登记互不重叠的真实标题，装配仍保留独立 TEACH 身份。练习使用当前 section 的独占预留 ID 和真实题目/反馈标题。提交要求 `unit_reviews` 把全部计划目标映射到实际练习，记录必要推理、删减复核和限制。恢复时已完成 checkpoint 的标题映射受保护。单元变化使受影响讲义与卡片输入过期，`refresh` 不能代替 prepare 和 commit。分组、深度与停止依据不新增固定篇幅或题量要求。机械检查不证明答案正确或学生已掌握；详见[单元规范](../desktop/resources/workflows/better-learning/references/teaching-granularity.md)。
