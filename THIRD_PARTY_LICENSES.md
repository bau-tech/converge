# Third-party licenses

This project's own code is MIT-licensed (see the root `LICENSE` file). This
document is independent of that choice — it records what license each
dependency ships under today, based on an audit of `bim-normalizer/requirements.txt`
and `package.json`.

No dependency here is AGPL or GPL. The strongest copyleft present is
LGPL-3.0 and MPL-2.0, both used only as ordinary dependencies/subprocess
calls — none of them are modified or forked in this repo, so neither
imposes any licensing obligation on this project's own code.

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
