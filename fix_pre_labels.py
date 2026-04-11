import os, re

base = 'local-dev-test-repo/tests/collections'
fixed = []

JS_LINE = re.compile(r'^  (const |let |var |if \(|ctx\.|await |for \(|\/\/)')
TOP_KEY  = re.compile(r'^([a-zA-Z_][a-zA-Z_0-9]*):')
SCRIPT_KEYS = {'pre', 'post', 'setup', 'teardown'}

for root, dirs, files in os.walk(base):
    for fname in sorted(files):
        if not fname.endswith('.yaml'):
            continue
        path = os.path.join(root, fname)
        with open(path) as f:
            lines = f.readlines()

        new_lines = []
        prev_key = None
        changed = False

        for line in lines:
            stripped = line.rstrip()
            m = TOP_KEY.match(stripped)
            if m:
                prev_key = m.group(1)
            if JS_LINE.match(stripped) and prev_key not in SCRIPT_KEYS:
                new_lines.append('pre: |\n')
                prev_key = 'pre'
                changed = True
            new_lines.append(line)

        if changed:
            with open(path, 'w') as f:
                f.writelines(new_lines)
            fixed.append(path)

for p in fixed:
    print('fixed:', p)
print(f'\nTotal: {len(fixed)} files patched')
