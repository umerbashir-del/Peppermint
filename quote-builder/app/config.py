"""Load the repository's private .env server-side, without replacing host secrets."""
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]


def load_config():
    load_dotenv(ROOT / '.env', override=False)


load_config()


def cors_origins(value: str) -> list[str]:
    """Only explicitly listed origins; never trust all Vercel preview domains."""
    origins = []
    for entry in value.split(','):
        entry = entry.strip()
        if not entry:
            continue
        url = urlsplit(entry)
        local = url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')
        if (not (url.scheme == 'https' or local) or not url.hostname or url.username or url.password
                or url.path not in ('', '/') or url.query or url.fragment or '*' in entry
                or any(char.isspace() for char in entry)):
            raise ValueError('QBC_CORS_ORIGINS must contain exact HTTPS origins (HTTP is allowed for localhost).')
        origin = f'{url.scheme}://{url.netloc}'
        if origin not in origins:
            origins.append(origin)
    return origins
