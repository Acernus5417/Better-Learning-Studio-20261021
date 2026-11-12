export const STUDY_DISPLAY_TOOL = 'study_show'

/** Controls supported by the study media tool and conversation renderer. */
export const STUDY_DISPLAY_CONTROLS = ['steps', 'choices', 'slider', 'playback'] as const
export const STUDY_SKILL_PROVIDER = 'studio-study-skills'

export const STUDY_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
} as const

export type StudyMediaType = typeof STUDY_MEDIA_TYPES[keyof typeof STUDY_MEDIA_TYPES]

export interface StudyDisplay {
  readonly courseId: string
  readonly title?: string | undefined
  readonly frames: readonly { readonly asset: string; readonly label: string }[]
  readonly controls: typeof STUDY_DISPLAY_CONTROLS[number]
  readonly intervalMs: number
}

export type CourseStudyDisplays = Readonly<Record<string, readonly StudyDisplay[]>>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    courseStudyDisplays: CourseStudyDisplays
  }
}
