"""Packaging verifies change metadata, not every file's SHA-256 again."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from _common import write_json, read_json
from package_receipt import record_snapshot, packaged_report, require_final
from validate_package import validate


class PackageReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.course = Path(self.tmp.name) / 'course'
        self.course.mkdir()
        (self.course / 'intro.md').write_text('# Intro\n\n[Other](other.md)', encoding='utf-8')
        (self.course / 'other.md').write_text('# Other', encoding='utf-8')
        write_json(self.course / '_工作区/结构检查.json',
                   {'mode': 'final', 'passed': True, 'counts': {'lessons': 2}})

    def tearDown(self):
        self.tmp.cleanup()

    def test_final_receipt_detects_same_size_edits_and_replacements(self):
        record_snapshot(self.course)
        self.assertTrue(require_final(self.course)['passed'])
        (self.course / 'other.md').write_text('# Edits', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'STALE_MANIFEST'):
            require_final(self.course)

    def test_packaged_pass_does_not_hash_or_read_markdown_contents(self):
        record_snapshot(self.course, 'packaged', links_checked=True)
        with patch('_common._sha256', side_effect=AssertionError('unexpected content hash')), \
             patch.object(Path, 'read_bytes', side_effect=AssertionError('unexpected file bytes')):
            result = validate(self.course, 'packaged')
        self.assertTrue(result['passed'], result)
        self.assertEqual(result['integrity'], 'metadata-v1')

    def test_missing_or_added_deliverable_invalidates_receipt(self):
        record_snapshot(self.course, 'packaged', links_checked=True)
        (self.course / 'new.md').write_text('# New', encoding='utf-8')
        self.assertFalse(packaged_report(self.course)['passed'])
        (self.course / 'new.md').unlink()
        (self.course / 'other.md').unlink()
        self.assertFalse(packaged_report(self.course)['passed'])

    def test_notes_do_not_invalidate_delivery(self):
        record_snapshot(self.course, 'packaged', links_checked=True)
        notes = self.course / '笔记'
        notes.mkdir()
        (notes / 'intro-笔记.md').write_text('My notes', encoding='utf-8')
        self.assertTrue(packaged_report(self.course)['passed'])

    def test_requires_post_relocation_link_audit(self):
        record_snapshot(self.course, 'packaged')
        self.assertFalse(packaged_report(self.course)['passed'])

    def test_old_hash_receipt_requests_one_final_upgrade(self):
        write_json(self.course / '_工作区/链接校验报告.json',
                   {'schema_version': 1, 'mode': 'packaged', 'files': {'intro.md': 'old-hash'}})
        result = packaged_report(self.course)
        self.assertFalse(result['passed'])
        self.assertIn('final', ' '.join(result['errors']))

    def test_control_change_invalidates_receipt(self):
        write_json(self.course / '_工作区/质量回执.json', {'approved': True})
        record_snapshot(self.course, 'packaged', links_checked=True)
        write_json(self.course / '_工作区/质量回执.json', {'approved': False})
        self.assertFalse(packaged_report(self.course)['passed'])

    def test_already_accepted_old_package_can_upgrade_without_removed_intermediates(self):
        write_json(self.course / '_工作区/链接校验报告.json',
                   {'schema_version': 1, 'mode': 'packaged', 'files': {'intro.md': 'old-hash', 'other.md': 'old-hash'}})
        write_json(self.course / '_工作区/打包回执.json', {'schema_version': 1, 'report': {'passed': True}})
        write_json(self.course / '_工作区/打包检查.json', {'mode': 'packaged', 'passed': True})
        with patch('_common._sha256', side_effect=AssertionError('unexpected old-package hash')):
            self.assertTrue(packaged_report(self.course)['passed'])
        self.assertTrue((self.course / '_工作区/链接校验报告.v1.json').exists())

    def test_package_reuses_final_acceptance_and_rebases_moved_documents(self):
        import convert_materials as materials
        (self.course / '学习需求.md').write_text('# Goal\n\n[Intro](intro.md)', encoding='utf-8')
        write_json(self.course / '_工作区/转写任务.json',
                   {'schema_version': 3, 'engine': 'host-subagent', 'sources': []})
        record_snapshot(self.course)
        with patch.object(materials, 'load', side_effect=AssertionError('unexpected source hash pass')), \
             patch.object(materials, 'check', side_effect=AssertionError('unexpected full revalidation')), \
             patch('_common._sha256', side_effect=AssertionError('unexpected global hash')):
            result = materials.package(self.course)
        self.assertTrue(result['packaged'])
        self.assertIn('[Intro](../intro.md)',
                      (self.course / '课程文档/学习需求.md').read_text(encoding='utf-8'))
        self.assertTrue(packaged_report(self.course)['passed'])

    def test_relocation_checks_only_the_changed_artifact(self):
        import quality_gates
        text = '# A\n\n[[intro#^K-01|Concept]]'
        (self.course / 'moved.md').write_text(text, encoding='utf-8')
        write_json(self.course / '_工作区/质量回执.json', {'artifacts': {
            'old.md': {'content_hash': quality_gates.content_hash(text)},
            'other.md': {'content_hash': quality_gates.content_hash('# Other')},
        }})
        with patch.object(quality_gates, 'enabled', return_value=True), \
             patch.object(quality_gates, 'content_hash', wraps=quality_gates.content_hash) as hash_content:
            quality_gates.relocate(self.course, {'old.md': 'moved.md'}, changed_paths={'moved.md'})
        self.assertEqual(hash_content.call_count, 1)


if __name__ == '__main__':
    unittest.main()

