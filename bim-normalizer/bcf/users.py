from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one, execute, execute_returning
from bcf.password import hash_password
from bcf.schemas import UserCreate

router = APIRouter(tags=["bcf-users"], prefix="/bcf-bridge/users")


def _serialize(row: dict) -> dict:
    return {
        "guid": str(row["guid"]),
        "email": row["email"],
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("")
def list_users():
    rows = fetch_all("SELECT guid, email, name, created_at FROM bcf_users ORDER BY created_at")
    return [_serialize(r) for r in rows]


@router.post("", status_code=201)
def create_user(body: UserCreate):
    existing = fetch_one("SELECT guid FROM bcf_users WHERE email = %s", (body.email,))
    if existing is not None:
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    row = execute_returning(
        """
        INSERT INTO bcf_users (email, name, password_hash)
        VALUES (%s, %s, %s)
        RETURNING guid, email, name, created_at
        """,
        (body.email, body.name, hash_password(body.password)),
    )
    return _serialize(row)


@router.delete("/{user_guid}", status_code=204)
def delete_user(user_guid: str):
    row = fetch_one("SELECT guid FROM bcf_users WHERE guid = %s", (user_guid,))
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    execute("DELETE FROM bcf_users WHERE guid = %s", (user_guid,))
