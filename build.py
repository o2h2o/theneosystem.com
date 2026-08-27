#!/usr/bin/env python3
"""Rebuild theneosystem.com/index.html from weekly-planner/index.html.

The combined page embeds each app as a JSON string that it hands to an iframe's
srcdoc. This rewrites only the plannerHTML line; ledgerHTML and the surrounding
page (nav, login, sync glue) are left exactly as they are.

Run from the repo's parent directory:  python3 theneosystem.com/build.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'weekly-planner', 'index.html')
OUT = os.path.join(ROOT, 'theneosystem.com', 'index.html')

with open(SRC) as f:
    planner = f.read()

# json.dumps does not escape '/', so a literal </script> inside the embedded
# source would end the outer <script> block and blank the page. Escaping it as
# <\/script> is still valid JS and invisible to the HTML parser.
encoded = json.dumps(planner).replace('</', '<\\/')

with open(OUT) as f:
    combined = f.read()

pattern = r'const plannerHTML = ".*";'
if len(re.findall(pattern, combined)) != 1:
    sys.exit('expected exactly one plannerHTML assignment')

# A lambda replacement is passed through literally; a plain string would have
# its backslash escapes (─ and friends) reinterpreted by re.sub.
combined = re.sub(pattern, lambda m: f'const plannerHTML = {encoded};', combined, count=1)

with open(OUT, 'w') as f:
    f.write(combined)

print(f'built {OUT} ({len(combined)} chars, planner {len(planner)})')
