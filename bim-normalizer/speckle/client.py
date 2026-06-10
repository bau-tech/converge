from specklepy.api.client import SpeckleClient
from config import settings


def get_client(server_url: str = None, token: str = None) -> SpeckleClient:
    url = server_url or settings.SPECKLE_SERVER_URL
    tok = token or settings.SPECKLE_TOKEN
    if not tok:
        raise ValueError("SPECKLE_TOKEN is not set")
    try:
        client = SpeckleClient(host=url)
        client.authenticate_with_token(tok)
    except Exception as exc:
        raise ConnectionError(f"Speckle auth failed for {url}: {exc}") from exc
    return client
