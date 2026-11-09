"""python -m camlib_ui.build <request.json>: one build (camlib_ui/build/run.py)."""
import sys

from camlib_ui.build.run import main

sys.exit(main(sys.argv[1]))
