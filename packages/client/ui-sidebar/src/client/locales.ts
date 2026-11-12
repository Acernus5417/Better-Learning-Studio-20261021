/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'studio.brandLearning': 'Better Learning',
  'studio.brandProduct': 'Studio',
  'session.new': '新会话',
  'course.new': '课程生成',
  'course.new.label': '生成新课程',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'studio.navigation': '快捷功能',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'studio.brandLearning': 'Better Learning',
  'studio.brandProduct': 'Studio',
  'session.new': 'New Session',
  'course.new': 'Generate course',
  'course.new.label': 'Generate a new course',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'studio.navigation': 'Quick navigation',
} satisfies Record<SidebarKey, string>
