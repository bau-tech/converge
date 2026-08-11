"""
Unit tests for chat/agent.py's tool-dispatch logic (_execute_tool /
_execute_tool_impl) — argument validation, error handling, and the new
tools added alongside optional auth (get_schedule, get_element_tasks,
check_federated_clashes, get_notifications) and the extended list_documents/
get_document_status org-scoping. Uses mock_conn (see conftest.py) instead of
a real database — these test dispatch/routing behavior, not SQL correctness.
"""
import json
from types import SimpleNamespace

import pytest

from chat.agent import _execute_tool, _execute_tool_impl

FAKE_DOC = {
    "doc_id": "doc-1", "filename": "S-001-STR-DR-A-001.pdf", "status": "Shared",
    "revision": "P01", "reviewed": True, "approved": False, "verified": False,
    "nc_group_folder": "Structural", "suitability_code": "S2",
    "naming_compliant": True, "linked_element": "elX", "doc_type": "document",
}


def test_unknown_tool(mock_conn):
    result, ids = _execute_tool_impl(mock_conn, "model-1", "not_a_real_tool", {})
    assert result == "Unknown tool."
    assert ids is None


@pytest.mark.parametrize("fn,args", [
    ("find_nearby_elements", {}),
    ("get_element_tasks", {}),
    ("get_element_details", {}),
    ("get_related_elements", {}),
])
def test_missing_required_reference_arg(mock_conn, fn, args):
    result, ids = _execute_tool_impl(mock_conn, "model-1", fn, args)
    assert "required" in result
    assert ids is None


@pytest.mark.parametrize("args", [
    {},
    {"selector_a": "IfcWall"},
    {"compared_model_id": "m2"},
])
def test_check_federated_clashes_missing_args(mock_conn, args):
    result, ids = _execute_tool_impl(mock_conn, "model-1", "check_federated_clashes", args)
    assert "required" in result
    assert ids is None


def test_execute_tool_rolls_back_on_exception(mock_conn):
    """_execute_tool's safety-net wrapper must roll back the connection on
    any unhandled exception from a tool handler, or a poisoned
    aborted-transaction connection goes back to the shared pool."""
    cur = mock_conn.cursor.return_value.__enter__.return_value
    cur.execute.side_effect = RuntimeError("boom")

    result, ids = _execute_tool(mock_conn, "model-1", "list_topics", {})

    assert "Tool 'list_topics' failed" in result
    assert ids is None
    mock_conn.rollback.assert_called_once()


# ---------------------------------------------------------------------------
# get_schedule / get_element_tasks
# ---------------------------------------------------------------------------

_SCHEDULE = {
    "tasks": [
        {
            "task_id": "t1", "name": "Pour footings", "wbs_code": "1.1", "status": "DONE",
            "is_milestone": False, "is_critical": True,
            "planned_start": "2026-01-01", "planned_finish": "2026-01-05",
            "actual_start": "2026-01-01", "actual_finish": "2026-01-06",
            "duration_days": 4, "float_days": 0, "parent_task_id": None, "sort_order": 1,
            "element_count": 2, "speckle_ids": ["a", "b"],
        },
        {
            "task_id": "t2", "name": "Erect steel", "wbs_code": "1.2", "status": "INPROGRESS",
            "is_milestone": False, "is_critical": False,
            "planned_start": "2026-01-06", "planned_finish": "2026-01-20",
            "actual_start": None, "actual_finish": None,
            "duration_days": 14, "float_days": 5, "parent_task_id": None, "sort_order": 2,
            "element_count": 10, "speckle_ids": ["c"],
        },
    ],
    "dependencies": [
        {"dependency_id": "d1", "predecessor_task_id": "t1", "successor_task_id": "t2",
         "sequence_type": "FS", "lag_days": 0},
    ],
    "task_count": 2, "project_start": "2026-01-01", "project_end": "2026-01-20",
}


def test_get_schedule_no_filter_returns_all_and_highlights_everything(mock_conn, mocker):
    mocker.patch("chat.agent.get_schedule", return_value=_SCHEDULE)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_schedule", {})

    payload = json.loads(result)
    assert payload["task_count"] == 2
    assert ids == ["a", "b", "c"]
    assert "speckle_ids" not in payload["tasks"][0]  # trimmed — ids already surfaced separately


def test_get_schedule_critical_only_filters_tasks_and_ids(mock_conn, mocker):
    mocker.patch("chat.agent.get_schedule", return_value=_SCHEDULE)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_schedule", {"critical_only": True})

    payload = json.loads(result)
    assert [t["task_id"] for t in payload["tasks"]] == ["t1"]
    assert ids == ["a", "b"]


def test_get_schedule_status_filter(mock_conn, mocker):
    mocker.patch("chat.agent.get_schedule", return_value=_SCHEDULE)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_schedule", {"status": "INPROGRESS"})

    payload = json.loads(result)
    assert [t["task_id"] for t in payload["tasks"]] == ["t2"]
    assert ids == ["c"]


def test_get_schedule_empty_schedule_message(mock_conn, mocker):
    mocker.patch("chat.agent.get_schedule", return_value={
        "tasks": [], "dependencies": [], "task_count": 0, "project_start": None, "project_end": None,
    })

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_schedule", {})

    assert "an imported or generated schedule" in result
    assert ids is None


def test_get_schedule_filter_matches_nothing(mock_conn, mocker):
    mocker.patch("chat.agent.get_schedule", return_value=_SCHEDULE)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_schedule", {"milestone_only": True})

    assert result == "No tasks matched that filter."
    assert ids is None


def test_get_element_tasks(mock_conn, mocker):
    mocker.patch("chat.agent.get_element_details", return_value={"speckle_id": "abc123", "name": "Beam-1"})
    tasks = [{"task_id": "t1", "name": "Erect steel"}]
    fake_lookup = mocker.patch("chat.agent.get_tasks_for_element", return_value=tasks)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_element_tasks", {"reference": "Beam-1"})

    fake_lookup.assert_called_once_with(mock_conn, "model-1", "abc123")
    assert json.loads(result) == tasks
    assert ids is None


def test_get_element_tasks_no_element_found(mock_conn, mocker):
    mocker.patch("chat.agent.get_element_details", return_value=None)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_element_tasks", {"reference": "nope"})

    assert "No element found" in result
    assert ids is None


def test_get_element_tasks_no_tasks_linked(mock_conn, mocker):
    mocker.patch("chat.agent.get_element_details", return_value={"speckle_id": "abc123", "name": "Beam-1"})
    mocker.patch("chat.agent.get_tasks_for_element", return_value=[])

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_element_tasks", {"reference": "Beam-1"})

    assert "No schedule tasks linked" in result
    assert ids is None


# ---------------------------------------------------------------------------
# list_documents / get_document_status — folder/suitability fields + org scoping
# ---------------------------------------------------------------------------

def test_list_documents_passes_filters_and_org_scope(mock_conn, mocker):
    mocker.patch("chat.agent.get_model_stream_id", return_value="stream-1")
    fake_list = mocker.patch("db.documents.list_documents", return_value=[FAKE_DOC])
    user = SimpleNamespace(guid="u1", org_id="org-A")

    result, ids = _execute_tool_impl(
        mock_conn, "model-1", "list_documents",
        {"folder_path": "Structural", "linked_element": "elX"}, user,
    )

    fake_list.assert_called_once_with(
        mock_conn, "stream-1", status=None,
        folder_path="Structural", linked_element="elX", viewer_org_id="org-A",
    )
    docs = json.loads(result)
    assert docs[0]["folder"] == "Structural"
    assert docs[0]["suitability_code"] == "S2"
    assert docs[0]["naming_compliant"] is True
    assert docs[0]["linked_element"] == "elX"
    assert ids is None


def test_list_documents_anonymous_passes_no_org_scope(mock_conn, mocker):
    mocker.patch("chat.agent.get_model_stream_id", return_value="stream-1")
    fake_list = mocker.patch("db.documents.list_documents", return_value=[FAKE_DOC])

    _execute_tool_impl(mock_conn, "model-1", "list_documents", {}, None)

    fake_list.assert_called_once_with(
        mock_conn, "stream-1", status=None,
        folder_path=None, linked_element=None, viewer_org_id=None,
    )


def test_get_document_status_passes_org_scope(mock_conn, mocker):
    mocker.patch("chat.agent.get_model_stream_id", return_value="stream-1")
    fake_list = mocker.patch("db.documents.list_documents", return_value=[dict(FAKE_DOC)])
    mocker.patch("db.documents.list_events", return_value=[])
    user = SimpleNamespace(guid="u1", org_id="org-A")

    result, ids = _execute_tool_impl(
        mock_conn, "model-1", "get_document_status", {"filename": "S-001"}, user,
    )

    fake_list.assert_called_once_with(mock_conn, "stream-1", viewer_org_id="org-A")
    assert json.loads(result)["suitability_code"] == "S2"
    assert ids is None


# ---------------------------------------------------------------------------
# get_notifications
# ---------------------------------------------------------------------------

def test_get_notifications_anonymous_is_graceful(mock_conn):
    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_notifications", {}, None)

    assert "logged in" in result
    assert ids is None


def test_get_notifications_logged_in(mock_conn, mocker):
    fake_list = mocker.patch(
        "db.notifications.list_notifications",
        return_value=[{"id": 1, "message": "New document uploaded"}],
    )
    user = SimpleNamespace(guid="u1", org_id=None)

    result, ids = _execute_tool_impl(
        mock_conn, "model-1", "get_notifications", {"unread_only": True, "limit": 5}, user,
    )

    fake_list.assert_called_once_with(mock_conn, "u1", unread_only=True, limit=5)
    assert json.loads(result)[0]["message"] == "New document uploaded"
    assert ids is None


def test_get_notifications_logged_in_empty(mock_conn, mocker):
    mocker.patch("db.notifications.list_notifications", return_value=[])
    user = SimpleNamespace(guid="u1", org_id=None)

    result, ids = _execute_tool_impl(mock_conn, "model-1", "get_notifications", {}, user)

    assert result == "No notifications."
    assert ids is None
