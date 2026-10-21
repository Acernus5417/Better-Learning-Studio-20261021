"""Teaching unit contracts through real prepare/collect/commit and card inputs."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'apps/desktop/resources/workflows/better-learning/scripts'))
from _common import atomic_text, read_json, read_jsonl, sha256, write_json
from assemble_knowledge import rebuild_knowledge
from entity_sections import parse_sections
from entity_registry import Registry
import teaching_units as units
import lesson_tasks as lessons
import core_cards as cards
import bounded_pipeline
import studio_teaching_units as studio
import course_fixture as support


def unit(kids=None, **extra):
    return dict({'id': 'TU-01', 'title': '选择表示并检查结果',
                 'knowledge_ids': kids or ['K-01', 'K-02'], 'depth': 'standard',
                 'reason': '共同方法支持同一任务', 'goals': ['选择合适表示', '检查结果'],
                 'success_criteria': ['方法有依据，结果可核验'],
                 'stop_when': ['关键方法与辨误已完整']}, **extra)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.course = Path(self.tmp.name)
        self.knowledge = [{'id': 'K-01', 'prerequisites': []},
                          {'id': 'K-02', 'prerequisites': ['K-01']}]

    def config(self, **lessons_config):
        data = {'schema_version': 1, 'lessons': lessons_config or {'L-01': {'units': [unit()]}}}
        write_json(self.course / units.CONFIG, data)
        return data

    def test_grouping_and_explicit_legacy_fallback(self):
        fallback = units.resolve(self.course, 'L-01', self.knowledge)
        self.assertFalse(fallback['configured'])
        self.assertEqual(len(fallback['units']), 2)
        self.assertFalse((self.course / units.CONFIG).exists())
        self.config()
        self.assertEqual(units.resolve(self.course, 'L-01', self.knowledge)['units'], [unit()])

    def test_missing_duplicate_foreign_knowledge_and_bad_fields_fail(self):
        for values in [[unit(['K-01'])], [unit(['K-01', 'K-99'])],
                       [unit(), unit(id='TU-02')], [unit(misspelling='x')],
                       [unit(depth='short')], [unit(goals=[])], [unit(stop_when=[])]]:
            with self.subTest(values=values):
                self.config(**{'L-01': {'units': values}})
                with self.assertRaises(ValueError):
                    units.resolve(self.course, 'L-01', self.knowledge)

    def test_cross_unit_dependency_order(self):
        self.config(**{'L-01': {'units': [unit(['K-02']), unit(['K-01'], id='TU-02')]}})
        with self.assertRaisesRegex(ValueError, 'prerequisite appears later'):
            units.resolve(self.course, 'L-01', self.knowledge)

    def test_reminder_requires_actual_entry_evidence(self):
        self.config(**{'L-01': {'units': [unit(depth='reminder')]}})
        with self.assertRaisesRegex(ValueError, 'entry_evidence'):
            units.resolve(self.course, 'L-01', self.knowledge)
        self.config(**{'L-01': {'units': [unit(depth='reminder', entry_evidence='诊断已通过')]}})
        self.assertTrue(units.resolve(self.course, 'L-01', self.knowledge)['configured'])

    def test_other_lesson_design_does_not_change_current_fingerprint(self):
        data = self.config(**{'L-01': {'units': [unit()]}, 'L-02': {'units': [unit(['K-03'])]}})
        before = units.fingerprint(units.resolve(self.course, 'L-01', self.knowledge))
        data['lessons']['L-02']['units'][0]['depth'] = 'deep'
        write_json(self.course / units.CONFIG, data)
        self.assertEqual(before, units.fingerprint(units.resolve(self.course, 'L-01', self.knowledge)))
        data['lessons']['L-01']['units'][0]['depth'] = 'deep'
        write_json(self.course / units.CONFIG, data)
        self.assertNotEqual(before, units.fingerprint(units.resolve(self.course, 'L-01', self.knowledge)))

    def test_unknown_lesson_is_not_silently_ignored(self):
        write_json(self.course / '_工作区/章节索引.json', {'lessons': [{'id': 'L-01'}]})
        self.config(**{'L-99': {'units': [unit()]}})
        with self.assertRaisesRegex(ValueError, 'unknown lessons'):
            units.resolve(self.course, 'L-01', self.knowledge)

    def test_heading_lookup_ignores_code_and_rejects_duplicates(self):
        text = '```md\n## 方法\n```\n## 方法\n正文\n## 下一节\n'
        span = lessons.exercise_span(text, '方法')
        self.assertEqual(text[span[0]:span[1]], '## 方法\n正文\n')
        coded = '## 方法\n正文\n## `next()`\n代码课程的下一节\n'
        span = lessons.exercise_span(coded, '方法')
        self.assertEqual(coded[span[0]:span[1]], '## 方法\n正文\n')
        with self.assertRaisesRegex(ValueError, 'Duplicate heading'):
            lessons.exercise_span('## 方法\nA\n## 方法\nB', '方法')


class PipelineTests(unittest.TestCase):
    setUp = support.V2Tests.setUp
    tearDown = support.V2Tests.tearDown
    knowledge = support.V2Tests.knowledge
    lesson_row = support.V2Tests.lesson_row

    def grouped(self):
        self.knowledge(2)
        index = read_json(self.course / lessons.INDEX)
        index['lessons'] = index['lessons'][:1]
        write_json(self.course / lessons.INDEX, index)
        path_index = read_json(self.course / '_工作区/路径索引.json')
        path_index['steps'][1]['lessons'] = []
        write_json(self.course / '_工作区/路径索引.json', path_index)
        knowledge = read_jsonl(self.course / '_工作区/知识索引.jsonl')
        knowledge[1]['lesson_ids'] = ['L-01']
        atomic_text(self.course / '_工作区/知识索引.jsonl', ''.join(json.dumps(k) + '\n' for k in knowledge))
        rebuild_knowledge(self.course)
        write_json(self.course / units.CONFIG, {'schema_version': 1, 'lessons': {'L-01': {'units': [unit()]}}})
        lessons.prepare(self.course)
        return self.lesson_row('L-01')

    def write_group(self, row, where='knowledge'):
        manifest = read_json(self.course / row['manifest'])
        section_ex = next(s for s in row['sections'] if s['kind'] == where)
        exid = section_ex['reserved_exercises'][0]['id']
        exercise = '\n### 练习入口\n\n#### 选择与检查\n独立选择表示完成计算，并解释检查结果。\n\n##### 核对反馈\n选择依据、必要步骤与交叉检查均应成立。\n'
        for section in row['sections']:
            headings = {}
            if section['kind'] == 'intro':
                text = '---\ntype: lesson\nid: L-01\ntitle: 组合教学\norder: 1\nstatus: complete\n---\n# 组合教学\n学习路线。\n'
            elif section['kind'] == 'knowledge':
                text = ('## 选择表示并检查结果\n公共方法只讲一次。\n\n'
                        '### 表示甲\n必要条件与关键步骤甲。\n' + manifest['links']['knowledge']['K-01'] +
                        '\n\n### 表示乙\n必要差异与关键步骤乙。\n' + manifest['links']['knowledge']['K-02'] + '\n')
                headings = {'K-01': '表示甲', 'K-02': '表示乙'}
            else:
                text = '## 整合迁移\n复习时再次选择方法。\n'
            if section['id'] == section_ex['id']:
                text += exercise
            atomic_text(self.course / section['directory'] / '001.md', text)
            write_json(self.course / section['receipt'], {'schema_version': 1, 'section_id': section['id'],
                       'status': 'complete', 'files': ['001.md'], 'knowledge_headings': headings})
        result = {'status': 'complete', 'lesson_id': 'L-01', 'knowledge_ids': ['K-01', 'K-02'],
                  'exercises': [{'id': exid, 'heading': '选择与检查', 'assesses': ['K-01', 'K-02'],
                                 'feedback_heading': '核对反馈'}],
                  'unit_reviews': [{'unit_id': 'TU-01', 'goal_checks': [
                      {'goal': goal, 'exercise_ids': [exid], 'criterion': '方法与检查符合反馈标准'}
                      for goal in unit()['goals']], 'reasoning_check': '关键步骤完整',
                      'economy_check': '共享方法保留一次，题目检验两个目标', 'limitations': []}]}
        write_json(self.course / row['result'], result)
        return result

    def test_grouped_commit_preserves_identity_shared_text_and_actual_task(self):
        row = self.grouped()
        self.assertEqual(len(row['sections']), 3)
        self.assertEqual(row['sections'][1]['knowledge_ids'], ['K-01', 'K-02'])
        self.write_group(row)
        result = lessons.commit(self.course, 'L-01')
        self.assertIsNone(result['failure_kind'], result)
        text = (self.course / row['path']).read_text(encoding='utf-8')
        self.assertEqual(text.count('公共方法只讲一次。'), 1)
        parsed = parse_sections(text, Registry(self.course))
        for kid in row['knowledge_ids']:
            self.assertEqual(text.count('^' + kid + '\n'), 1)
            self.assertIn(('TEACH', 'L-01-' + kid), parsed.sections)
        self.assertEqual(lessons.check(self.course), [])
        self.assertTrue(lessons.commit(self.course, 'L-01')['idempotent'])

    def test_exercise_can_be_in_closing(self):
        row = self.grouped()
        self.write_group(row, 'closing')
        result = lessons.commit(self.course, 'L-01')
        self.assertIsNone(result['failure_kind'], result)

    def test_diagnostic_task_can_be_in_intro(self):
        row = self.grouped(); self.write_group(row, 'intro')
        result = lessons.commit(self.course, 'L-01')
        self.assertIsNone(result['failure_kind'], result)

    def test_tampered_local_unit_input_is_rejected_as_stale(self):
        row = self.grouped(); self.write_group(row)
        manifest = read_json(self.course / row['manifest'])
        write_json(Path(manifest['inputs']['teaching_units']), {'tampered': True})
        result = lessons.commit(self.course, 'L-01')
        self.assertEqual(result['failure_kind'], 'STALE_INPUT', result)
        self.assertFalse((self.course / row['path']).exists())

    def test_group_heading_map_must_cover_each_knowledge(self):
        row = self.grouped(); self.write_group(row)
        section = row['sections'][1]
        receipt = read_json(self.course / section['receipt'])
        receipt['knowledge_headings'].pop('K-02')
        write_json(self.course / section['receipt'], receipt)
        result = lessons.commit(self.course, 'L-01')
        self.assertEqual(result['failure_kind'], 'INVALID_OUTPUT', result)
        self.assertIn('knowledge_headings must cover', result['error'])

    def test_section_exercise_pool_is_enforced(self):
        row = self.grouped(); result = self.write_group(row)
        wrong = row['sections'][0]['reserved_exercises'][0]['id']
        result['exercises'][0]['id'] = wrong
        for check in result['unit_reviews'][0]['goal_checks']:
            check['exercise_ids'] = [wrong]
        write_json(self.course / row['result'], result)
        outcome = lessons.commit(self.course, 'L-01')
        self.assertEqual(outcome['failure_kind'], 'INVALID_OUTPUT', outcome)
        self.assertIn('belongs to another section', outcome['error'])

    def test_goal_feedback_and_heading_coverage_fail_before_formal_write(self):
        row = self.grouped()
        original = self.write_group(row)
        for case in ('goals', 'feedback', 'foreign'):
            result = copy.deepcopy(original)
            if case == 'goals': result['unit_reviews'][0]['goal_checks'].pop()
            if case == 'feedback': result['exercises'][0]['feedback_heading'] = '不存在的反馈'
            if case == 'foreign': result['unit_reviews'][0]['goal_checks'][0]['exercise_ids'] = ['EX-foreign']
            write_json(self.course / row['result'], result)
            # Independent attempts, not an attempt-limit test.
            data = read_json(self.course / lessons.LEDGER)
            data['lessons'][0]['attempt_count'] = 0
            write_json(self.course / lessons.LEDGER, data)
            outcome = lessons.commit(self.course, 'L-01')
            self.assertEqual(outcome['failure_kind'], 'INVALID_OUTPUT', outcome)
            self.assertFalse((self.course / row['path']).exists())

    def test_exercise_cannot_be_nested_in_knowledge_span(self):
        row = self.grouped(); self.write_group(row)
        path = self.course / row['sections'][1]['directory'] / '001.md'
        text = path.read_text(encoding='utf-8').replace('### 练习入口', '#### 练习入口')
        atomic_text(path, text)
        result = lessons.commit(self.course, 'L-01')
        self.assertEqual(result['failure_kind'], 'INVALID_OUTPUT', result)
        self.assertIn('Overlapping', result['error'])

    def test_completed_group_headings_are_preserved_and_protected_on_resume(self):
        row = self.grouped(); self.write_group(row)
        (self.course / row['result']).unlink()
        self.assertEqual(lessons.commit(self.course, 'L-01')['failure_kind'], 'PARTIAL_OUTPUT')
        lessons.prepare(self.course)
        row = self.lesson_row('L-01')
        section = row['sections'][1]
        receipt = read_json(self.course / section['receipt'])
        self.assertEqual(receipt['knowledge_headings'], {'K-01': '表示甲', 'K-02': '表示乙'})
        receipt['knowledge_headings']['K-01'] = '表示乙'
        write_json(self.course / section['receipt'], receipt)
        result = lessons.commit(self.course, 'L-01')
        self.assertIn('Cannot change completed checkpoint headings', result['error'])

    def test_bounded_input_contains_whole_unit_and_disjoint_exercise_pools(self):
        self.grouped()
        bounded_pipeline.enable(self.course)
        lessons.prepare(self.course)
        row = self.lesson_row('L-01'); pools = []
        for section in row['sections']:
            spec = read_json(self.course / section['bounded_spec'])
            contract = read_json(self.course / next(p for p in spec['inputs'] if p.endswith('writer-contract.json')))
            local_units = contract['teaching_units']
            self.assertTrue(Path(local_units['policy']).is_relative_to(self.course))
            self.assertIn(Path(local_units['policy']).relative_to(self.course).as_posix(), spec['inputs'])
            pools.extend(e['id'] for e in contract['reserved_exercises'])
            if section['kind'] == 'knowledge':
                self.assertEqual(spec['knowledge_ids'], ['K-01', 'K-02'])
                self.assertEqual(local_units['units'][0]['goals'], unit()['goals'])
        self.assertEqual(len(pools), len(set(pools)))

    def test_grouped_bounded_tasks_fit_budget_and_commit_after_reviews(self):
        # Real runtime gates with synthetic receipts, not real teaching-effect evidence.
        from bounded_fixture import BoundedPipelineTests
        self.grouped(); bounded_pipeline.enable(self.course); lessons.prepare(self.course)
        row = self.lesson_row('L-01'); self.write_group(row)
        rig = BoundedPipelineTests(); rig.course = self.course
        try:
            runtime = rig.runtime(); rig.plan(runtime, row)
            paths = []
            for section in row['sections']:
                task = 'unit-' + section['id']
                bounded_pipeline.create_section_task(self.course, 'L-01', section['id'], 'fixture-writer', task)
                path = section['directory'] + '/001.md'
                rig.approve(runtime, task, self.course / path)
                paths.append(path)
            rig.register_sessions(runtime, 'global')
            expected = {'goals': paths}
            for number, (left, right) in enumerate(zip(row['sections'], row['sections'][1:])):
                expected[left['id'] + '-' + right['id']] = paths[number:number + 2]
            for scope, inputs in expected.items():
                report_path = row['folder'] + '/bounded/reviews/' + scope + '.json'
                write_json(self.course / report_path, dict(lesson_id=row['id'], scope=scope,
                           input_hash=row['input_hash'], chunk_hashes={p: sha256(self.course / p) for p in inputs},
                           status='passed', issues=[]))
                task = 'global-' + scope
                runtime.create_task(task, 'quality', inputs + [row['blueprint']],
                                    {'scope': scope, 'lesson': row['id']}, 'global-writer')
                rig.approve(runtime, task, self.course / report_path, prefix='global')
            outcome = lessons.commit(self.course, 'L-01')
            self.assertIsNone(outcome['failure_kind'], outcome)
            self.assertEqual(lessons.check(self.course), [])
        finally:
            rig.doCleanups()

    def test_card_plan_and_snapshot_track_unit_design(self):
        row = self.grouped(); self.write_group(row)
        outcome = lessons.commit(self.course, 'L-01')
        self.assertIsNone(outcome['failure_kind'], outcome)
        atomic_text(self.course / '_工作区/核心候选.jsonl',
                    json.dumps({'concept_key': 'combined', 'knowledge_ids': ['K-01', 'K-02'], 'reason': '共同方法'}) + '\n')
        cards.prepare(self.course)
        plan = read_json(self.course / '_工作区/核心卡片计划.json')
        self.assertEqual(plan['teaching_units']['L-01']['units'][0]['knowledge_ids'], ['K-01', 'K-02'])
        before = cards.inputs(self.course)
        config = read_json(self.course / units.CONFIG)
        config['lessons']['L-01']['units'][0]['depth'] = 'deep'
        write_json(self.course / units.CONFIG, config)
        self.assertTrue(any('stale' in e for e in lessons.check(self.course)))
        self.assertNotEqual(before['teaching_units'], cards.inputs(self.course)['teaching_units'])

    def test_refresh_cannot_bypass_changed_teaching_plan(self):
        row = self.grouped(); self.write_group(row)
        self.assertIsNone(lessons.commit(self.course, 'L-01')['failure_kind'])
        before = (self.course / lessons.LEDGER).read_bytes()
        config = read_json(self.course / units.CONFIG)
        config['lessons']['L-01']['units'][0]['depth'] = 'deep'
        write_json(self.course / units.CONFIG, config)
        with self.assertRaisesRegex(ValueError, 'refresh cannot replace'):
            lessons.refresh(self.course)
        self.assertEqual((self.course / lessons.LEDGER).read_bytes(), before)


class StudioTests(unittest.TestCase):
    setUp = support.V2Tests.setUp
    tearDown = support.V2Tests.tearDown
    knowledge = support.V2Tests.knowledge

    def configure(self):
        config = {'schema_version': 1, 'lessons': {
            'L-01': {'units': [unit(['K-01'])]},
            'L-02': {'units': [unit(['K-02'])]}}}
        write_json(self.course / units.CONFIG, config)
        return config

    def test_reports_legacy_chapters_without_creating_configuration(self):
        self.knowledge(2)
        plan, report = studio.inspect(self.course, 'L-01')
        self.assertFalse(plan['configured'])
        self.assertEqual(report['legacy_lessons'], ['L-01', 'L-02'])
        self.assertFalse((self.course / units.CONFIG).exists())

    def test_resolves_actual_assignments_and_checks_other_chapters(self):
        self.knowledge(2)
        config = self.configure()
        plan, report = studio.inspect(self.course, 'L-01')
        self.assertEqual(plan['units'][0]['knowledge_ids'], ['K-01'])
        self.assertEqual(report['configured_lessons'], ['L-01', 'L-02'])
        config['lessons']['L-02']['units'][0]['knowledge_ids'] = ['K-01']
        write_json(self.course / units.CONFIG, config)
        with self.assertRaisesRegex(ValueError, 'Foreign/duplicate'):
            studio.inspect(self.course, 'L-01')

    def test_rejects_unknown_lessons_and_unverified_assignments(self):
        self.knowledge(2)
        self.configure()
        with self.assertRaisesRegex(ValueError, 'Unknown teaching unit lesson'):
            studio.inspect(self.course, 'L-99')
        records = read_jsonl(self.course / '_工作区/知识索引.jsonl')
        records[1]['status'] = 'draft'
        atomic_text(self.course / '_工作区/知识索引.jsonl', ''.join(json.dumps(row) + '\n' for row in records))
        with self.assertRaisesRegex(ValueError, 'verified assigned knowledge: L-02'):
            studio.inspect(self.course, 'L-01')

    def test_requires_real_indexes_and_unique_knowledge(self):
        self.course.mkdir()
        with self.assertRaises((ValueError, OSError)):
            studio.inspect(self.course)
        self.knowledge(2)
        records = read_jsonl(self.course / '_工作区/知识索引.jsonl')
        records.append(records[0])
        atomic_text(self.course / '_工作区/知识索引.jsonl', ''.join(json.dumps(row) + '\n' for row in records))
        with self.assertRaisesRegex(ValueError, 'Duplicate teaching unit knowledge'):
            studio.inspect(self.course)


if __name__ == '__main__':
    unittest.main()
