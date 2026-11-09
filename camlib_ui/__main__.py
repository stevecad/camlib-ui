"""camlib-ui [--projects DIR] [--host HOST] [--port PORT] [--camlib-posts DIR]: serves the interface and its API."""
from __future__ import annotations

import argparse
import os
from pathlib import Path


def main(argv=None):
    parser = argparse.ArgumentParser(prog="camlib-ui", description=__doc__)
    parser.add_argument("--projects", type=Path, default=Path(os.environ.get("CAMLIB_UI_PROJECTS", "camlib-projects")),
                        help="the projects directory (made, with the examples, when it is empty; default ./camlib-projects)")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1: this machine only)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--camlib-posts", type=Path, default=None,
                        help="camlib's controller posts: a camlib checkout's examples/ directory (or $CAMLIB_POSTS)")
    parser.add_argument("--timeout", type=int, default=900, help="a build's time limit in seconds (default 900)")
    args = parser.parse_args(argv)
    if args.camlib_posts is not None:
        os.environ["CAMLIB_POSTS"] = str(args.camlib_posts.expanduser().resolve())
    try:
        import camlib  # noqa: F401
    except ImportError:
        parser.error("camlib isn't installed in this Python: pip install <your camlib checkout> (see README.md).")
    import uvicorn

    from .server import create_app
    app = create_app(args.projects.expanduser(), timeout=args.timeout)
    print(f"camlib-ui: http://{args.host}:{args.port}  (projects: {args.projects.expanduser().resolve()}, "
          f"posts: {os.environ.get('CAMLIB_POSTS') or 'linuxcnc only: set --camlib-posts'})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
