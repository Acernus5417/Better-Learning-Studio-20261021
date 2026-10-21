"""Selective pedagogy, inheritance, snapshot freshness and bounded delivery."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'apps/desktop/resources/workflows/better-learning/scripts'))
from _common import read_json, write_json
import teaching_design as design
import lesson_tasks as lessons
import core_cards as cards
import bounded_pipeline
import studio_teaching_design as studio
import course_fixture as support


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.course = Path(self.temp.name)

    def config(self, **kwargs):
        data = {'schema_version': 1, 'default': {'subject': 'statistics',
                'secondary_subjects': ['life-science'], 'modules': ['data-analysis'],
                'mode': 'research', 'level': '本科', 'reason': '研究推断任务'},
                'lessons': {}}
        data.update(kwargs)
        write_json(self.course / design.CONFIG, data)
        return data

    def test_all_catalogued_resources_exist(self):
        result = design.check()
        self.assertEqual((result['subjects'], result['modules'], result['modes']), (22, 9, 4))

    def test_old_course_compatibility_is_explicit(self):
        resolved = design.resolve(self.course, 'L-01', ['K-01'])
        self.assertFalse(resolved['configured'])
        self.assertEqual(resolved['lesson']['selection']['subject'], 'generic')
        self.assertNotIn('subject:history', {r['id'] for r in resolved['lesson']['resources']})
        self.assertFalse((self.course / design.CONFIG).exists())

    def test_cross_subject_chapter_and_knowledge_overrides(self):
        self.config(lessons={'L-02': {'modules': ['proof'], 'reason': '性质推导',
                     'knowledge_overrides': {'K-02': {'modules': [], 'mode': 'practice'}}}})
        resolved = design.resolve(self.course, 'L-02', ['K-01', 'K-02'])
        self.assertEqual(resolved['lesson']['selection']['modules'], ['proof'])
        self.assertEqual(resolved['lesson']['selection']['secondary_subjects'], ['life-science'])
        self.assertEqual(resolved['knowledge']['K-02']['selection']['modules'], [])
        self.assertEqual(resolved['knowledge']['K-02']['selection']['mode'], 'practice')
        self.assertNotIn('K-01', resolved['knowledge'])

    def test_unknown_fields_ids_and_unassigned_knowledge_fail(self):
        for spec in [{'subject': 'mathematic'}, {'subject': 'history', 'moduls': []},
                     {'subject': 'history', 'modules': ['unknown']},
                     {'subject': 'history', 'secondary_subjects': ['history']},
                     {'subject': 'history', 'modules': ['proof', 'proof']}]:
            with self.subTest(spec=spec):
                self.config(default=spec)
                with self.assertRaises(ValueError):
                    design.resolve(self.course, 'L-01', ['K-01'])
        self.config(lessons={'L-01': {'knowledge_overrides': {'K-99': {'mode': 'practice'}}}})
        with self.assertRaisesRegex(ValueError, 'not assigned'):
            design.resolve(self.course, 'L-01', ['K-01'])
        write_json(self.course / '_工作区/章节索引.json', {'lessons': [{'id': 'L-02'}]})
        with self.assertRaisesRegex(ValueError, 'unknown lessons'):
            design.resolve(self.course, 'L-02', [])
        self.config()
        with self.assertRaisesRegex(ValueError, 'Unknown teaching lesson ID'):
            design.resolve(self.course, 'L-99', [])

    def test_other_chapter_changes_do_not_invalidate_current_chapter(self):
        config = self.config(lessons={'L-02': {'mode': 'exam'}})
        before = design.fingerprint(design.resolve(self.course, 'L-01', ['K-01']))
        config['lessons']['L-02']['mode'] = 'practice'
        write_json(self.course / design.CONFIG, config)
        self.assertEqual(before, design.fingerprint(design.resolve(self.course, 'L-01', ['K-01'])))
        config['default']['modules'] = ['proof']
        write_json(self.course / design.CONFIG, config)
        self.assertNotEqual(before, design.fingerprint(design.resolve(self.course, 'L-01', ['K-01'])))

    def test_only_selected_template_changes_invalidate_selection(self):
        self.config()
        before = design.fingerprint(design.resolve(self.course, 'L-01', ['K-01']))
        actual_hash = design.sha256
        for name, should_change in [('history.md', False), ('statistics.md', True),
                                    ('data-analysis.md', True), ('research.md', True)]:
            with self.subTest(name=name):
                with patch.object(design, 'sha256', side_effect=lambda p: 'changed' if p.name == name else actual_hash(p)):
                    after = design.fingerprint(design.resolve(self.course, 'L-01', ['K-01']))
                self.assertEqual(before != after, should_change)


class PipelineTests(unittest.TestCase):
    setUp = support.V2Tests.setUp
    tearDown = support.V2Tests.tearDown
    knowledge = support.V2Tests.knowledge
    lesson_row = support.V2Tests.lesson_row
    write_lesson = support.V2Tests.write_lesson

    def config(self):
        write_json(self.course / design.CONFIG, {'schema_version': 1,
                   'default': {'subject': 'history', 'modules': ['text-evidence']},
                   'lessons': {'L-01': {'knowledge_overrides': {'K-01': {'subject': 'philosophy'}}}}})

    def test_prepare_delivers_selected_resources_and_card_freshness(self):
        self.knowledge(1)
        self.config()
        lessons.prepare(self.course)
        row = self.lesson_row('L-01')
        manifest = read_json(self.course / row['manifest'])
        self.assertEqual(manifest['teaching_design']['lesson']['selection']['subject'], 'history')
        self.assertEqual(manifest['teaching_design']['knowledge']['K-01']['selection']['subject'], 'philosophy')
        for item in [manifest['teaching_design']['lesson'], manifest['teaching_design']['knowledge']['K-01']]:
            self.assertTrue(all(Path(r['path']).is_file() for r in item['resources']))
        self.write_lesson('L-01')
        self.assertIsNone(lessons.commit(self.course, 'L-01')['failure_kind'])
        self.assertEqual(lessons.check(self.course), [])
        candidate = self.course / '_工作区/核心候选.jsonl'
        candidate.write_text('{"concept_key":"concept-one","knowledge_ids":["K-01"],"reason":"核心方法"}\n', encoding='utf-8')
        cards.prepare(self.course)
        plan = read_json(self.course / '_工作区/核心卡片计划.json')
        self.assertEqual(plan['teaching_designs']['L-01']['lesson']['selection']['subject'], 'history')
        before = cards.inputs(self.course)
        config = read_json(self.course / design.CONFIG)
        config['default']['mode'] = 'exam'
        write_json(self.course / design.CONFIG, config)
        self.assertTrue(any('stale' in e for e in lessons.check(self.course)))
        self.assertNotEqual(before['teaching_designs'], cards.inputs(self.course)['teaching_designs'])

    def test_bounded_tasks_have_local_selected_template_inputs(self):
        self.knowledge(1)
        self.config()
        bounded_pipeline.enable(self.course)
        lessons.prepare(self.course)
        row = self.lesson_row('L-01')
        for section in row['sections']:
            spec = read_json(self.course / section['bounded_spec'])
            file = next(p for p in spec['inputs'] if p.endswith('writer-contract.json'))
            teaching = read_json(self.course / file)['teaching_design']
            if section['kind'] == 'knowledge':
                self.assertIn('K-01', teaching['knowledge'])
            else:
                self.assertEqual(teaching['knowledge'], {})
            for item in [teaching['lesson']] + list(teaching['knowledge'].values()):
                for resource in item['resources']:
                    local = Path(resource['path'])
                    self.assertTrue(local.is_relative_to(self.course))
                    self.assertIn(local.relative_to(self.course).as_posix(), spec['inputs'])
                    self.assertEqual(resource['sha256'], design.sha256(local))


class StudioTests(unittest.TestCase):
    """The native workflow checks every override using durable course assignments."""

    setUp = SelectionTests.setUp
    config = SelectionTests.config

    def test_native_validation_requires_explicit_config_but_read_is_compatible(self):
        resolved, report = studio.inspect(self.course)
        self.assertFalse(resolved['configured'])
        self.assertFalse(report['configured'])
        with self.assertRaisesRegex(ValueError, '教学设计.json'):
            studio.inspect(self.course, require_config=True)
        self.config()
        self.assertTrue(studio.inspect(self.course, require_config=True)[1]['ok'])

    def test_default_lookup_cannot_hide_an_invalid_override_in_another_lesson(self):
        self.config(lessons={'L-02': {'knowledge_overrides': {'K-01': {'mode': 'practice'}}}})
        write_json(self.course / '_工作区/章节索引.json', {'lessons': [{'id': 'L-01'}, {'id': 'L-02'}]})
        (self.course / '_工作区/知识索引.jsonl').write_text(
            '{"id":"K-01","lesson_ids":["L-01"],"status":"verified"}\n', encoding='utf-8')
        for lid in (None, 'L-01', 'L-02'):
            with self.subTest(lesson=lid), self.assertRaisesRegex(ValueError, 'not assigned'):
                studio.inspect(self.course, lid)

    def test_overrides_need_actual_indexes_and_reject_merged_knowledge(self):
        self.config(lessons={'L-01': {'knowledge_overrides': {'K-01': {'mode': 'practice'}}}})
        with self.assertRaisesRegex(ValueError, 'require the saved lesson index'):
            studio.inspect(self.course)
        write_json(self.course / '_工作区/章节索引.json', {'lessons': [{'id': 'L-01'}]})
        index = self.course / '_工作区/知识索引.jsonl'
        index.write_text('{"id":"K-01","lesson_ids":["L-01"],"status":"merged"}\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'not assigned'):
            studio.inspect(self.course, 'L-01')
        index.write_text('{"id":"K-01","lesson_ids":["L-01"],"status":"verified"}\n', encoding='utf-8')
        resolved, report = studio.inspect(self.course, 'L-01')
        self.assertEqual(resolved['knowledge']['K-01']['selection']['mode'], 'practice')
        self.assertEqual(report['lessons'], 1)
        self.assertEqual(report['fingerprints']['lessons']['L-01'], design.fingerprint(resolved))

    def test_unknown_requested_lesson_and_malformed_indexes_fail(self):
        self.config()
        with self.assertRaisesRegex(ValueError, 'Unknown teaching lesson ID'):
            studio.inspect(self.course, 'L-99')
        write_json(self.course / '_工作区/章节索引.json', {'lessons': ['L-01']})
        with self.assertRaisesRegex(ValueError, 'Invalid teaching lesson index'):
            studio.inspect(self.course)


if __name__ == '__main__':
    unittest.main()
