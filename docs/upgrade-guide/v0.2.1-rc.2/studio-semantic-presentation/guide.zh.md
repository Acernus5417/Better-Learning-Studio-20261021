---
kind: upgrade-guide
description: 原生 Studio 的讲义提交和卡片定稿需要有日志的语义排版步骤。
---

# 升级 Studio 语义排版

[English](guide.md) | 中文

## 变更

新原生课程在讲义及卡片阶段完成前记录逐单元排版结论。宿主使用当前模型完成有界标注规划和独立审核，通常每个完整分组两次请求，最多一轮修复。直接运行 Python commit/finalize 仍只负责内容验收，不能提供新的排版结论。Markdown 内容和既有内容指纹不变，可选的便携清单保存在 `.betterlearning/presentation/`。

## 迁移

1. 保持已完成和导入课程原样。既有阶段签名仍然有效，不自动收费重排。
2. 新课程在实际生成 Session 中使用 `course_workflow run-step lesson-commit` 和 `cards-finalize`，不要改为直接运行 Python 或没有 Session 的 HTTP 请求。
3. 复制美化课程时保留 `.betterlearning/presentation/`。没有清单时 Markdown 仍可用基础样式完整阅读；原文绑定的强调和卡片折叠由 Studio 应用。
4. 在现有工具详情中查看 `presentation.passed` 和 `presentation.basic`。基础排版保留已通过内容检查的正文，不能称为语义美化成功；重复相同步骤仅重试基础排版单元，并复用通过结果。取消不标为完成；教学正文编辑后旧装饰失效。
