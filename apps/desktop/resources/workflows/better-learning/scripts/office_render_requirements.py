"""List Office parts requiring full-page visual evidence, using the extraction detector."""

import argparse
import json
from pathlib import Path

from _common import extraction_path, source_index
from extract_materials import Reader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', required=True, type=Path)
    args = parser.parse_args()
    course = args.course.resolve()
    result = []
    for source in source_index(course)['sources']:
        if source['format'] not in {'docx', 'pptx'}:
            continue
        options = argparse.Namespace(max_chars=10000, scale=3, office_renders={})
        reader = Reader(source, extraction_path(course, source), course, options)
        try:
            if reader.error:
                raise ValueError(f"{source['id']}: {reader.error}")
            parts = list(dict.fromkeys(item['part'] for item in reader.mixed_units
                                       if item.get('render_required')))
            if not parts:
                continue
            if source['format'] == 'pptx' and any(part not in reader.parts for part in parts):
                raise ValueError(f"{source['id']}: a notes-only visual part cannot be mapped to a slide page")
            result.append({'id': source['id'], 'path': source['path'], 'sha256': source['sha256'],
                           'format': source['format'], 'parts': parts,
                           'slide_order': reader.parts if source['format'] == 'pptx' else []})
        finally:
            reader.close()
    print(json.dumps({'sources': result}, ensure_ascii=False))


if __name__ == '__main__':
    main()
