---
description: "Better Learning Studio Desktop Host course control, validation, recovery, and transcription watchdog."
kind: "package-reference"
---

# Better Learning Studio Host workflow

English | [中文](README.zh.md)

When `BLS_SKILL_ROOT` is configured, the Desktop Host registers `POST /api/better-learning/workflow` through Connection's authenticated `/api` transport. Requests identify an existing registered workspace by `workspaceId` and a course at its root (`course: "."`) or in one direct child directory (`course: "name"`). The Host resolves the real path and rejects directories outside that workspace. The endpoint accepts `inspect`, `initialize`, `confirm`, `change-model`, `start`, `complete-stage`, `pause`, `reconcile`, `resume`, and `watchdog` actions. `confirm` and `change-model` require `model`; `pause` requires `reason`.

`initialize` runs the bundled `validate_package.py --mode plan` before writing `_工作区/内置工作流.json`. A blocking plan is expected for a new course and is returned with the cursor; it does not authorize writing deliverables. User intake confirmation updates the existing `_工作区/生成进度.json` through `convert_materials.py progress` before the native cursor advances. Stage advancement uses the bundled validators and source hashes, and the final stage reruns `--mode packaged`. On startup, the Host finds saved cursors at registered workspace roots and their direct children and reconciles them before serving the application. A running stage becomes `needs_review` after restart; only an explicit `resume` moves it back to `ready`. A changed model invalidates the transcription probe and downstream gates.

During native transcription, the Host's watchdog checks the durable attempt ledger every 90 seconds and on DSH `subagent/end`. `BLS_WATCHDOG_INTERVAL_MS` and `BLS_WATCHDOG_SILENT_MS` configure the check interval and silence threshold; defaults are 90 seconds and 15 minutes. It joins the ledger's `host_agent_id` with the live Agent roster, records silent, stopped, and unknown attempt IDs in `_工作区/内置看门狗.json`, and stops its timer when transcription completes or pauses. The watchdog does not collect attempts, release script leases, spawn replacement children, or claim that a missing child has stopped after a Host restart. Its timer operates while the Host is running.

The Agent preset loads the better-learning skill and dispatches visual subagents and writes lessons through that skill. The conversation composer does not call this API; existing courses without `_工作区/内置工作流.json` continue on their legacy path. The right sidebar prefers native status when the file exists and retains the legacy progress and packaged receipt for old courses. The controller does not yet generate course content, dispatch or collect visual children, or perform semantic review; the skill remains responsible for those operations.
