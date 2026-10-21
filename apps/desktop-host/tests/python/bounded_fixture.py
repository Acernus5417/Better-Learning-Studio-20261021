"""Synthetic host receipts for testing real bounded gates; no model or isolation claim."""
import unittest
from _common import read_json, write_json
from bounded_runtime import Runtime
import bounded_pipeline as pipeline


class BoundedPipelineTests(unittest.TestCase):
    def runtime(self):
        runtime = Runtime(self.course)
        self.addCleanup(runtime.close)
        self.register_sessions(runtime)
        return runtime

    def register_sessions(self, runtime, prefix='fixture'):
        for who in (prefix + '-writer', prefix + '-reviewer'):
            path = self.course / '_工作区' / (who + '.json')
            write_json(path, dict(kind='host-session', session_id=who, agent_id=who + '-agent',
                                 host='fixture-only', event_id=who + '-event', issuer='trusted-fixture-adapter',
                                 independent_context=True, context_history='none', can_write=True, can_review=True))
            runtime.register_session({'receipt_path': str(path)})

    def approve(self, runtime, task_id, candidate, prefix='fixture'):
        writer, reviewer = prefix + '-writer', prefix + '-reviewer'
        lease = runtime.claim(task_id, writer)['lease']
        stop_path = self.course / '_工作区' / (task_id + '-stop.json')
        write_json(stop_path, dict(kind='host-stop', state='completed', session_id=writer,
                                  agent_id=writer + '-agent', task_id=task_id, lease=lease,
                                  issuer='trusted-fixture-adapter', event_id=task_id + '-stopped'))
        runtime.submit_candidate(task_id, lease, [str(candidate)], {'receipt_path': str(stop_path)})
        prep = runtime.prepare_review(task_id, reviewer)
        for group in prep['scope'].values():
            for item in group:
                offset = 0
                while True:
                    result = runtime.read_review(task_id, reviewer, prep['review_token'], item['path'], offset)
                    if result['eof']:
                        break
                    offset = result['next_offset']
        receipt_path = self.course / '_工作区' / (task_id + '-review.json')
        write_json(receipt_path, dict(kind='semantic-review', task_id=task_id, spec_hash=prep['spec_hash'],
                                    reviewer_session=reviewer, verdict='pass', scope=prep['scope'],
                                    scope_hash=prep['scope_hash'],
                                    candidate_hashes=[p['sha256'] for p in prep['scope']['candidates']],
                                    findings=[dict(check=check, path=str(candidate.resolve()), result='pass',
                                                   detail='Synthetic integration fixture checked against scoped input.')
                                              for check in ('source_fidelity', 'coverage', 'pedagogy', 'relations')]))
        runtime.review(task_id, reviewer, 'pass', [str(receipt_path)])
        return runtime.gate_for_artifact(str(candidate))

    def plan(self, runtime, row):
        plan_path = self.course / row['blueprint']
        plan = read_json(plan_path)
        plan.update(status='complete', goals=['掌握本章概念'],
                    exercise_plan=[{'section_id': row['sections'][-1]['id'], 'goal': '应用概念'}])
        write_json(plan_path, plan)
        section = next(s for s in row['sections'] if s['kind'] == 'knowledge')
        unit = read_json(self.course / section['bounded_spec'])
        runtime.create_task('plan-' + row['id'], 'path', pipeline.planning_inputs(self.course, row),
                            {'scope': 'blueprint'}, 'fixture-writer')
        return self.approve(runtime, 'plan-' + row['id'], plan_path)
