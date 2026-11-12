---
kind: upgrade-guide
description: Native Studio lesson commits and card finalization require logged semantic presentation processing.
---

# Upgrade Studio semantic presentation

English | [中文](guide.zh.md)

## Change

New native courses record per-unit presentation decisions before completing the lesson/card stages. The Host uses the selected model for a bounded annotation plan and independent review, normally two requests per complete group with at most one repair round. Direct Python commit/finalize commands remain content validators and do not provide the new presentation decisions. Markdown content and existing content fingerprints remain unchanged; optional portable metadata lives in `.betterlearning/presentation/`.

## Migration

1. Keep completed and imported courses as they are. Existing stage signatures remain valid and no automatic paid reformatting occurs.
2. Generate new courses through `course_workflow run-step lesson-commit` and `cards-finalize` in the live generation Session. Do not replace these calls with direct Python commands or a Session-less HTTP request.
3. Retain `.betterlearning/presentation/` when copying a styled course. Without it, Markdown remains fully readable with basic formatting. Only Studio applies the source-bound emphasis and card disclosures.
4. Inspect the existing tool details for `presentation.passed` and `presentation.basic`. Basic results retain validated content and are not reported as successful semantic styling; repeating the same step retries only basic units and reuses accepted units. Cancellation does not mark a job complete. Edited teaching text invalidates its old decorations.
