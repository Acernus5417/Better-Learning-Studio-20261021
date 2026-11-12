import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  STUDY_DISPLAY_CONTROLS, STUDY_DISPLAY_TOOL, STUDY_MEDIA_TYPES, type CourseStudyDisplays, type StudyDisplay, type StudyMediaType,
} from '@deepseek-ai/dsh-util-course-document'
import { z } from 'zod'
import { CourseLibraryError, type CourseLibrary } from './course-library.ts'

const mediaBytes = 8 * 1024 * 1024
const displayBytes = 32 * 1024 * 1024
const frameLimit = 120
const controls = z.enum(STUDY_DISPLAY_CONTROLS)
const frame = z.union([
  z.object({ path: z.string().min(1), label: z.string().optional() }).strict(),
  z.object({ svg: z.string().min(1), label: z.string().optional() }).strict(),
])
const displaySchema: z.ZodType<StudyDisplay> = z.object({
  courseId: z.string(), title: z.string().optional(),
  frames: z.array(z.object({ asset: z.string(), label: z.string() })).min(1).max(frameLimit),
  controls, intervalMs: z.number().int().min(40).max(30_000),
})
const wireSchema: z.ZodType<CourseStudyDisplays> = z.record(z.string(), z.array(displaySchema))
const stateSchema = z.object({ learning: z.boolean(), displays: wireSchema })

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    courseStudyDisplays: z.infer<typeof stateSchema>
  }
}

function isMedia(type: string): type is StudyMediaType {
  return Object.values(STUDY_MEDIA_TYPES).some(value => value === type)
}

function checkSvg(data: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  if (!/^\s*(?:<\?xml[^?]*\?>\s*)?<svg\b/iu.test(text) || /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) {
    throw new CourseLibraryError('SVG requires a self-contained SVG document', 400)
  }
}

/** Register one reusable publishing tool and a durable turn-level display feed. */
export function installCourseStudyDisplay(ctx: Context, library: CourseLibrary): (agent: Agent) => void {
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'courseStudyDisplays', stateVersion: 1, stateSchema,
    init: header => ({ learning: header.agentPreset === 'better-learning-study', displays: {} }),
    apply: (state, event) => {
      if (!state.learning || event.type !== 'tool/result' || event.data.message.isError) return state
      const parsed = z.object({ kind: z.literal('course-study-display-v1'), display: displaySchema }).safeParse(event.data.meta)
      if (!parsed.success) return state
      const turn = String(event.data.turn)
      return { ...state, displays: { ...state.displays, [turn]: [...state.displays[turn] ?? [], parsed.data.display] } }
    },
    wire: { viewSchema: wireSchema, view: state => state.displays },
  }), 'course: study displays')

  const show = defineTool({
    name: STUDY_DISPLAY_TOOL,
    description: 'Display visual media inside the learning conversation. Send one frame for an image or self-contained SVG, or ordered frames for an interactive display. Frame labels describe the visual state. SVG and image assets are displayed as images.',
    parameters: {
      title: { type: 'string' },
      frames: { type: 'array', required: true, items: { type: 'json' },
        description: 'Each frame is {path, label?} for a course-relative image, or {svg, label?} for a complete SVG document. Arrange frames in the order the learner should see them.' },
      controls: { type: 'string', enum: STUDY_DISPLAY_CONTROLS,
        description: 'Use steps (default) for ordered discrete states and playback to add play and pause to step arrows. Use choices for named alternatives and slider for sampled continuous parameters.' },
      intervalMs: { type: 'number', description: 'Frame duration for playback, in milliseconds.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { display: { type: 'json', required: true } } },
      render: () => [{ type: 'text', text: 'Visual media displayed in the learning conversation.' }],
      presentationMeta: (_args, output) => ({ kind: 'course-study-display-v1', display: output.display }),
    },
    execute: async (args, execution) => {
      const agent = execution.agent
      if (agent === undefined || ctx.agents.get(agent.id) !== agent) throw new CourseLibraryError('A live learning Session is required', 403)
      const course = (await library.list()).find(item => item.learningSessionId === agent.id)
      const workspace = ctx.workspaceRegistry.list().find(item => item.id === course?.workspaceId)
      if (course === undefined || workspace?.path !== agent.session.header.cwd) throw new CourseLibraryError('Learning Session course binding changed', 403)
      const frames = z.array(frame).min(1).max(frameLimit).parse(args.frames)
      const duration = z.number().int().min(40).max(30_000).parse(args.intervalMs ?? 800)
      const media: { data: Uint8Array; type: StudyMediaType; label: string }[] = []
      let bytes = 0
      for (const source of frames) {
        execution.signal.throwIfAborted()
        const image = 'svg' in source
          ? { data: new TextEncoder().encode(source.svg), type: 'image/svg+xml' }
          : await library.asset(course.id, source.path, mediaBytes)
        if (!isMedia(image.type)) throw new CourseLibraryError('Select an image or SVG for the frame', 415)
        bytes += image.data.byteLength
        if (image.data.byteLength > mediaBytes || bytes > displayBytes) throw new CourseLibraryError('Study media exceeds the display size limit', 413)
        if (image.type === 'image/svg+xml') checkSvg(image.data)
        media.push({ ...image, type: image.type, label: source.label ?? '' })
      }
      const published = []
      for (const item of media) {
        execution.signal.throwIfAborted()
        published.push({ asset: await library.saveStudyMedia(course.id, item.data, item.type), label: item.label })
      }
      return { display: { courseId: course.id, frames: published, controls: args.controls ?? 'steps', intervalMs: duration,
        ...(args.title === undefined ? {} : { title: args.title }) } }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/better-learning/study-media', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const query = new URL(request.url).searchParams
        const media = await library.studyMedia(query.get('id') ?? '', query.get('asset') ?? '')
        return new Response(new Uint8Array(media.data), { headers: {
          'Content-Type': media.type,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        } })
      } catch (error) {
        return new Response(null, { status: error instanceof CourseLibraryError ? error.status : 404 })
      }
    },
  })
  return agent => { agent.ctx.effect(() => agent.ctx.tools.register(show), 'course: study media tool') }
}
