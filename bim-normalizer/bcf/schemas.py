from pydantic import BaseModel, field_validator


class TopicCreate(BaseModel):
    title: str
    # Per the BCF-API spec this is server-assigned from the authenticated
    # identity, not client-supplied — real clients (BIMcollab ZOOM) never
    # send it. Optional here so create_topic() can fall back to the
    # Authorization header's identity; internal callers that already know
    # the author (bcfxml import, chat/agent, MCP) can still pass it explicitly.
    creation_author: str | None = None
    description: str | None = None
    topic_type: str | None = None
    topic_status: str | None = None
    priority: str | None = None
    stage: str | None = None
    labels: list[str] = []
    due_date: str | None = None
    assigned_to: str | None = None
    # Overrides the DB default of NOW() — used when importing topics from an
    # external source (Speckle comments, .bcfzip) that already has a timestamp.
    creation_date: str | None = None


class TopicUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    topic_type: str | None = None
    topic_status: str | None = None
    priority: str | None = None
    stage: str | None = None
    labels: list[str] | None = None
    due_date: str | None = None
    assigned_to: str | None = None
    modified_author: str | None = None


class CommentCreate(BaseModel):
    comment: str
    author: str
    viewpoint_guid: str | None = None
    # Overrides the DB default of NOW() — see TopicCreate.creation_date.
    date: str | None = None


class CommentUpdate(BaseModel):
    comment: str
    modified_author: str | None = None


class Vector3(BaseModel):
    x: float
    y: float
    z: float


class ClippingPlane(BaseModel):
    location: Vector3
    direction: Vector3


class ViewpointCreate(BaseModel):
    is_orthogonal: bool = False
    camera_view_point: Vector3 | None = None
    camera_direction: Vector3 | None = None
    camera_up_vector: Vector3 | None = None
    field_of_view: float | None = None
    view_to_world_scale: float | None = None
    clipping_planes: list[ClippingPlane] = []
    default_visibility: bool = True
    # IFC GUIDs, grouped by how they should be applied in the viewer.
    selection: list[str] = []
    visibility_exceptions: list[str] = []
    coloring: list[dict] = []  # [{"ifc_guid": "...", "color": "FF0000"}]
    # Raw PNG bytes, base64-encoded.
    snapshot_base64: str | None = None

    # GET .../viewpoints enriches each ifc_guid into {"ifc_guid",
    # "speckle_id"} (see bcf/viewpoints.py's _components_for) so a consumer
    # has a ready-to-use speckle_id — but that means naively resubmitting a
    # previously-fetched viewpoint's selection/visibility_exceptions (e.g.
    # BcfTopicPanel/BcfKanbanBoard's "continue annotating this saved
    # viewpoint" re-save) sends that same enriched shape back here. That used
    # to 422 outright — this field only ever accepted bare strings, and every
    # manually-created topic's viewpoint happens to have an empty selection
    # (nothing was 3D-selected when it was captured), so this never surfaced
    # until a clash-check-generated topic — whose viewpoint always has a real
    # 2-element selection (the clashing pair) — got re-annotated. Unwrap
    # objects back to their ifc_guid so both shapes work.
    @field_validator("selection", "visibility_exceptions", mode="before")
    @classmethod
    def _unwrap_ifc_guid(cls, v):
        if not v:
            return v
        return [item.get("ifc_guid") if isinstance(item, dict) else item for item in v]


class ExtensionValueCreate(BaseModel):
    kind: str
    value: str
    sort_order: int = 0


class UserCreate(BaseModel):
    email: str
    name: str
    password: str


class UserResponse(BaseModel):
    guid: str
    email: str
    name: str
    created_at: str


class DocumentRoleCreate(BaseModel):
    user_guid: str
    # '*' in stream_ids means "all projects" (db/roles.py's sentinel) —
    # the admin UI sends ["*"] when the "All projects" checkbox is used
    # instead of picking specific projects from the multi-select.
    stream_ids: list[str]
    roles: list[str]


class OrganizationCreate(BaseModel):
    name: str


class UserOrgUpdate(BaseModel):
    org_id: str | None = None


class UserNotifyEmailUpdate(BaseModel):
    notify_email: bool


class UserPasswordReset(BaseModel):
    password: str
