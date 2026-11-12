/** Shipped Studio presets must render their persona before requesting a model. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installCourseWorkflowApi } from '../../desktop-host/src/course-workflow-api.ts'
import { installCourseLibraryApi } from '../../desktop-host/src/course-library-api.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { chromium } from 'playwright'
import { newEnglishPage } from './support.ts'
import { CoursePresentationService } from '../../desktop-host/src/course-presentation.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const explainInstructions = '## 设计对话内演示'

const avlQuestion = 'AVL 树以 30 为根，右孩子是 40，40 的左孩子是 35、右孩子是 50。左旋时为什么 35 要换到 30 右侧？请演示。'
const avlLabels = ['旋转前 · 30 是根', '换接预览 · 35 将转到 30 右侧', '旋转后 · 40 是根'] as const

function avlDisplay() {
  type NodePosition = { id: number; parent: number | null; x: number; y: number }
  const before: NodePosition[] = [
    { id: 30, parent: null, x: 85, y: 38 },
    { id: 40, parent: 30, x: 222, y: 91 },
    { id: 35, parent: 40, x: 165, y: 151 },
    { id: 50, parent: 40, x: 283, y: 151 },
  ]
  const after: NodePosition[] = [
    { id: 40, parent: null, x: 185, y: 38 },
    { id: 30, parent: 40, x: 93, y: 98 },
    { id: 35, parent: 30, x: 132, y: 159 },
    { id: 50, parent: 40, x: 283, y: 98 },
  ]
  const frames = [before, before, after].map((nodes, index) => {
    const preview = index === 1
    const edges = nodes.flatMap(node => {
      if (node.parent === null) return []
      const parent = nodes.find(item => item.id === node.parent)!
      return [`<line id="edge-${parent.id}-${node.id}" x1="${parent.x}" y1="${parent.y}" x2="${node.x}" y2="${node.y}"/>`]
    }).join('')
    const objects = nodes.map(({ id, x, y }) => `<g id="node-${id}" transform="translate(${x} ${y})">
      <circle r="18" fill="${preview && id === 35 ? '#f59e0b' : '#dbeafe'}" stroke="#1e3a8a"/>
      <text y="5" text-anchor="middle" fill="#172554" font-size="14">${id}</text>
    </g>`).join('')
    const label = avlLabels[index]!
    const transfer = preview ? '<path d="M149 158 Q91 163 91 57" fill="none" stroke="#b45309" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#transfer-arrow)"/>' : ''
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 220" width="360" height="220">
      <title>${label}</title>
      <defs><marker id="transfer-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#b45309"/></marker></defs>
      <rect width="360" height="220" fill="white"/>
      <g id="connection-layer" stroke="#334155" stroke-width="2">${edges}</g>
      <g id="object-layer">${objects}</g>
      <g id="annotation-layer"><text x="180" y="204" text-anchor="middle" font-size="14">${label}</text></g>
      <g id="interaction-layer">${transfer}</g>
    </svg>`
    return { svg, label }
  })
  return { title: 'AVL 左旋', frames, controls: 'steps' }
}

class StudioRequestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  release: (() => void) | undefined
  citationReply: string | undefined
  semanticFixture = false

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'studio-model', name: 'studio-model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const lastUser = options.messages.findLastIndex(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && (block.text.includes(explainInstructions) || block.text.includes(avlQuestion))))
    const userText = options.messages[lastUser]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    const results = options.messages.slice(lastUser + 1).filter(message => message.role === 'tool')
    const isAvlDemo = userText.includes(avlQuestion)
    if ((isAvlDemo || userText.includes(explainInstructions)) && results.length < 3) {
      const id = ToolCallId('studio-study-' + results.length)
      const name = results.length < 2 ? 'study_skill' : 'study_show'
      const args = JSON.stringify(results.length === 0 ? {} : results.length === 1 ? { name: 'study-explain' } : isAvlDemo ? avlDisplay() : { title: 'Source positions', controls: 'playback', intervalMs: 1000, frames: [
        { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>', label: 'First visual' },
        { path: '附件/example-frame.png', label: 'Second visual' },
        { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><circle cx="12" cy="12" r="9"/></svg>', label: 'Third visual' },
      ] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const longReasoning = JSON.stringify(options.messages).includes('Composer expansion regression')
    if (longReasoning) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'A long reasoning paragraph for layout measurement.\n\n'.repeat(80) },
      }
    }
    const textIndex = longReasoning ? 1 : 0
    let semanticReply: string | undefined
    if (this.semanticFixture) {
      const prompt = options.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content)
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      const review = prompt.includes('任务：独立审核')
      const match = review ? /原文：(\{[\s\S]*?\})\n待审计划：/u.exec(prompt) : /资料：(\{[\s\S]*\})/u.exec(prompt)
      if (match !== null) {
        const data = JSON.parse(match[1]!) as { units: string[] }
        semanticReply = JSON.stringify(
          review
            ? {
              approved: [],
              units: data.units.map(unit => ({ unit, passed: true, reason: '原文内容明确，普通排版足够清楚' })),
              missing: [],
            }
            : { annotations: [], units: data.units.map(unit => ({ unit, reason: '没有需要额外强调的内容' })) },
        )
      }
    }
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    yield {
      type: 'block-end',
      index: textIndex,
      block: {
        type: 'text',
        text:
          semanticReply ??
          (isAvlDemo ? '35 大于 30、小于 40，所以它转到 30 的右侧。' : undefined) ??
          (JSON.stringify(options.messages).includes('Course citation regression')
            ? (this.citationReply ?? 'No citation fixture')
            : 'Studio model request accepted.'),
      },
    }
    if (longReasoning)
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('web e2e: Studio model request', { retry: 0 }, () => {
  let scaffold: WebScaffold
  let library: Awaited<ReturnType<typeof installCourseLibraryApi>>
  let studyRoot: string
  const adapter = new StudioRequestAdapter()

  beforeAll(async () => {
    studyRoot = await mkdtemp(join(tmpdir(), 'bls-study-skills-e2e-'))
    vi.stubEnv('BLS_COURSE_ROOT', join(studyRoot, 'course'))
    const resources = join(studyRoot, 'studio-resources', 'skills')
    vi.stubEnv('BLS_STUDY_SKILLS_ROOT', resources)
    const explain = join(resources, 'study-explain')
    await mkdir(explain, { recursive: true })
    await copyFile(new URL('../../desktop/resources/skills/study-explain/SKILL.md', import.meta.url), join(explain, 'SKILL.md'))
    const oldSkill = join(studyRoot, 'skills', 'study-quiz')
    await mkdir(oldSkill, { recursive: true })
    await writeFile(join(oldSkill, 'SKILL.md'), '---\nname: study-quiz\ndescription: Legacy Documents skill\n---\nLegacy quiz instructions\n')
    scaffold = await launchWebScaffold()
    await installCourseWorkflowApi(
      scaffold.ctx,
      join(scaffold.harnessHome, 'runtime-source'),
      join(scaffold.harnessHome, 'runtime-install'),
      fileURLToPath(new URL('../../desktop/resources/workflows/better-learning/scripts', import.meta.url)),
      { intervalMs: 90_000, silentMs: 900_000 },
    )
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['studio-prompt-test'], adapter))
    library = await installCourseLibraryApi(scaffold.ctx, join(studyRoot, 'course'))
  }, 120_000)

  afterAll(async () => {
    try { await scaffold?.close() }
    finally {
      vi.unstubAllEnvs()
      if (studyRoot !== undefined) await rm(studyRoot, { recursive: true, force: true })
    }
  })

  it.each([
    'better-learning',
    'better-learning-vision',
    'better-learning-probe',
    'better-learning-study',
    'better-learning-presentation',
  ])('sends a model request and saves its answer under %s', async (preset) => {
    const before = adapter.requests.length
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId(`studio-prompt-${preset}`),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: preset },
      agentOptions: { provider: 'studio-prompt-test', model: 'studio-model' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
    })
    try {
      const tools = scaffold.ctx.tools
        .schemas(handle.agent)
        .map(tool => tool.name)
        .sort()
      if (preset === 'better-learning-vision') expect(tools).toEqual(['edit', 'read', 'read_image', 'write'])
      else if (preset === 'better-learning-probe') expect(tools).toEqual(['read_image', 'write'])
      else if (preset === 'better-learning-study') expect(tools).toEqual(['course_read', 'study_show', 'study_skill', 'web_fetch', 'web_search'])
      else if (preset === 'better-learning-presentation') expect(tools).toEqual([])
      else expect(tools).toEqual(expect.arrayContaining(['course_workflow', 'read', 'write', 'edit']))
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'Reply briefly without using tools.' }],
          source: { kind: 'user' },
        }),
      )
      await handle.agent.whenIdle()
      const requests = adapter.requests.slice(before)
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      const system = request.messages
        .filter(message => message.role === 'system')
        .flatMap(message => message.content)
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      const user = request.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content)
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      expect(system).not.toContain('{{cwd}}')
      expect(user).toContain(`Current working directory: ${JSON.stringify(scaffold.workspaceCwd)}.`)
      if (preset === 'better-learning') expect(system).toContain('当前模型是 studio-model。')
      const events = handle.agent.session.snapshotEvents()
      expect(
        events.some(
          event =>
            event.type === 'assistant/message' && JSON.stringify(event.data).includes('Studio model request accepted.'),
        ),
      ).toBe(true)
      expect(
        events
          .filter(event => event.type === 'system/message')
          .some(event => JSON.stringify(event.data).includes('{{cwd}}')),
      ).toBe(false)
      expect({
        preset,
        tools,
        eventTypes: events.map(event => event.type),
        answer: 'Studio model request accepted.',
      }).toMatchSnapshot()
    } finally {
      await handle.dispose()
    }
  })

  it('logs independent tool-less presentation requests before content publication', async () => {
    const children: Agent[] = []
    const off = scaffold.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.agentPreset === 'better-learning-presentation') children.push(agent)
    })
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('semantic-presentation-parent'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'better-learning' },
      agentOptions: { provider: 'studio-prompt-test', model: 'studio-model' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'better-learning').then(() => undefined),
    })
    const course = join(scaffold.harnessHome, 'presentation-course')
    await mkdir(course)
    adapter.semanticFixture = true
    try {
      const source = '# 定义\n\n函数的输出是唯一的。\n'
      const before = adapter.requests.length
      const service = new CoursePresentationService(scaffold.ctx)
      const result = await service.publish(
        course,
        { kind: 'lesson', path: '讲义.md', text: source },
        handle.agent,
        new AbortController().signal,
        async () => {
          expect(adapter.requests.length - before).toBe(2)
          await writeFile(join(course, '讲义.md'), source)
          return { state: 'done', failure_kind: null }
        },
      )
      expect(children).toHaveLength(2)
      expect(result.presentation).toMatchObject({ passed: 1, basic: 0, annotations: 0 })
      const requests = adapter.requests.slice(before)
      expect(requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
      const logged = children.map(agent => agent.session.snapshotEvents())
      expect(
        logged.every(events =>
          events.some(
            event => event.type === 'user/message' && JSON.stringify(event.data).includes('函数的输出是唯一的。'),
          ),
        ),
      ).toBe(true)
      expect({
        toolCounts: requests.map(request => request.tools?.length ?? 0),
        childPresets: children.map(agent => agent.session.header.agentPreset),
        promptsLogged: logged.map(events =>
          events
            .filter(event => event.type === 'user/message')
            .some(event => JSON.stringify(event.data).includes('函数的输出是唯一的。')),
        ),
        content: await readFile(join(course, '讲义.md'), 'utf8'),
      }).toMatchSnapshot()
    } finally {
      adapter.semanticFixture = false
      off()
      await handle.dispose()
    }
  }, 120_000)

  it('renders a course graph with orphan files off and a fixed settings entry', async () => {
    const course = await library.create('Graph reading course')
    for (const path of ['学习文档/01-A.md', '学习文档/02-B.md', '学习文档/03-Orphan.md'])
      await library.createFile(course.id, path, false)
    const file = await library.read(course.id, '学习文档/01-A.md')
    await library.save(course.id, file.path, '# Graph source\n\n[[02-B|Next lesson]]', file.version)
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: course.name, exact: true }).click()
      await page.getByRole('button', { name: 'File graph', exact: true }).click()
      const graph = page.getByRole('region', { name: 'File graph', exact: true })
      await graph.getByText('2 nodes · 1 links', { exact: true }).waitFor()
      const tools = page.getByRole('toolbar', { name: 'Reading tools', exact: true })
      await tools.getByRole('button', { name: 'Graph settings', exact: true }).click()
      const panel = page.getByRole('dialog', { name: 'Graph settings', exact: true })
      await panel.waitFor()
      const headings = panel.getByRole('button', { expanded: false })
      expect(await headings.count()).toBe(5)
      expect(await panel.getByRole('switch').count()).toBe(0)
      for (const name of ['Filters', 'Color groups', 'Appearance', 'Forces'])
        await panel.getByRole('button', { name, exact: true }).click()
      expect(await panel.getByRole('slider', { name: 'Line thickness', exact: true }).inputValue()).toBe('0.1')
      expect(await panel.getByRole('slider', { name: 'Link attraction', exact: true }).inputValue()).toBe('0.4')
      const orphan = panel.getByRole('switch', { name: 'Orphan files', exact: true })
      expect(await orphan.getAttribute('aria-checked')).toBe('false')
      const close = await tools.getByRole('button', { name: 'Collapse right sidebar', exact: true }).boundingBox()
      const more = await tools.getByRole('button', { name: 'Graph settings', exact: true }).boundingBox()
      expect(close !== null && more !== null && Math.abs(close.x - more.x) < 2 && more.y > close.y).toBe(true)
      const viewport = page.viewportSize()
      await page.setViewportSize({ width: 1000, height: 650 })
      await expect
        .poll(async () => {
          const card = await panel.boundingBox(),
            trigger = await tools.getByRole('button', { name: 'Graph settings', exact: true }).boundingBox()
          return (
            card !== null && trigger !== null && card.y >= trigger.y + trigger.height + 5 && card.y + card.height <= 639
          )
        })
        .toBe(true)
      expect(
        await tools.getByRole('button', { name: 'Graph settings', exact: true }).evaluate((button) => {
          const r = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }),
      ).toBe(true)
      if (viewport !== null) await page.setViewportSize(viewport)
      expect({
        buttons: await tools
          .getByRole('button')
          .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
        orphan: await orphan.getAttribute('aria-checked'),
        rendered: await graph.locator('output').innerText(),
        switches: await panel
          .getByRole('switch')
          .evaluateAll(switches => switches.map(item => item.getAttribute('aria-label'))),
      }).toMatchSnapshot()
      await orphan.click()
      await graph.getByText('3 nodes · 1 links', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      await tools.getByRole('button', { name: 'Graph settings', exact: true }).click()
      expect(await panel.getByRole('button', { expanded: false }).count()).toBe(5)
      await page.keyboard.press('Escape')
      await tools.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
      const edit = await page.getByRole('button', { name: 'Edit', exact: true }).boundingBox()
      const refresh = await tools.getByRole('button', { name: 'Refresh', exact: true }).boundingBox()
      expect(edit !== null && refresh !== null && edit.x + edit.width + 10 <= refresh.x).toBe(true)
      await tools.getByRole('button', { name: 'Outline', exact: true }).click()
      expect(await page.locator('iframe[title="File graph"]').count()).toBe(0)
    } finally {
      await browser.close()
    }
  }, 120_000)

  it('quotes the second repeated passage in the browser and sends only this course to its separate tutor', async () => {
    const course = await library.create('Course A')
    const other = await library.create('Course B')
    await library.createFile(course.id, '学习文档/01-Complex numbers.md', false)
    const first = await library.read(course.id, '学习文档/01-Complex numbers.md')
    const source = '# Complex numbers\n\nRepeated passage.\n\nSecond: Repeated passage.\n'
    await library.save(course.id, first.path, source, first.version)
    await library.createFile(other.id, '学习文档/01-Other.md', false)
    const second = await library.read(other.id, '学习文档/01-Other.md')
    await library.save(other.id, second.path, 'OTHER COURSE SECRET', second.version)
    const generation = await library.session(course.id, 'generation')
    const learningSession = await library.session(course.id, 'learning')
    await scaffold.ctx.sessionController.selectModel({
      sessionId: learningSession.sessionId,
      provider: 'studio-prompt-test',
      model: 'studio-model',
    })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Course A', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Course A', exact: true }).click()
      await page.getByRole('heading', { name: 'Complex numbers', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open learning assistant', exact: true }).click()
      const composer = page.locator('[contenteditable="true"]:visible').last()
      await composer.fill('My unsent learning question')
      const before = adapter.requests.length
      const selectRepeatedPassage = () => page
        .locator('article p')
        .filter({ hasText: 'Second:' })
        .evaluate((element) => {
          const leaf = element.querySelector('[data-source-exact="true"]')
          const text = leaf?.firstChild
          if (text === null || text === undefined) throw new Error('Source leaf is unavailable')
          const start = text.textContent?.indexOf('Repeated passage.') ?? -1
          if (start < 0) throw new Error('Repeated source text is unavailable')
          const range = document.createRange()
          range.setStart(text, start)
          range.setEnd(text, start + 'Repeated passage.'.length)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
          element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        })
      await selectRepeatedPassage()
      const floating = page.getByRole('toolbar', { name: 'Selection learning actions', exact: true })
      const explain = floating.getByRole('button', { name: 'Explain', exact: true })
      await explain.waitFor()
      expect(await explain.isEnabled()).toBe(true)
      const box = await floating.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      const mediaDir = join(library.root, course.id, '附件')
      await mkdir(mediaDir, { recursive: true })
      await writeFile(join(mediaDir, 'example-frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      await floating.getByRole('button', { name: 'Quiz', exact: true }).click()
      await page.getByText(/study-quiz\/SKILL\.md/u).waitFor()
      expect(adapter.requests.length).toBe(before)
      await selectRepeatedPassage()
      await explain.click()
      await page.getByText('Studio model request accepted.', { exact: true }).waitFor()
      const learning = learningSession.sessionId
      expect(learning).not.toBe(generation.sessionId)
      expect(await composer.innerText()).toContain('My unsent learning question')
      expect(await page.getByRole('button', { name: 'Ask about selection', exact: true }).count()).toBe(0)
      const controls = page.getByRole('toolbar', { name: 'Reading tools', exact: true })
      const controlBox = await controls.boundingBox()
      await controls.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
      await controls.getByRole('button', { name: 'Expand right sidebar', exact: true }).waitFor()
      expect(await controls.boundingBox()).toEqual(controlBox)
      await controls.getByRole('button', { name: 'Expand right sidebar', exact: true }).click()
      await composer.waitFor()
      expect(await composer.innerText()).toContain('My unsent learning question')
      const editorBox = await composer.boundingBox()
      expect(editorBox!.y).toBeGreaterThan(600)
      const request = adapter.requests[before]
      if (request === undefined) throw new Error('The tutor did not request a model')
      const modelText = request.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content)
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      expect(modelText).toContain(`"courseId":"${course.id}"`)
      expect(modelText).toContain(`"start":${source.lastIndexOf('Repeated passage.')}`)
      expect(modelText).toContain('Repeated passage.')
      expect(modelText).toContain(explainInstructions)
      expect(modelText).not.toContain('OTHER COURSE SECRET')
      const agent = scaffold.ctx.agents.get(learning)
      if (agent === undefined) throw new Error('The tutor Agent is unavailable')
      expect(
        scaffold.ctx.tools
          .schemas(agent)
          .map(tool => tool.name)
          .sort(),
      ).toEqual(['course_read', 'study_show', 'study_skill', 'web_fetch', 'web_search'])
      const toolReplies = adapter.requests.slice(before).flatMap(request => request.messages
        .filter(message => message.role === 'tool').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      expect(toolReplies).toContainEqual(expect.stringContaining('讲清学习者当前的知识疑问'))
      expect(toolReplies.join('\n')).not.toContain('Legacy Documents skill')
      expect(toolReplies).toContainEqual(expect.stringContaining('<skill_content name="study-explain">'))
      expect(await page.locator('[data-conversation-scroll]').innerText()).not.toContain(explainInstructions)
      expect(await page.getByText('My unsent learning question', { exact: true }).count()).toBe(1)
      expect((await library.overview(course.id)).files.filter(file => file.path.startsWith('笔记/'))).toHaveLength(0)
      const note = page.getByRole('button', { name: 'Save to notes', exact: true })
      await note.waitFor()
      expect(await page.getByRole('button', { name: 'Good response', exact: true }).count()).toBe(0)
      const readerFont = await page
        .locator('article')
        .first()
        .evaluate((element) => {
          const s = getComputedStyle(element)
          return { font: s.fontFamily, size: s.fontSize, line: s.lineHeight }
        })
      const tutorFont = await page.getByText('Studio model request accepted.', { exact: true }).evaluate((element) => {
        const s = getComputedStyle(element)
        return { font: s.fontFamily, size: s.fontSize, line: s.lineHeight }
      })
      expect(tutorFont).toEqual(readerFont)
      await note.click()
      const dialog = page.getByRole('dialog', { name: 'Save to notes', exact: true })
      await dialog.getByRole('button', { name: 'Prepare preview', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Note content', exact: true }).fill('First reviewed note')
      await dialog.getByRole('button', { name: 'Append to notes', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      expect((await library.read(course.id, '笔记/01-Complex numbers-笔记.md')).text).toContain('First reviewed note')
      await note.click()
      await dialog.getByRole('button', { name: 'Multiple', exact: true }).click()
      await dialog.getByRole('button', { name: 'Prepare preview', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Note content', exact: true }).fill('Second reviewed note')
      await dialog.getByRole('button', { name: 'Append to notes', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      const noteText = (await library.read(course.id, '笔记/01-Complex numbers-笔记.md')).text
      expect(noteText).toContain('First reviewed note')
      expect(noteText).toContain('Second reviewed note')
      expect((await library.overview(other.id)).files.some(file => file.path.startsWith('笔记/'))).toBe(false)

      const display = page.locator('figure').filter({ hasText: 'Source positions' })
      const first = display.getByRole('img', { name: 'First visual' })
      await expect.poll(() => first.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await display.getByRole('button', { name: 'Play', exact: true }).click()
      await display.getByRole('img', { name: 'Second visual' }).waitFor()
      await display.getByRole('button', { name: 'Pause', exact: true }).click()
      const image = display.getByRole('img', { name: 'Second visual' })
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
      expect(await display.getByRole('slider').count()).toBe(0)
      await display.getByRole('button', { name: 'Next step', exact: true }).click()
      await display.getByRole('img', { name: 'Third visual' }).waitFor()

      await page.reload()
      await page.getByRole('button', { name: 'Course A', exact: true }).click()
      await page.getByRole('heading', { name: 'Complex numbers', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open learning assistant', exact: true }).click()
      await page.getByRole('img', { name: 'First visual' }).waitFor()
    } finally {
      await browser.close()
    }
  })
  it('moves and reconnects the AVL subtree with previous and next arrows', async () => {
    const course = await library.create('AVL lesson')
    await library.createFile(course.id, '学习文档/01-AVL.md', false)
    const document = await library.read(course.id, '学习文档/01-AVL.md')
    await library.save(course.id, document.path, '# AVL left rotation\n\nExplore the transfer of the middle subtree.', document.version)
    const learning = await library.session(course.id, 'learning')
    await scaffold.ctx.sessionController.selectModel({
      sessionId: learning.sessionId,
      provider: 'studio-prompt-test',
      model: 'studio-model',
    })
    const before = adapter.requests.length
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => Reflect.set(globalThis, '__BLS_STUDIO__', true))
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: course.name, exact: true }).click()
      await page.getByRole('heading', { name: 'AVL left rotation', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open learning assistant', exact: true }).click()
      await page.locator('[contenteditable="true"]:visible').last().fill(avlQuestion)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.getByText('35 大于 30、小于 40，所以它转到 30 的右侧。', { exact: true }).waitFor()

      const display = page.locator('figure').filter({ hasText: 'AVL 左旋' })
      const readFrame = (label: string) => display.getByRole('img', { name: label, exact: true }).evaluate(async (image: HTMLImageElement) => {
        await image.decode()
        const svg = new DOMParser().parseFromString(await (await fetch(image.currentSrc)).text(), 'image/svg+xml')
        const canvas = window.document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        return {
          edges: Array.from(svg.querySelectorAll('#connection-layer line'), line => line.id).sort(),
          pixels: [[76, 38], [176, 38], [155, 151]].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data)),
        }
      })
      const initial = await readFrame(avlLabels[0])
      expect(initial.edges).toEqual(['edge-30-40', 'edge-40-35', 'edge-40-50'])
      expect(initial.pixels.slice(0, 2)).toEqual([[219, 234, 254, 255], [255, 255, 255, 255]])

      const previous = display.getByRole('button', { name: 'Previous step', exact: true })
      const next = display.getByRole('button', { name: 'Next step', exact: true })
      expect(await display.getByRole('slider').count()).toBe(0)
      expect(await previous.isDisabled()).toBe(true)
      expect(await previous.locator('svg').count()).toBe(1)
      expect(await next.locator('svg').count()).toBe(1)
      await display.getByText('Step 1 / 3', { exact: true }).waitFor()
      await next.click()
      await display.getByText('Step 2 / 3', { exact: true }).waitFor()
      const preview = await readFrame(avlLabels[1])
      expect(preview.edges).toEqual(initial.edges)
      expect(preview.pixels[2]).toEqual([245, 158, 11, 255])

      await next.press('Enter')
      const final = await readFrame(avlLabels[2])
      expect(await next.isDisabled()).toBe(true)
      expect(final.edges).toEqual(['edge-30-35', 'edge-40-30', 'edge-40-50'])
      expect(final.pixels.slice(0, 2)).toEqual([[255, 255, 255, 255], [219, 234, 254, 255]])
      await previous.click()
      expect(await readFrame(avlLabels[1])).toEqual(preview)
      await previous.click()
      expect(await readFrame(avlLabels[0])).toEqual(initial)
      expect(await previous.isDisabled()).toBe(true)

      const loadedSkill = adapter.requests.slice(before).flatMap(request => request.messages)
        .filter(message => message.role === 'tool')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
        .find(text => text.includes('<skill_content name="study-explain">'))
      expect(loadedSkill).toContain('35 改接为 30 的右孩子')
    } finally {
      await browser.close()
    }
  })

  it('uses one contextual course browser, switches courses from its foot and returns home from plugins', async () => {
    const first = await library.create('Navigation course A')
    const second = await library.create('Navigation course B')
    await library.createFile(second.id, '学习文档/01-Intro.md', false)
    const intro = await library.read(second.id, '学习文档/01-Intro.md')
    await library.save(second.id, intro.path, '# ' + second.name, intro.version)
    await library.createFile(first.id, '笔记/filename-only.md', false)
    const content = await library.read(first.id, '笔记/filename-only.md')
    await library.save(
      first.id,
      content.path,
      '# Topic\n\nA content-only needle for unified search.\n',
      content.version,
    )
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.goto(scaffold.authenticatedUrl)
      const rail = page.getByRole('navigation', { name: 'Quick navigation', exact: true })
      await rail.getByRole('button', { name: 'Home · Course generation', exact: true }).waitFor()
      const railGeometry = async () =>
        rail.getByRole('button').evaluateAll(buttons =>
          buttons.map((button) => {
            const r = button.getBoundingClientRect()
            return { label: button.getAttribute('aria-label'), x: r.x, y: r.y, width: r.width, height: r.height }
          }),
        )
      const initialRail = await railGeometry()
      const search = page.getByRole('button', { name: 'Search and filter', exact: true })
      expect(await search.count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Generate a new course', exact: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Generate course', exact: true }).count()).toBe(0)
      expect(await page.getByRole('textbox', { name: 'Search courses', exact: true }).count()).toBe(0)
      await search.click()
      await page.getByRole('searchbox', { name: 'Search courses', exact: true }).fill(first.name)
      expect(await page.getByRole('button', { name: second.name, exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: first.name, exact: true }).click()
      const files = page.getByRole('navigation', { name: 'Course files', exact: true })
      await files.getByRole('button', { name: 'filename-only.md', exact: true }).waitFor()
      expect(await files.getByRole('button', { name: '课程首页.md', exact: true }).count()).toBe(0)
      expect(await files.getByRole('button', { name: '_工作区', exact: true }).count()).toBe(0)
      expect(await files.count()).toBe(1)
      const tools = page.getByRole('toolbar', { name: 'Reading tools', exact: true })
      expect(await tools.getByRole('button', { name: 'Outline', exact: true }).count()).toBe(1)
      expect(await tools.getByRole('button', { name: 'Backlinks', exact: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'File graph', exact: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Properties', exact: true }).count()).toBe(0)
      await files.getByRole('button', { name: 'Collapse all folders', exact: true }).click()
      expect(await files.getByRole('button', { name: 'filename-only.md', exact: true }).count()).toBe(0)
      await files.getByRole('button', { name: '笔记', exact: true }).click()
      await files.getByRole('button', { name: 'filename-only.md', exact: true }).waitFor()
      await files.getByRole('button', { name: 'Expand all folders', exact: true }).click()
      await files.getByRole('button', { name: 'New folder', exact: true }).click()
      const folderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
      await folderDialog.getByRole('textbox', { name: 'Course-relative path', exact: true }).fill('学习文档/2026/10')
      await folderDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
      await files.getByRole('button', { name: 'Expand all folders', exact: true }).click()
      await files.getByRole('button', { name: '10', exact: true }).waitFor()
      await files.getByRole('button', { name: 'New document', exact: true }).click()
      const fileDialog = page.getByRole('dialog', { name: 'New document', exact: true })
      await fileDialog
        .getByRole('textbox', { name: 'Course-relative path', exact: true })
        .fill('学习文档/2026/10/练习.md')
      await fileDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
      await files.getByRole('button', { name: '练习.md', exact: true }).waitFor()
      await files.getByRole('button', { name: '2026', exact: true }).click()
      expect(await files.getByRole('button', { name: '练习.md', exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      expect(await files.getByRole('treeitem', { name: '2026', exact: true }).getAttribute('aria-expanded')).toBe(
        'false',
      )
      await files.getByRole('button', { name: 'Expand all folders', exact: true }).click()
      await files.getByRole('button', { name: 'filename-only.md', exact: true }).click()
      expect(await railGeometry()).toEqual(initialRail)
      expect(await page.getByRole('button', { name: 'Course generation', exact: true }).count()).toBe(0)
      await search.click()
      const field = page.getByRole('searchbox', { name: 'Search file names and content', exact: true })
      await field.fill('filename-only')
      await files.getByRole('button', { name: '笔记/filename-only.md', exact: true }).waitFor()
      await field.fill('content-only needle')
      await files.getByRole('button').filter({ hasText: 'A content-only needle' }).waitFor()
      expect(await field.count()).toBe(1)
      await page.keyboard.press('Escape')
      await files.getByRole('button', { name: 'filename-only.md', exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename and update links', exact: true }).click()
      const rename = page.getByRole('dialog', { name: 'Rename and update links', exact: true })
      await rename.getByRole('textbox', { name: 'Course-relative path', exact: true }).fill('笔记/renamed.md')
      await rename.getByRole('button', { name: 'Preview changes', exact: true }).click()
      await rename.getByRole('button', { name: 'Confirm', exact: true }).click()
      await files.getByRole('button', { name: 'renamed.md', exact: true }).waitFor()
      await files.getByRole('button', { name: 'renamed.md', exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Move to trash', exact: true })
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
      await files.getByRole('button', { name: 'renamed.md', exact: true }).waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      expect(await railGeometry()).toEqual(initialRail)
      const expand = page.getByRole('button', { name: 'Open sidebar', exact: true })
      expect(await rail.locator('button[aria-label="Open sidebar"]').count()).toBe(0)
      await expand.click()
      await files.waitFor()
      expect(
        await page
          .locator('[data-studio-navigation]')
          .getByRole('navigation', { name: 'Course files', exact: true })
          .count(),
      ).toBe(1)
      expect(await rail.getByRole('button', { name: 'Course reading', exact: true }).getAttribute('aria-current')).toBe(
        'page',
      )
      const switcher = files.getByRole('button', { name: 'Switch course', exact: true })
      await switcher.click()
      await page.getByRole('menuitem', { name: second.name, exact: true }).waitFor()
      await page.keyboard.press('Escape')
      expect(await switcher.getAttribute('aria-expanded')).toBe('false')
      await switcher.click()
      await page.getByRole('menuitem', { name: second.name, exact: true }).click()
      await page.getByRole('heading', { name: second.name, exact: true }).waitFor()
      const before = (await library.list()).length
      await rail.getByRole('button', { name: 'Home · Course generation', exact: true }).click()
      await page.getByRole('navigation', { name: 'Courses', exact: true }).waitFor()
      await page.locator('[contenteditable="true"]:visible').last().waitFor()
      expect(await page.getByRole('button', { name: 'Choose workspace', exact: true }).count()).toBe(0)
      expect(await page.getByText('better-learning', { exact: true }).count()).toBe(0)
      await rail.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      expect(await settings.getByText('Agent presets', { exact: true }).count()).toBe(0)
      expect(await settings.getByText('Account', { exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      expect(await files.count()).toBe(0)
      expect((await library.list()).length).toBe(before)
      expect((await library.list()).find(course => course.id === second.id)?.generationSessionId).toBeDefined()
      await rail.getByRole('button', { name: 'Plugins', exact: true }).click()
      expect(await railGeometry()).toEqual(initialRail)
      await rail.getByRole('button', { name: 'Home · Course generation', exact: true }).click()
      await page.getByRole('navigation', { name: 'Courses', exact: true }).waitFor()
      await rail.getByRole('button', { name: 'Course reading', exact: true }).click()
      await page.getByRole('heading', { name: second.name, exact: true }).waitFor()
      expect((await library.list()).length).toBe(before)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(
        await page.locator('[data-studio-mode]').evaluate(element => getComputedStyle(element).animationName),
      ).toBe('none')
    } finally {
      await browser.close()
    }
  })
  it('keeps the composer at the viewport floor while reasoning expands and scrolling changes', async () => {
    const course = await library.create('Composer expansion regression')
    const { sessionId } = await library.session(course.id, 'generation')
    await scaffold.ctx.sessionController.selectModel({
      sessionId,
      provider: 'studio-prompt-test',
      model: 'studio-model',
    })
    const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error('No generation Agent')
    resolved.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Composer expansion regression' }],
      }),
    )
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: course.name, exact: true }).first().click()
      await page.getByRole('button', { name: 'Home · Course generation', exact: true }).click()
      await page.getByText('Studio model request accepted.', { exact: true }).waitFor()
      const composer = page.locator('[data-composer-seat]')
      const scroller = page.locator('[data-conversation-scroll]')
      const geometry = async () =>
        composer.evaluate((element) => {
          const scroller = element.closest('[data-conversation-content]')?.querySelector('[data-conversation-scroll]')
          if (scroller === null || scroller === undefined) throw new Error('No scroller')
          const seat = element.getBoundingClientRect(),
            port = element.closest('[data-conversation-content]')!.getBoundingClientRect()
          return {
            bottom: seat.bottom,
            floor: port.bottom,
            top: seat.top,
            height: seat.height,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
          }
        })
      const initial = await geometry()
      const process = page.locator('[data-turn-process]')
      if ((await process.count()) && (await process.getAttribute('aria-expanded')) === 'false') await process.click()
      for (let index = 0; index < 4; index++) {
        const group = page.locator('[data-process-activity][aria-expanded="false"]:visible').first()
        if ((await group.count()) === 0) break
        await group.click()
      }
      const reasoning = page.locator('[data-variant="think"] [data-disclosure-row]').first()
      await reasoning.waitFor()
      if ((await reasoning.getAttribute('aria-expanded')) === 'false') await reasoning.click()
      expect(await reasoning.getAttribute('aria-expanded')).toBe('true')
      await page.waitForTimeout(450)
      const expanded = await geometry()
      expect(expanded.scrollHeight, JSON.stringify(expanded)).toBeGreaterThan(2000)
      expect(Math.abs(expanded.bottom - expanded.floor), JSON.stringify({ initial, expanded })).toBeLessThan(2)
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight / 2
      })
      await page.waitForTimeout(100)
      const middle = await geometry()
      expect(Math.abs(middle.bottom - middle.floor), JSON.stringify(middle)).toBeLessThan(2)
    } finally {
      adapter.release?.()
      adapter.release = undefined
      await resolved.agent.whenIdle()
      await browser.close()
    }
  })
  it('scrolls outline, inline and history jumps from the current position without replacing the document', async () => {
    const course = await library.create('Smooth reading')
    const path = '学习文档/01-Scroll.md'
    await library.createFile(course.id, path, false)
    const file = await library.read(course.id, path)
    const paragraphs = Array.from({ length: 35 }, (_, index) => `Paragraph ${index}: reading content.`).join('\n\n')
    const source =
      '# Smooth document\n\n## 目标与入口\n\nOrdinary entry content.\n\n## Start\n\n' +
      paragraphs +
      '\n\n## Middle\n\n' +
      paragraphs +
      '\n\n## Last\n\n[Jump to start](#Start)\n'
    await library.save(course.id, path, source, file.version)
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: course.name, exact: true }).first().click()
      await page.getByRole('heading', { name: 'Smooth document', exact: true }).waitFor()
      const reader = page.locator('article[data-course-document]').first()
      expect(await reader.locator('[data-learning-section="goals"]').count()).toBe(0)
      await reader.evaluate((element) => {
        element.dataset.retainedReader = 'yes'
      })
      const middle = await reader.evaluate((element) => {
        const heading = Array.from(element.querySelectorAll('h2')).find(node => node.textContent === 'Middle')!
        return element.scrollTop + heading.getBoundingClientRect().top - element.getBoundingClientRect().top
      })
      const trace = async (): Promise<void> => {
        await reader.evaluate((element) => {
          const values: number[] = []
          Reflect.set(globalThis, '__BLS_SCROLL_TRACE__', values)
          const until = performance.now() + 1800
          const sample = (): void => {
            values.push(element.scrollTop)
            if (performance.now() < until && element.isConnected) requestAnimationFrame(sample)
          }
          sample()
        })
      }
      const settled = async (title: string): Promise<void> => {
        await page.waitForFunction((title) => {
          const heading = Array.from(document.querySelectorAll('article h2')).find(node => node.textContent === title)
          return (
            heading !== undefined &&
            Math.abs(heading.getBoundingClientRect().top - heading.closest('article')!.getBoundingClientRect().top) < 1
          )
        }, title)
        expect(await page.locator('article[data-retained-reader="yes"]').count()).toBe(1)
      }
      const panel = page.getByRole('complementary', { name: 'Course right sidebar', exact: true })
      await reader.evaluate((element, top) => {
        element.scrollTo({ top, behavior: 'instant' })
      }, middle + 100)
      const start = await reader.evaluate(element => element.scrollTop)
      await trace()
      await panel.getByRole('button', { name: 'Last', exact: true }).click()
      await settled('Last')
      const end = await reader.evaluate(element => element.scrollTop)
      const down = await page.evaluate(() => Reflect.get(globalThis, '__BLS_SCROLL_TRACE__') as number[])
      expect(Math.min(...down)).toBeGreaterThanOrEqual(start - 2)
      expect(down.some(value => value > start + 2 && value < end - 2)).toBe(true)
      await trace()
      await reader.getByRole('button', { name: 'Jump to start', exact: true }).click()
      await settled('Start')
      const upEnd = await reader.evaluate(element => element.scrollTop)
      const up = await page.evaluate(() => Reflect.get(globalThis, '__BLS_SCROLL_TRACE__') as number[])
      expect(Math.min(...up)).toBeGreaterThanOrEqual(upEnd - 2)
      expect(up.some(value => value > upEnd + 2 && value < end - 2)).toBe(true)
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await settled('Last')
      await reader.evaluate((element, top) => {
        element.scrollTo({ top, behavior: 'instant' })
      }, middle)
      await panel.getByRole('button', { name: 'Last', exact: true }).click()
      await settled('Last')
    } finally {
      await browser.close()
    }
  })
  it('opens tutor course citations in the reader with paths, headings, line numbers and folded answers', async () => {
    const course = await library.create('Citation navigation')
    const firstPath = '学习文档/01-Studied.md',
      secondPath = '学习文档/02-Linked.md'
    for (const path of [firstPath, secondPath]) await library.createFile(course.id, path, false)
    const first = await library.read(course.id, firstPath),
      second = await library.read(course.id, secondPath)
    const text =
      '# Linked lesson\n\n## Target heading\n\n<details><summary>Answers</summary>\n\nAnswer source.\n\n</details>\n'
    await library.save(course.id, firstPath, '# Studied lesson\n\nOriginal content.', first.version)
    await library.save(course.id, secondPath, text, second.version)
    const learning = await library.session(course.id, 'learning')
    await scaffold.ctx.sessionController.selectModel({
      sessionId: learning.sessionId,
      provider: 'studio-prompt-test',
      model: 'studio-model',
    })
    const resolved = await scaffold.ctx.sessionController.resolveAgent(learning.sessionId)
    if ('error' in resolved) throw new Error('Missing tutor agent')
    const cwd = resolved.agent.session.header.cwd
    if (cwd === undefined) throw new Error('Missing tutor workspace')
    const absolute = join(cwd, secondPath)
    adapter.citationReply = `[Relative](02-Linked.md) [Absolute](<${absolute.replaceAll('\\', '/')}> ) [File URL](${pathToFileURL(absolute).href}) [Heading](学习文档/02-Linked.md#Target%20heading) [Line](学习文档/02-Linked.md#L7) [Missing](missing.md)`
    resolved.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'Course citation regression' }], source: { kind: 'user' } }),
    )
    await resolved.agent.whenIdle()
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript(() => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
      })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: course.name, exact: true }).first().click()
      await page.getByRole('heading', { name: 'Studied lesson', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Open learning assistant', exact: true }).click()
      const tutor = page.getByRole('complementary', { name: 'Course right sidebar', exact: true })
      for (const name of ['Relative', 'Absolute', 'File URL']) {
        await tutor.getByRole('button', { name, exact: true }).click()
        await page.getByRole('heading', { name: 'Linked lesson', exact: true }).waitFor()
      }
      await tutor.getByRole('button', { name: 'Heading', exact: true }).click()
      await page.waitForFunction(() => {
        const heading = Array.from(document.querySelectorAll('article h2')).find(
          node => node.textContent === 'Target heading',
        )
        return (
          heading !== undefined &&
          Math.abs(heading.getBoundingClientRect().top - heading.closest('article')!.getBoundingClientRect().top) < 1
        )
      })
      await tutor.getByRole('button', { name: 'Line', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('button[aria-controls][aria-expanded="true"]')?.textContent === 'Answers',
      )
      expect(await page.locator('article').innerText()).not.toContain('<details>')
      await tutor.getByRole('button', { name: 'Missing', exact: true }).click()
      await page
        .getByText('The referenced file was not found in this course. Check its path.', { exact: true })
        .waitFor()
      expect((await library.read(course.id, secondPath)).text).toBe(text)
    } finally {
      adapter.citationReply = undefined
      await browser.close()
    }
  })
  it('automatically imports a dropped free-layout folder, aligns outline headings and persists Markdown styling', async () => {
    const source = join(scaffold.harnessHome, 'Imported layout')
    await mkdir(join(source, '讲义/任意层级'), { recursive: true })
    const sourceFile = join(source, '讲义/任意层级/Free.md')
    const markdown =
      '# First section\n\nIntro.\n\n## Middle section\n\n' +
      Array.from({ length: 35 }, (_, index) => 'Paragraph ' + String(index) + ': learning material.').join('\n\n') +
      '\n\n## Last section\n\nDone.\n'
    await writeFile(sourceFile, markdown)
    await writeFile(join(source, 'data.csv'), 'a,b\n1,2\n')
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.addInitScript((source) => {
        Reflect.set(globalThis, '__BLS_STUDIO__', true)
        Reflect.set(globalThis, '__DSH_HOST_PATHS__', { pathFor: () => source })
      }, source)
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Course A', exact: true }).click()
      await page.getByRole('button', { name: 'Switch course', exact: true }).click()
      const importEntry = page.getByRole('menuitem', { name: 'Import course', exact: true })
      await importEntry.waitFor()
      await page.getByRole('separator').last().waitFor()
      await importEntry.click()
      const dialog = page.getByRole('dialog', { name: 'Import course', exact: true })
      expect(await dialog.getByRole('button').count()).toBe(1)
      await dialog.locator('[aria-busy]').evaluate((element) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([], 'Imported layout'))
        element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
      })
      await page.getByRole('heading', { name: 'First section', exact: true }).waitFor()
      const tree = page.getByRole('tree', { name: 'Course files', exact: true })
      expect(await tree.getByRole('button', { name: '讲义', exact: true }).count()).toBe(1)
      expect(await tree.getByRole('button', { name: 'Free.md', exact: true }).count()).toBe(1)
      const imported = (await library.list()).find(course => course.name === 'Imported layout')
      expect(imported?.imported).toBe(true)
      if (imported === undefined) throw new Error('No imported course')
      expect((await library.read(imported.id, '讲义/任意层级/Free.md')).text).toBe(markdown)
      expect(await readFile(sourceFile, 'utf8')).toBe(markdown)
      const panel = page.getByRole('complementary', { name: 'Course right sidebar', exact: true })
      for (const title of ['Middle section', 'Last section', 'First section', 'Last section']) {
        await panel.getByRole('button', { name: title, exact: true }).click()
        await page.waitForFunction((title) => {
          const heading = Array.from(document.querySelectorAll('article h1,article h2')).find(
            node => node.textContent === title,
          )
          const reader = heading?.closest('article')
          return (
            heading !== undefined &&
            reader !== null &&
            reader !== undefined &&
            Math.abs(heading.getBoundingClientRect().top - reader.getBoundingClientRect().top) < 1
          )
        }, title)
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const toggle = page.getByRole('switch', { name: 'Markdown styling', exact: true })
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      await toggle.click()
      expect(await page.locator('html').getAttribute('data-studio-markdown')).toBe('off')
      await page.reload()
      await page.waitForFunction(() => document.documentElement.dataset.studioMarkdown === 'off')
      await page.getByRole('button', { name: 'Imported layout', exact: true }).first().click()
      const heading = page.getByRole('heading', { name: 'First section', exact: true })
      await heading.waitFor()
      expect(await heading.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThan(
        20,
      )
    } finally {
      await browser.close()
    }
  })
})
