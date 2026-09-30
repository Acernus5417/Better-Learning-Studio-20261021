---
description: "Better Learning Studio 桌面宿主的工作流控制、校验、恢复和视觉派发。"
kind: "package-reference"
---

# Better Learning Studio 宿主工作流

[English](README.md) | 中文

设置 `BLS_WORKFLOW_ROOT` 后，桌面宿主提供已认证的 `POST /api/better-learning/workflow` 和模型可调用的 `course_workflow` 工具。二者共享持久化的 `_工作区/内置工作流.json` 游标。课程必须是已登记工作区根目录或直接子目录，并核对真实路径。HTTP 接口支持 `inspect`、`initialize`、`change-model`、`start`、`complete-stage`、`pause`、`reconcile`、`resume`、`watchdog`；intake 的 `confirm` 留在模型工具，以校验已保存的摘要和更晚的真实用户回合，桌面端目前没有独立的确认控件。模型工具另外支持 `guide`、`create-course`、`propose`、`probe`、`transcribe-batch` 和按阶段限制的机械动作。`create-course` 要求工作区根会话的真实用户回合，在计划初始化前创建一个新的直接子目录。

Web 监听端口默认为 19387；隔离桌面实例可用 `BLS_WEB_PORT` 指定其他有效 TCP 端口。

`initialize` 在建立游标前运行随包计划校验。模型用 `propose` 保存需求摘要，`confirm` 要求下一轮真实用户消息。`guide` 按名称读取随应用发布的阶段规范或模板。模型名称来自当前 Session 请求。每个阶段只有经过宿主对实际产物和脚本收据的校验才可前进。切换模型会使转写和后续凭证失效。普通 `inspect` 只读；启动扫描和显式 `reconcile` 才把中断状态改为 `needs_review`。

`probe` 新建具有读图和写入工具的 DSH 子代理读取随机测试图，再校验落盘答案；主代理不读取图片或预期答案。探针失败会暂停课程。`transcribe-batch` 整批预约，创建独立子代理，登记真实 ID，并仅在其真实终止后收集结果。宿主看门狗按时及收到 `subagent/end` 后检查台账，保存异常，对未变化的静默尝试只提醒一次。显式 `resume` 核对当前宿主成员：仍运行的成员会阻止恢复；已停止的登记尝试先收集，未登记预约先释放，然后游标才变为就绪。

专用 Agent 预设通过 `guide` 读取应用策略，skill 加载已关闭。`run-step` 只在匹配阶段执行白名单内的知识合并、讲义提交、卡片与链接处理、打包命令。聊天输入保留 DSH Session 发送与附件流程。没有原生游标的旧课程继续原有路径；右侧状态条优先显示原生状态。教学内容和语义复核仍由模型编写，宿主执行阶段校验。迁移路径尚未进行真实 API 端到端验收。
