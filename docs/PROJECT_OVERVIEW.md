# Converge Project Overview

## What is Converge?

Converge is a self-hosted BIM coordination, analytics, validation, and information-management platform.

It brings model data from multiple design and authoring applications into one workspace. Models are published through Speckle, ingested by Converge, normalized into a shared IFC-aligned PostgreSQL schema, and then made available for visualization, analysis, coordination, document control, and reporting.

Converge is designed to connect design information with the day-to-day work of coordination and delivery. It combines a 3D model viewer with model analytics, clash detection, information-requirement checking, issue management, document workflows, scheduling, quantity takeoff, model history, and natural-language access to BIM data.

## The problem it addresses

BIM information is often distributed across authoring tools, coordination applications, issue trackers, document platforms, spreadsheets, and separate databases. This makes it difficult to answer basic project questions consistently:

- What is in the current model?
- What changed since the previous version?
- Where are the clashes and who needs to resolve them?
- Does the model contain the information required by the project?
- Which documents are still being worked on, and which are approved for use?
- What quantities, materials, and objects are associated with a location or category?
- How does the planned schedule relate to the model?

Converge provides a shared data layer and a single coordination workspace for these questions.

## Supported model sources

Converge can ingest model data published through Speckle from:

- Revit
- Tekla Structures
- IFC
- Navisworks
- Blender
- Rhino
- Grasshopper

The ingestion pipeline detects the source application, flattens the Speckle object tree, classifies elements, extracts geometry and parameters, and stores the result in a common schema. Source-specific classification mappings and IFC-aligned categories make the resulting data easier to compare across disciplines and authoring tools.

## What can Converge do?

### 1. Explore models in 3D

The Speckle viewer provides interactive 3D visualization of the ingested model. Users can inspect elements, select objects, search by name or property, apply filters, and connect viewer selections to analytics and issue data.

The viewer also supports:

- Federated viewing of multiple models
- Element-level selection and inspection
- Filtered subsets of the model
- BCF viewpoints and issue pins
- Document and model-element relationships
- Timeline-driven model playback
- Visual comparison of model versions

### 2. Analyze model content

Converge converts normalized model data into dashboards and charts. Analytics can be grouped by fields such as:

- Category
- IFC class
- Storey or level
- Material
- Profile
- Grade
- Speckle type

The platform can report element counts, geometry coverage, volume, area, material distributions, and other discovered properties. Users can move between a summary view and the underlying element records.

### 3. Compare model versions

Two ingested versions can be compared using their stored database snapshots.

The comparison identifies:

- Added elements
- Removed elements
- Changed elements, based on a changed element hash
- Total element-count differences
- Category-level count deltas

The current version is compared with a selected baseline version. Added elements can be isolated in the 3D viewer, while the diff bar provides a quick summary of the change set.

### 4. Detect clashes

The clash-checking workflow allows users to define rules between element groups and run geometric checks. Supported modes include:

- Collision: overlapping solids
- Intersection: mesh faces crossing
- Clearance: minimum-distance checks

Results identify conflicting elements and can be turned into BCF topics for assignment, discussion, and follow-up.

### 5. Check information requirements with IDS

Converge supports Information Delivery Specification workflows. Users can store IDS specifications, edit or inspect specification structures, and run checks against normalized models.

IDS checking helps identify whether required classes, properties, and values are present and valid. Results can be used as actionable coordination issues instead of remaining as a separate compliance report.

### 6. Manage BCF issues

The built-in BCF service supports issue collaboration through topics, comments, viewpoints, status changes, and project-level issue organization.

The dashboard includes both detailed topic views and a Kanban-style workflow. Clash and IDS results can create BCF topics so that validation findings enter the same issue process as manually reported coordination problems.

The service exposes BCF API versions 2.1 and 3.0 for interoperability with external BIM coordination clients.

### 7. Manage project documents through a CDE workflow

Converge uses a dedicated Nextcloud-backed Common Data Environment for project documents and drawings.

Documents are organized through an ISO 19650-aligned status flow:

```text
WIP -> Shared -> Published -> Archived
```

The application enforces a review, approval, and verification gate before documents progress through the workflow. Document metadata, revisions, links, permissions, and an append-only event history are stored so that project teams can understand what happened to a document and when.

Documents can be linked to:

- BCF topics
- Model elements
- Project streams

### 8. Connect the model to time

The 4D schedule workflow supports work breakdown structures, task dates, dependencies, critical-path calculations, and model-element links.

Schedules can be imported or authored in the application. Linked elements can be shown in the viewer, and schedule playback provides a visual representation of planned construction progress over time.

### 9. Support quantities and cost planning

Converge extracts geometric quantities such as volume and area and groups them by useful model dimensions. These quantities support early takeoff and comparison workflows.

The MCP layer also supports applying user-provided unit rates to quantities for rough cost estimates. These estimates are intended for planning and analysis rather than as a replacement for a controlled commercial measurement process.

### 10. Search and query BIM data with AI

Converge includes a Model Context Protocol server for use with compatible AI clients such as Claude.

The MCP tools can expose:

- Projects, models, and versions
- Element details and parameters
- Materials, profiles, and quantities
- Model summaries and trends
- Semantic search across element descriptions
- Model differences
- Data-quality reports
- Clash and schedule investigations
- BCF topics, comments, and viewpoints
- Documents and document history
- IFC inspection and editing tools for loaded IFC files

Semantic search uses embeddings generated during ingestion, allowing users to find elements by meaning rather than only by exact name or parameter text. For example, a query for fire-rated doors can find relevant elements even when those exact words are not present in the element name.

## How the system works

```text
Authoring and coordination tools
        |
        v
Speckle streams and commits
        |
        v
Converge ingestion and normalization
        |
        +--> PostgreSQL BIM data layer
        |       models, elements, geometry, parameters,
        |       relationships, embeddings, schedules, documents
        |
        +--> React dashboard
        |       3D viewer, analytics, checks, issues,
        |       documents, schedules, comparison
        |
        +--> BCF API
        |       topics, comments, viewpoints, interoperability
        |
        +--> MCP server
                natural-language BIM queries and workflows
```

### Ingestion and normalization

For each Speckle commit, Converge:

1. Fetches the commit and its object tree.
2. Traverses the tree and identifies model elements while skipping geometry fragments that are not standalone elements.
3. Detects the source application and applies classification rules.
4. Maps elements to IFC-aligned classes and categories.
5. Extracts geometry such as bounding boxes, centroids, volume, area, and mesh data.
6. Extracts property sets and parameter values.
7. Stores model metadata, elements, geometry, parameters, and relationships in PostgreSQL.
8. Builds local search embeddings where possible.

Ingestion is idempotent. Re-ingesting a stored commit can return the existing model quickly, while a forced ingest can rebuild classifications when mapping rules change.

### Main services

- **React and Vite frontend:** dashboard, viewer, analytics, coordination workflows, documents, and schedule interfaces.
- **BIM normalizer:** FastAPI service responsible for ingestion, normalized model data, analytics, checks, exports, schedules, documents, and authentication.
- **PostgreSQL:** shared persistence layer for normalized BIM data, jobs, schedules, documents, BCF data, and project metadata.
- **BCF server:** standalone FastAPI service implementing BCF 2.1 and 3.0 APIs.
- **Speckle server:** source of projects, models, branches, commits, and published object data.
- **Nextcloud:** headless document storage and CDE backend.
- **MCP server:** AI-accessible tools for querying and investigating the BIM data.

## Benefits

### One coordinated view of project information

Converge brings model data, validation results, issues, schedules, quantities, and documents into a connected environment. Teams spend less time switching between disconnected tools and manually reconciling identifiers or exports.

### Better cross-discipline coordination

Different source applications can contribute to the same normalized data layer. IFC-aligned classification and shared element identifiers make it easier to compare information across disciplines and model versions.

### Earlier detection of problems

Clash detection, IDS checking, data-quality reports, and model comparison reveal coordination and information problems before they become more expensive to resolve.

### Traceable decisions and deliverables

BCF topics provide a structured record of findings and resolutions. The document workflow and audit trail provide visibility into reviews, approvals, verifications, revisions, and status changes.

### Faster model-based decisions

Charts, filters, quantities, semantic search, and direct element inspection allow teams to move from a project question to supporting model evidence quickly.

### More useful model history

Version comparison turns successive model deliveries into measurable change information. Teams can see what was added, removed, modified, or redistributed across categories instead of reviewing each version manually.

### Connected planning and delivery

Schedule tasks can be associated with model elements and played back in the viewer. This helps planners and coordinators understand the relationship between planned work and the physical model.

### Self-hosted control

The platform is designed to run as a self-hosted stack using Docker, PostgreSQL, Speckle, and Nextcloud. Organizations can retain control over project data, service configuration, integrations, and access policies.

### Extensible automation

The REST APIs, BCF API, Speckle webhooks, background jobs, and MCP tools create integration points for automated ingestion, reporting, issue workflows, and AI-assisted investigation.

## Intended users

Converge is suitable for:

- BIM managers and information managers
- Design and coordination teams
- General contractors and construction planners
- Model authors working across multiple authoring tools
- QA and compliance reviewers
- Project document controllers
- Digital construction and VDC teams
- Developers building BIM automation and AI workflows

## Positioning

Converge is not only a model viewer and not only a document repository. It is a coordination layer that connects model data with the processes used to validate, discuss, approve, plan, and deliver a project.

Its central idea is simple: normalize project information once, then make that information useful across visualization, analytics, coordination, compliance, documents, schedules, and intelligent search.
