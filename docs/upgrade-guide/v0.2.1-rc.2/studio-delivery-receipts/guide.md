---
kind: upgrade-guide
description: Studio delivery validation replaces whole-package hash snapshots with metadata receipts.
---

# Upgrade Studio delivery receipts

## Change

Studio packaging reuses accepted final content review, checks file inventory and change metadata, audits relocated links once, and refreshes fingerprints only for changed artifacts. It no longer hashes every delivered file or repeats full content validation after cleanup. Earlier source and semantic checks remain active. This detects ordinary changes rather than providing a cryptographic integrity certificate.

## Migration

1. Keep course documents and retained review records.
2. For an active course with a version 1 final snapshot, run the existing delivery final-check step once before package.
3. For an already packaged course with accepted 打包检查.json and 打包回执.json, the next packaged check upgrades an unchanged package without removed intermediates. The old snapshot is retained as _工作区/链接校验报告.v1.json. Files newer than the accepted report prevent this upgrade.
4. Confirm _工作区/打包检查.json reports passed: true and integrity: metadata-v1. Source edits require renewed content acceptance.

