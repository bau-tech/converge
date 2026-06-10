import os
from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return v


SPECKLE_SERVER_URL: str = os.getenv("SPECKLE_SERVER_URL", "https://speckle.example.com")
SPECKLE_TOKEN: str = os.getenv("SPECKLE_TOKEN", "")

PG_HOST: str = _require("PG_HOST")
PG_PORT: int = int(os.getenv("PG_PORT", "5432"))
PG_USER: str = _require("PG_USER")
PG_PASS: str = _require("PG_PASS")
PG_NAME: str = _require("PG_NAME")

PORT: int = int(os.getenv("PORT", "8002"))
