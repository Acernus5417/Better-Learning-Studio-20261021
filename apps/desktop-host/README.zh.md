---
description: "Better Learning Studio 桌面宿主的课程控制、校验、恢复和转写看门狗。"
kind: "package-reference"
---

# Better Learning Studio 宿主工作流

[English](README.md) | 中文

设置 `BLS_SKILL_ROOT` 后，桌面宿主通过 Connection 已认证的 `/api` 传输注册 `POST /api/better-learning/workflow`。请求用 `workspaceId` 指向已登记工作区；课程位于工作区根目录时 `course` 为 `"."`，位于其直接子目录时填写该目录名。宿主解析真实路径并拒绝工作区外目录。接口接受 `inspect`、`initialize`、`confirm`、`change-model`、`start`、`complete-stage`、`pause`、`reconcile`、`resume` 与 `watchdog` 操作。`confirm` 和 `change-model` 需要 `model`；`pause` 需要 `reason`。

`initialize` 先运行随包的 `validate_package.py --mode plan`，再写入 `_工作区/内置工作流.json`。新课程的 plan 通常会阻断写作；接口返回清单和游标，不因此允许写交付物。用户确认学习需求后，宿主先通过 `convert_materials.py progress` 更新旧版 `_工作区/生成进度.json`，再推进原生游标。阶段推进依赖随包校验器和来源哈希，最终阶段重新运行 `--mode packaged`。宿主启动时查找已登记工作区根目录及直接子目录中的原生游标，在应用开始服务前对它们执行恢复核对。重启后的运行中阶段进入 `needs_review`，只有明确执行 `resume` 才恢复到 `ready`。切换模型会使转写探针及后续阶段校验失效。

原生转写运行时，宿主看门狗每 90 秒以及收到 DSH `subagent/end` 事件时检查持久转写台账。`BLS_WATCHDOG_INTERVAL_MS` 和 `BLS_WATCHDOG_SILENT_MS` 可配置检查间隔与无进展阈值，默认分别为 90 秒和 15 分钟。它把台账中的 `host_agent_id` 与当前 Agent 列表对应，将无进展、已停止和未知的尝试 ID 写入 `_工作区/内置看门狗.json`；转写完成或暂停时停止定时器。看门狗不会收集尝试、释放脚本租约或新建替代成员。宿主重启后，缺席的子代理只标为未知。定时器仅在宿主运行期间工作。

当前 Agent 预设仍加载 better-learning skill，由它派发视觉子代理并编写讲义。聊天输入区尚未调用此接口；没有 `_工作区/内置工作流.json` 的旧课程继续原有路径。右侧状态条有原生游标时优先显示其状态，旧课程继续使用旧进度和 packaged 收据。该控制器尚不生成课程内容、派发或收集视觉成员，也不执行语义复核；这些操作仍由 skill 负责。
