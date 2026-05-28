import os
import glob
import getpass
import json
import duckdb

DB_PATH = '/data/aura.duckdb'
LOGS_DIR = '/logs/claude'

person_id = getpass.getuser()

# Try to get person name from people.json
people_file = os.path.expanduser('~/.aura/people.json')
person_name = person_id
if os.path.exists(people_file):
    try:
        data = json.load(open(people_file))
        person_name = data.get(person_id, person_id)
    except Exception:
        pass

conn = duckdb.connect(DB_PATH)

files = glob.glob(os.path.join(LOGS_DIR, '**', '*.jsonl'), recursive=True)
print(f'Found {len(files)} JSONL files')

inserted = 0
for file_path in files:
    session_id = os.path.basename(os.path.dirname(file_path))

    # Extract session title from first user message
    session_title = None
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get('type') == 'user' and isinstance(obj.get('message'), dict):
                        content = obj['message'].get('content', '')
                        if isinstance(content, str) and content.strip():
                            session_title = content.strip()[:80]
                            break
                        elif isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get('type') == 'text':
                                    text = block.get('text', '').strip()
                                    if text:
                                        session_title = text[:80]
                                        break
                            if session_title:
                                break
                except Exception:
                    continue
    except Exception:
        pass

    try:
        conn.execute("""
            INSERT INTO session_meta (session_id, person_id, person_name, session_title, commits)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (session_id) DO NOTHING
        """, [session_id, person_id, person_name, session_title])
        inserted += 1
    except Exception as e:
        print(f'Error inserting {session_id}: {e}')

print(f'Inserted {inserted} session_meta rows')
conn.close()
