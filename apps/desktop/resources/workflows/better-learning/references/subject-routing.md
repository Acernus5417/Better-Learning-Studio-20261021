# 学科模板选择与组合

本体系按教学任务分类，用于覆盖常见课程并允许扩展，不声称与某一种官方学科目录逐项对应。目录见 [模板目录](../assets/templates/subjects/catalog.json)。只读目录及本次选中的文件，禁止预先加载全部学科模板。

## 四层职责

1. **共用骨架**：knowledge-chapter / learning-path / learning-chapter / core-card 保留来源、稳定身份、知识覆盖、练习、反馈与复习闭环。
2. **学科模板**：决定什么算核心知识、怎样解释、使用什么证据和怎样判定掌握。通常一个主学科，必要时再选一至两个辅学科。
3. **活动模块**：证明、定量建模、实验、编程、数据分析、案例决策、文本史料、技能表现、设计项目；只选该章真正需要的模块。建议不超过三个，复杂任务可据实增加。
4. **目标模式**：理解、应试、实践、研究之一；模式改变练习与时间分配，不删去来源知识和必要条件。

共同规范决定“必须交付哪些能力与证据”，学科模板决定“如何教、用何种任务验收”。教学功能在单元/章级统筹，可以合并、改名与换序，不逐 K 重复整套；不要求所有学科照抄公式、推导、数值题等标题。开放任务用示范作品、论证、操作或决策代替数值例题，独立参考答案用评价量规和多种可接受方案实现。

教学深度和分组另见 [教学单元规范](teaching-granularity.md)：学科决定教什么、凭什么判断，单元决定围绕哪个任务讲、何时停止。不要把学科模板列出的所有示范和误区当作逐知识的必填项。

## 选择步骤

- 需求阶段只记课程名、目标、水平和已知考核方式，学科判断可暂定；不能从文件名推断未读教材内容。
- 完成转写后，按当前章阅读可靠文本，识别主要知识对象、证据形式、目标产出和典型错误。知识整理阶段先使用匹配学科模板的“知识提取”要求；最终编排前依据已核实知识库确定组合。
- 以学习者最终要做什么选择主学科，而非只匹配课程名。例如“生物统计”以数据推断为主选 statistics，生命解释为辅选 life-science；“医学伦理”以论证为主选 philosophy，临床情境为辅选 medicine。
- 在 `_工作区/教学设计.json` 保存选择，在 `学习需求.md` 说明主要讲解方式，在 `学习路径.md` 写每章学习产出与过关证据。既有课程无配置时继续使用共用模板并标为兼容回退；新课程应完成选择，不能把回退当作已适配。
- 整门课的默认选择不足以表达各章差异时，使用 lesson override；某个知识小节确有不同任务时，使用该章的 knowledge_overrides。列表字段在覆盖时替换，未写的字段继承；空列表表示明确移除，不做隐式追加。
- 用户明确指定的讲解方式优先。目标不清时依据资料作暂定选择并记录理由；只对会改变学习产出的问题澄清，不要求用户熟悉模板 ID。
- level 用于调整术语密度、先修回顾、形式化程度和支架，不能只写一个水平标签：入门多用具体示例与小步反馈，本科逐步建立完整方法和条件，进阶增加推导、文献比较及开放问题。以已确认基础为准，不因年级自动假定掌握；应试或研究模式都不能跳过必要前置。
- 未匹配课程按最接近的知识与证据形式组合；仍不适用时用 generic，并写明缺少的任务类型与补充规则。模板是解释结构，不能充当教材事实来源。

## 记录与调用

示例为格式和组合用法，不代表已核查某一课程材料：

```json
{
  "schema_version": 1,
  "default": {
    "subject": "statistics",
    "secondary_subjects": ["life-science"],
    "modules": ["data-analysis"],
    "mode": "understanding",
    "level": "本科入门",
    "reason": "核心目标是解释样本证据并完成推断"
  },
  "lessons": {
    "L-02": {
      "modules": ["quantitative", "proof"],
      "reason": "本章建立估计量性质",
      "knowledge_overrides": {
        "K-02": {"modules": ["data-analysis"], "reason": "本节用数据诊断假设"}
      }
    }
  }
}
```

ID 必须来自现有索引。知识整理早期尚无 L/K ID 时只填 default，编排后再加覆盖。支持字段仅为 subject、secondary_subjects、modules、mode、level、reason 及章级 knowledge_overrides；未知字段和未知模板 ID 报错，避免拼写错误导致静默回退。

```text
python <scriptsRoot>/teaching_design.py catalog
python <scriptsRoot>/teaching_design.py resolve --course COURSE --lesson L-02 --knowledge K-01 K-02
python <scriptsRoot>/teaching_design.py check
```

`resolve` 是只读解析，不按关键词猜学科、不自动写配置。`check` 验证模板资源、路径和目录一致性，不验证课程事实或实际教学效果。选择由写作者依据可靠资料完成。

Better Learning Studio 原生工作流用 `course_workflow guide subject-routing` 和 `guide teaching-catalog` 阅读说明与目录。知识、路径、讲义、卡片阶段运行中可调用 `run-step teaching-resolve`（可带 `lesson`）和 `run-step teaching-validate`。宿主从保存的索引提取真实知识归属，检查全部章节覆盖，不接受模型自填 `--knowledge` 来绕过归属校验。原生知识与路径阶段要求显式配置；旧台账脚本仍保留兼容回退。修改教学设计后先复核受影响内容，再运行阶段检查。

讲义 prepare 把解析后的章级组合、知识小节覆盖、选中模板路径与哈希放入 `manifest.teaching_design`。写作者先读共用章模板，再只读这些选中模板；知识小节采用其局部组合，intro/closing 采用章级组合。默认与 bounded-v1 均传递相同教学设计；有界任务将所选模板复制为自己的局部输入。

快照记录有效选择与选中资源哈希。改动本章选择或所选模板会使本章及依赖它的卡片过期；修改未选学科或其他章节的选择不应使本章过期。修改后先更新知识整理与路径（有实质内容变化时），再重新 prepare/commit 受影响讲义，最后重新整理卡片。不要直接改已装配的系统标记。

## 冲突与验收

用户要求优先，其次是共用流程中的来源、覆盖、身份和交付契约；学科模板决定解释和任务的适配，活动模块补齐方法，模式只调整练习重点。冲突时保留所需的能力证据，不把多个学科模板全文拼接成重复章节。

每章只形成一套讲解主线、术语表、任务和评价标准。辅助模板只补充主模板没有覆盖的证据或方法。例如经济学案例先解释模型假设，再分析政策影响，不连续复制“数学章”与“社会学章”。

在质量报告记录实际选择、选择理由、目标—教学任务—练习/作品—判定标准的对应关系，以及模板要求中不适用的部分。机器快照通过只证明调用和版本有效；需另复核学科证据、讲解方式与目标是否匹配。

## 典型路由参考

| 课程或章节 | 主 / 辅学科 | 活动模块 | 应看到的学习证据 |
| --- | --- | --- | --- |
| 复变函数 | mathematics | proof、quantitative | 条件辨认、论证、变式计算 |
| 大学物理实验 | physics | lab、data-analysis | 原始数据、误差解释、实验结论 |
| 有机化学 | chemistry | quantitative（涉及计算时） | 结构判断、机理与条件、竞争路径 |
| 数据结构 | computing | code、proof（正确性章） | 跟踪执行、边界输入、复杂度理由 |
| 机器学习 | computing / statistics | data-analysis、code | 基线、数据划分、误差与泛化判断 |
| 信号与系统 | engineering / mathematics | quantitative、design-project | 模型条件、系统响应、性能验证 |
| 中国近代史 | history | text-evidence | 史料定位、互证、因果解释与反证 |
| 英语写作 | languages / literature | performance、text-evidence | 初稿、反馈、修订与新情境表达 |
| 民法案例分析 | law | case-decision、text-evidence | 争点、规则、涵摄、不同结论条件 |
| 临床护理 | medicine | case-decision、performance | 优先级判断、操作检查与升级条件 |
| 教学设计 | education | design-project、performance | 目标、活动、评价对齐及改课证据 |
| 环境规划 | earth-science / engineering | data-analysis、design-project | 时空证据、方案约束、验证与取舍 |
| 农业生态 | agriculture / life-science | lab、data-analysis | 田间条件、变量、对照与外推边界 |
| 音乐表演 | arts | performance | 技术与表达维度、练习记录、作品 |
| 研究方法 | sociology / statistics（依研究问题调整） | text-evidence、data-analysis | 可检验问题、设计、证据限制 |

表内组合是选择示例，不能覆盖或替代对实际材料和课程目标的判断。

## 扩展新学科

优先尝试现有主/辅学科和活动的组合。只有出现独立的知识组织、解释与证据要求时才新增学科文件；文件需包含选择边界、知识提取与路径、小节讲解结构、卡片与评价、一个教学示例。在 catalog.json 登记稳定 ID、名称与相对路径，然后运行 check。新增模板不改变旧 ID，也不自动成为既有课程的选择。
