from pydantic import BaseModel


class TopicCreate(BaseModel):
    title: str
    creation_author: str
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
