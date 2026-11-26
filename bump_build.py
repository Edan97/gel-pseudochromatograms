"""Raise the page's build number everywhere it's kept, so open copies of the page notice the update.

Run after changing app.js, style.css or index.html, before committing:
  python3 bump_build.py
"""
import json
import re
from pathlib import Path

here = Path(__file__).resolve().parent
build = json.loads((here / "build.json").read_text())["build"] + 1
(here / "build.json").write_text(json.dumps({"build": build}) + "\n")
app = here / "app.js"
app.write_text(re.sub(r"const BUILD = \d+;", f"const BUILD = {build};", app.read_text(), count=1))
idx = here / "index.html"
html = re.sub(r"app\.js\?v=\d+", f"app.js?v={build}", idx.read_text())
idx.write_text(re.sub(r"style\.css\?v=\d+", f"style.css?v={build}", html))
print(f"build {build}")
