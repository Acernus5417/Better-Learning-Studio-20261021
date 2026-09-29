---
description: "Better Learning Studio Desktop Host workflow control, validation, recovery, and visual dispatch."
kind: "package-reference"
---

# Better Learning Studio Host workflow

English | [中文](README.zh.md)

With `BLS_WORKFLOW_ROOT` configured, the Desktop Host exposes authenticated `POST /api/better-learning/workflow` and the model-facing `course_workflow` tool. Both share one durable `_工作区/内置工作流.json` cursor. A course must be a registered workspace root or a direct child; real paths are checked. The HTTP route supports `inspect`, `initialize`, `confirm`, `change-model`, `start`, `complete-stage`, `pause`, `reconcile`, `resume`, and `watchdog`. The model tool additionally supports `guide`, `propose`, `probe`, and `transcribe-batch`.

`initialize` runs the bundled plan validator before creating the cursor. The model saves an intake summary with `propose`, then `confirm` requires a direct human message in a later turn. `guide` reads a named policy section or template from the bundled application workflow. The selected model is taken from the live Session request. Each stage advances only after Host verification of saved artifacts and script receipts. A model change invalidates transcription and downstream evidence. Ordinary `inspect` is read-only; startup scan and explicit `reconcile` mark interrupted work `needs_review`.

`probe` starts a fresh DSH child with image and write tools, lets it read a random challenge, then checks the saved response. The parent never reads the image or expected answer. Failure pauses the course. `transcribe-batch` reserves a whole batch, creates isolated children, records their real IDs, and collects only after their terminal results. The Host watchdog checks the ledger on a timer and on `subagent/end`, persists anomalies, and sends one reminder per unchanged silent set. Explicit `resume` checks the current Host roster: a live bound child blocks recovery; stopped registered attempts are collected and unregistered reservations are released before the cursor becomes ready.

The dedicated Agent preset reads application policy through `guide`; skill loading is disabled. `run-step` executes whitelisted knowledge assembly, lesson commits, card/link operations, and packaging only in their matching stages. The composer retains DSH Session admission and attachments. Existing courses without a native cursor remain on the legacy path. The right sidebar prefers native status when present. Teaching content and semantic review remain model-authored, with Host stage validation. A real API-backed end-to-end test of this migrated path is still pending.
