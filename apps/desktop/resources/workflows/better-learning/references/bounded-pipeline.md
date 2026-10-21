# 有界生成接入（实验性 bounded-v1）

本模式在原有七阶段、JSONL、稳定 BL ID、parts-v1 和最终打包流程上增加独立审查。只有课程配置 `execution_profile=bounded-v1` 才启用；已有课程不会自动迁移或补造审核。先用 `bounded_pipeline.py --course COURSE enable`，再重新 `lesson_tasks.py prepare`。有活动写作者或已打包时拒绝启用。

所有模式都保留**整批派发、整批收口、批内不补位**。本模块不替换 `attempt_tasks.py` 的批次调度器。讲义仍按学习顺序逐讲提交；有界任务是本讲内的知识项/教学子节，不能把全章 manifest 当成 worker 输入。

## 规范和完整输入

调度器先读 [运行时契约](bounded-runtime.md) 和 [完整知识检索](knowledge-store.md)。完整原文和知识正文保存在文件中，SQLite 检索索引可重建；不通过截断、标题代正文或有损摘要降低输入。调用和会话累计预算目前用 UTF-8 字节记账，并非实际模型 token 测量。超限必须细分语义单元或换真实新会话，不能忽略超限文件。

宿主适配器负责真正创建独立执行体、限制其工具与输入、提供真实启动/终止事件和实际上下文用量；当前 Python 运行时只验证受信适配器提供的回执及哈希，没有宿主执行器或签名认证。写作者与评审者身份不同，评审必须通过运行时完整读取输入、候选、适用规范与模板，保存逐项 findings。写作者不得自行签发宿主或审核回执。

## 逐讲过程

1. `lesson_tasks.py prepare` 生成各节 `bounded/Sxxx/unit.json` 与局部完整知识、前置、需求、路径片段、对应来源单元的完整转写正文和出处/版本，以及 `writer-contract.json` 中的许可链接、引用目标、练习 ID 和输出契约。这些派生输入在讲义台账保存哈希，不能在派发前自行改写契约以绕过原始证据。总 `task.json` 只给调度器使用；局部 worker 使用分配的 writer-contract。章首和章末需要本讲全部相关知识，若超限必须进一步细分，不能只读目标后编造练习。
2. 填写 `bounded/blueprint.json` 的教学目标、练习计划、知识顺序、接口；它初始为 `needs_planning`，不得机械改成 complete。使用 `stage=path` 的独立写作/审查任务确认后才可写节。规划输入由 `bounded_pipeline.planning_inputs(course, row)` 提供，必须全部绑定；蓝图审核仅有相同 stage 而未读取这些输入不能放行。
3. 调度器运行 `bounded_pipeline.py --course COURSE section-task --lesson L-ID --section Sxxx --session SESSION --task TASK`。运行时绑定完整局部输入、当前规范、模板和输出契约；按 `bounded-runtime.md` 的 claim/read/submit/review 流程落候选。只读本任务分配输入，只写候选；不运行 shell、联网、派生或修改共享索引。
4. 各候选通过 `stage=lesson` 独立审核；按原 parts-v1 填 result 和练习元数据。每对相邻节还需 `bounded/reviews/Sxxx-Syyy.json`；整讲需要 `bounded/reviews/goals.json`。报告包含 lesson_id、scope、input_hash、精确 chunk_hashes、status=passed、issues，且由 `stage=quality` 任务独立审核，输入必须实际包含相应片段及蓝图。局部审核不能代替这些整讲和接口审核。
5. `lesson_tasks.py commit` 保留原结构和链接门禁，再核验上述所有审核。每节 proof 必须绑定本节完整输入、局部计划和 unit.json，以及精确的 lesson/section/input_hash/output_contract；只有 stage 相同不能替代。正式讲义、练习索引、讲义台账、章节索引、生成进度、质量回执、实际正文衔接记录在同一事务写入；失败则回滚。衔接记录只指向实际 TEACH/EX 正文及其哈希，不将蓝图冒充已讲结论。

整讲 goals 输入过大时当前实现会拒绝，并没有自动分层归并审核。不得减少审核范围来放行；这仍是大规模验收前的实现缺口。

## 其他阶段与关系

知识、路径和卡片可通过 `Runtime.create_task` 的对应 stage 创建有界候选。转写文本审核用 transcription；二进制视觉证据仍需专用宿主适配，当前运行时不能接收图片。候选审核后，正式文件与候选语义内容相同才可用 `quality_gates.py accept --target ... --candidate ...` 留存证明。多个候选按无损顺序装配时用 `accept-chunks --manifest ...`；manifest 含 candidates 数组及 separator。此命令仅证明各片段审核及精确装配，不证明全局教学连续性。

`semantic_relations.py discover` 只产生 pending 候选，显式依赖及已有 JSONL 关系不能自动变成 confirmed。术语/能力定义与关系决定要绑定证据范围和版本并经独立审核；decide 以事务更新权威知识 JSONL 与决策台账。audit 检查待审/冲突、证据失效、无环性与正反向遗漏；未发现的关系仍是未知。impact 输出变更影响面；evaluate 只计算用户提供且有来源说明的人工标注样本，不生成或冒充人工标签。

卡片继续沿用 prepare、finalize、rebuild、check 顺序；finalize 前需要 cards 阶段的留存审核。知识正文、路径、讲义、卡片及转写的阶段证明不得互换。

## 最终核验与限制

`quality_gates.py check` 把完整问题写入 `_工作区/质量门禁报告.json`，仅返回短状态和路径。`validate_package --mode final/packaged` 在原门禁之外核验保留证据和关系审计。使用原有 `package → validate_package --mode packaged` 完成交付，不另建绕行出口。

证据保存在 `_工作区/质量证据/`，绑定运行时已批准任务、原始输入、候选、review、宿主及停止回执。打包清理的暂存输入可用归档证据核验；仍保留的输入变化、审核撤销、策略/模板/验证器变化或正文变化都必须重新审查。`_工作区/bounded-runtime/` 和质量证据不能随暂存目录清理。纯 canonical 链接路径搬迁可沿用原证明，链接标签或正文变化不可。

该接入仍是实验性：未证明真实宿主完整上下文有界；没有真实百万字教材端到端和人工标注质量基准；整体超限审核、全局关系召回及所有阶段的自动调度尚未完成。旧模式保持兼容，但不因此具备 O(1) 会话上下文保证。测试中 fixture 宿主回执只能证明程序机制，不能证明真实模型隔离或教学正确性。

## 教学单元局部输入

显式配置教学单元时，一个 knowledge section 的局部输入包含该单元全部 K、完整相关来源证据及前置，`teaching-units.json` 与局部粒度策略传递目标、深度、标准和停止依据；选中的学科模板仍在 teaching-design.json。writer-contract.reserved_exercises 为本 section 独占 ID，不与其他 section 共用；实际任务和反馈可放本单元，不限 closing。超过上下文预算先调整语义分组/证据任务，不截断必要知识。最终 result.unit_reviews 由整讲协调收口检查，局部审核通过不能代替整讲目标与衔接复核。
