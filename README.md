# Better Learning Studio

English | [中文](README.zh.md)

Better Learning Studio is a desktop workspace for building and studying courses. Create a course from learning materials or import a Markdown course folder, then read and edit lessons, explore links between documents, and save notes. The learning assistant can explain a selected passage in context and present interactive SVG diagrams and step-by-step demonstrations in the conversation.

## Developer handoff

Use Windows x64, Git 2.26 or later, Node.js 24 x64, and pnpm 11.28.5. Clone the Studio development branch from PowerShell.

```powershell
git clone --branch codex/basic-course-workbench https://github.com/Acernus5417/Better-Learning-Studio-20261021.git better-learning-studio
cd better-learning-studio
```

If you received a source folder, open PowerShell in its root, where `package.json`, `pnpm-lock.yaml`, and `start.bat` are located. Install dependencies in your own checkout. Share any sample course separately so your teammate can open it with **Import course**.

## Quick start on Windows

From the repository root, install the locked dependencies and launch the first build.

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-studio.ps1
```

The first launch builds Studio and may download Electron and other runtime components. When the Studio window opens, create or import a course. Configure a model provider before using AI course generation or the learning assistant.

After a successful build, double-click [`start.bat`](start.bat) for daily use. It starts the existing build. After changing application source, rerun `start-studio.ps1` to rebuild. Startup logs are in `.desktop-cache/startup-*.log`.

## Where to continue

- [`apps/desktop`](apps/desktop) owns the desktop shell and bundled [learning skills](apps/desktop/resources/skills).
- [`apps/desktop-host`](apps/desktop-host) owns the local course API and learning assistant tools.
- [`packages/client/ui-workspace`](packages/client/ui-workspace) owns the course workbench UI.
- See the [course workbench guide](docs/studio-course-workbench.md), [development guide](docs/development.md), and [contribution guide](CONTRIBUTING.md).

Windows stores courses under `Documents/Better Learning Studio/course` and the launcher's model configuration and conversation data under `%APPDATA%\BetterLearningStudio-DSH\dsh`. Each teammate configures their own credentials.

<a id="run"></a>

## DeepSeek Harness Web UI

Studio is built on DeepSeek Harness. See the [safety notice](SAFETY.md) and [Web UI guide](docs/user/guide/index.md) for the underlying Harness.

<a id="run-from-source"></a>

To build and start the Harness Web UI from this checkout, use `pnpm run dev:web` after installing dependencies.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
