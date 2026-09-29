/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'shortcut.noSession': '请先选择会话',
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  autoRefresh: '自动刷新',
  'autoRefresh.enable': '开启自动刷新',
  'autoRefresh.disable': '关闭自动刷新',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
  'courseProgress.waiting': '等待课程资料',
  'courseProgress.multiple': '工作区内有多门课程，请分别打开',
  'courseProgress.intake': '确认学习需求',
  'courseProgress.needs_update': '等待重新确认资料',
  'courseProgress.needs_review': '课程待检查',
  'courseProgress.paused': '课程已暂停',
  'courseProgress.working': '课程未完成',
  'courseProgress.complete': '课程已完成',
  'courseProgress.other': '课程处理中',
  'courseProgress.chapters': '已完成 {count} 章',
  'courseProgress.lessons': '已完成 {count} 节',
  'courseProgress.blockers': '{count} 项异常待处理',
  'courseProgress.readFailed': '课程进度读取失败',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'shortcut.noSession': 'Select a session first',
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  autoRefresh: 'Auto refresh',
  'autoRefresh.enable': 'Enable auto refresh',
  'autoRefresh.disable': 'Disable auto refresh',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
  'courseProgress.waiting': 'Waiting for course materials',
  'courseProgress.multiple': 'Open each course in its own workspace',
  'courseProgress.intake': 'Confirm learning needs',
  'courseProgress.needs_update': 'Confirm updated materials',
  'courseProgress.needs_review': 'Course needs review',
  'courseProgress.paused': 'Course paused',
  'courseProgress.working': 'Course incomplete',
  'courseProgress.complete': 'Course complete',
  'courseProgress.other': 'Course in progress',
  'courseProgress.chapters': '{count} chapters complete',
  'courseProgress.lessons': '{count} lessons complete',
  'courseProgress.blockers': '{count} issues need attention',
  'courseProgress.readFailed': 'Could not read course progress',
} satisfies Record<SidebarFilesKey, string>
