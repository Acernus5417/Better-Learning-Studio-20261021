import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { STUDY_SKILL_PROVIDER } from '@deepseek-ai/dsh-util-course-document'
import { CourseLibraryError } from './course-library.ts'

/** Expose only the Studio study catalog to the model in a learning Session. */
export function registerCourseStudySkill(ctx: Context, agent: Agent): void {
  const tool = defineTool({
    name: 'study_skill',
    description: 'List built-in Studio learning skills, or load one by name before performing a learning task.',
    parameters: { name: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, output) => [{ type: 'text', text: output.text }],
    },
    execute: async ({ name }, execution) => {
      if (execution.agent !== agent) throw new CourseLibraryError('A live learning Session is required', 403)
      const lookup = { cwd: agent.session.header.cwd, scope: agent, signal: execution.signal }
      if (name === undefined) {
        const entries = await ctx.skills.list(lookup)
        return { text: JSON.stringify(entries.filter(skill => skill.provider === STUDY_SKILL_PROVIDER && isModelInvocable(skill))
          .map(({ name, description }) => ({ name, description }))) }
      }
      const skill = await ctx.skills.get(name, lookup)
      if (skill === undefined || skill.provider !== STUDY_SKILL_PROVIDER || !isModelInvocable(skill)) {
        throw new CourseLibraryError('The selected learning skill is unavailable', 404)
      }
      return { text: renderSkillContent(skill) }
    },
  })
  agent.ctx.effect(() => agent.ctx.tools.register(tool), 'course: study skill tool')
}
