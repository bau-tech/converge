# Third-party licenses

This project's own code is MIT-licensed (see the root `LICENSE` file). This
document is independent of that choice — it records what license each
dependency ships under today, based on an audit of `bim-normalizer/requirements.txt`,
`package.json`, and `bim-normalizer/Dockerfile`.

No *Python or npm dependency* here is AGPL or GPL — that part of the audit
holds: the strongest copyleft among actual library dependencies is
LGPL-3.0 and MPL-2.0, both used only as ordinary dependencies/subprocess
calls, never modified or forked in this repo, so neither imposes any
licensing obligation on this project's own code.

That said, two GPL-licensed **command-line tools** (not Python/npm
libraries — installed/compiled at the OS level) are bundled into the
published `bim-normalizer` Docker image and invoked from Python as
separate subprocesses, never linked into this project's own code — see
"Bundled GPL command-line tools" below. Under the standard GPL "mere
aggregation" principle (arm's-length invocation via a subprocess call,
not shared-memory/library linking), this doesn't require this project's
own code to be GPL-licensed as a whole — but distributing the compiled
binaries themselves inside a published image still carries GPL's own
source-availability and notice obligations, which is what that section
covers. This isn't a substitute for a real legal review given the image
is published publicly (GHCR/Docker Hub).

## Python (`bim-normalizer/`)

| Package | License |
|---|---|
| fastapi | MIT |
| mcp | MIT |
| pyjwt | MIT |
| pydantic | MIT |
| uvicorn | BSD |
| httpx | BSD |
| python-dotenv | BSD |
| numpy | BSD-3-Clause |
| ezdxf | MIT |
| matplotlib | PSF-based (BSD-compatible) |
| specklepy | Apache-2.0 |
| requests | Apache-2.0 |
| bcrypt | Apache-2.0 |
| python-multipart | Apache-2.0 |
| fastembed | Apache-2.0 |
| embedding model (`BAAI/bge-small-en-v1.5`, downloaded at runtime by fastembed) | MIT |
| psycopg2-binary | LGPL-3.0 with the standard psycopg2 linking exception (explicitly permits use without requiring this project to be LGPL) |
| ifcopenshell | LGPL-3.0-or-later |
| ifc5d | LGPL-3.0-or-later |
| ifctester | LGPL-3.0-or-later |
| ifcclash | LGPL-3.0-or-later |

## Bundled GPL command-line tools (`bim-normalizer/Dockerfile`)

Neither of these is a Python/npm dependency — both are OS-level binaries,
invoked from Python via `subprocess`, never imported/linked as a library.

| Tool | License | Used for | Source |
|---|---|---|---|
| `dwg2dxf` (from [LibreDWG](https://github.com/LibreDWG/libredwg)) | GPL-3.0-or-later | `.dwg` → `.dxf` conversion for document preview (`bim-normalizer/dwg_convert.py`) — compiled from source in its own Dockerfile build stage, statically linked (`--disable-shared`), only the resulting binary copied into the final image | Pinned release tarball, see `ARG LIBREDWG_VERSION` in the Dockerfile — `https://github.com/LibreDWG/libredwg/releases/download/<version>/libredwg-<version>.tar.gz` |
| `pdftoppm` (from `poppler-utils`) | GPL-2.0-or-later | First-page PDF thumbnail rendering, a fallback for PDFs Nextcloud's own preview provider can't handle (`bim-normalizer/pdf_thumbnail.py`) | Installed via `apt-get install poppler-utils` from Debian's own package repositories (the base image is `python:3.11-slim`, itself Debian-based) — corresponding source is Debian's standard `deb-src` channel for whichever Debian release the base image tracks |

## Frontend

| Package | License |
|---|---|
| react | MIT |
| react-dom | MIT |
| three | MIT |
| @dnd-kit/core | MIT |
| @dnd-kit/sortable | MIT |
| @dnd-kit/utilities | MIT |
| @xyflow/react | MIT |
| framer-motion | MIT |
| konva | MIT |
| react-konva | MIT |
| react-grid-layout | MIT |
| react-markdown | MIT |
| react-resizable-panels | MIT |
| esbuild | MIT |
| @speckle/viewer | Apache-2.0 |
| echarts | Apache-2.0 |
| docx-preview | Apache-2.0 |
| xlsx | Apache-2.0 |
| lucide-react | ISC |
| web-ifc | MPL-2.0 (file-level copyleft — only applies to modifications of web-ifc's own source files, not to code that merely imports it) |
| dxf-viewer | MPL-2.0 (file-level copyleft, same terms as web-ifc above — brings in its own nested `three@^0.161.0`, separate from the project's own pinned `three@0.140.2` used by @speckle/viewer/IfcCanvas.jsx, since the version ranges don't overlap; a bundle-size cost, not a licensing one) |

## Bundled assets

| Asset | License |
|---|---|
| `public/fonts/Roboto-Regular.ttf` (used by dxf-viewer for DXF text rendering) | Apache-2.0 (Google Fonts) |
