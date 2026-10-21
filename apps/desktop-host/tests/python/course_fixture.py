"""Synthetic course inputs adapted from the original skill regression fixtures."""
from pathlib import Path
import json
import tempfile
import unittest
from _common import atomic_text, read_json, write_json
from inventory_materials import inventory
import convert_materials as cm
import lesson_tasks as lessons
import obsidian_links as links
from assemble_knowledge import build_content


class V2Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.course = self.root / 'course'

    def tearDown(self): self.tmp.cleanup()

    def knowledge(self, n=8):
        source = self.root / 'book.txt'; source.write_text('A concept.', encoding='utf-8')
        inventory(self.course, [source]); cm.prepare(self.course); cm.assemble(self.course)
        atomic_text(self.course / '学习需求.md', '# 学习需求\n基础学习')
        steps = '\n'.join(
            f'<!-- BL-STEP:BEGIN P-MAIN-S{i:03d} -->\n\n## 第{i}阶段\n\nP-MAIN-S{i:03d} ^P-MAIN-S{i:03d}\n\n'
            f'目标：掌握概念{i}\n\n<!-- BL-STEP:END P-MAIN-S{i:03d} -->\n' for i in range(1, n + 1))
        atomic_text(self.course / '学习路径.md',
                    '<!-- BL-PATH:BEGIN P-MAIN -->\n\n# 学习路径\n\nP-MAIN ^P-MAIN\n\n按序学习\n\n'
                    + steps + '\n<!-- BL-PATH:END P-MAIN -->\n')
        write_json(self.course / '_工作区/路径索引.json',
                   {'path_id': 'P-MAIN', 'title': '完整路线',
                    'steps': [{'id': f'P-MAIN-S{i:03d}', 'title': f'第{i}阶段', 'order': i,
                               'lessons': [f'L-{i:02d}']} for i in range(1, n + 1)]})
        atomic_text(self.course / '开始学习.md',
                    '<!-- BL-START:BEGIN START -->\n\n# 开始学习\n\nSTART ^START\n\n先看路线。\n\n'
                    '<!-- BL-START:END START -->\n')
        chapter = '_工作区/章节知识/KC-01.md'
        items = [{'id': f'K-{i:02d}', 'title': f'概念{i}', 'chapter_id': 'KC-01', 'anchor': f'K-{i:02d}',
                  'status': 'verified', 'kind': 'material', 'source_refs': [{'source_id':'SRC-001','unit_id':'U00001'}],
                  'lesson_ids': [f'L-{i:02d}'], 'prerequisites': [], 'core': False} for i in range(1,n+1)]
        definitions = [{'id': f'L-{i:02d}', 'title': f'章节{i}', 'order': i, 'path': f'学习文档/{i:02d}-章节.md',
                        'path_excerpt': f'第{i}章目标', 'status': 'pending'} for i in range(1,n+1)]
        write_json(self.course / '_工作区/章节索引.json', {'chapters':[{'id':'KC-01','title':'知识','order':1,'status':'complete','path':chapter}], 'lessons': definitions})
        atomic_text(self.course / chapter, '\n'.join(
            f'<!-- BL-K:BEGIN K-{i:02d} -->\n\n## 概念{i}\n\nK-{i:02d} ^K-{i:02d}\n\n概念内容{i}\n\n'
            f'<!-- BL-K:END K-{i:02d} -->\n' for i in range(1, n+1)))
        atomic_text(self.course / '_工作区/知识索引.jsonl', ''.join(json.dumps(k,ensure_ascii=False)+'\n' for k in items))
        links.build_map(self.course)
        atomic_text(self.course / '知识内容.md', build_content(self.course))
        lessons.prepare(self.course)

    def lesson_row(self, lesson_id):
        data = read_json(self.course / lessons.LEDGER)
        return next(l for l in data['lessons'] if l['id'] == lesson_id)

    def write_lesson(self, lesson_id, extra=''):
        """Main-agent equivalent: write every section chunk and the result receipt."""
        row = self.lesson_row(lesson_id)
        manifest = read_json(self.course / row['manifest'])
        body = (f'---\ntype: lesson\nid: {row["id"]}\ntitle: 测试\norder: {row["order"]}\n'
                'status: complete\n---\n# 讲义\n')
        for section in row['sections']:
            if section['kind'] == 'intro':
                content = body.split('# 讲义')[0] + '# 讲义\n'
            elif section['kind'] == 'closing':
                content = '## 章末\n测试复习与来源' + extra
            else:
                content = '\n'.join('## 小节\n\n教学解释\n' + manifest['links']['knowledge'][kid]
                                    for kid in section['knowledge_ids'])
            atomic_text(self.course / section['directory'] / '001.md', content)
            write_json(self.course / section['receipt'], {'schema_version': 1, 'section_id': section['id'],
                                                          'status': 'complete', 'files': ['001.md']})
        write_json(self.course / row['result'], {'status': 'complete', 'lesson_id': row['id'],
                                                 'knowledge_ids': row['knowledge_ids']})
        return row
