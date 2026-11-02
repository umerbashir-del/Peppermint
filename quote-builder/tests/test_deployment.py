import pytest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.config import cors_origins
from start import validate_environment
from tests.helpers import bootstrap_owner


@pytest.mark.parametrize('value', ['*', 'https://*.vercel.app', 'http://public.example', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com?x=y'])
def test_cors_rejects_broad_or_invalid_origins(value):
    with pytest.raises(ValueError):
        cors_origins(value)


def test_cors_normalizes_explicit_origins():
    assert cors_origins(' https://app.example/,https://app.example,http://localhost:3000 ') == ['https://app.example', 'http://localhost:3000']


def test_split_host_preflight_login_and_private_responses(client):
    from app.main import app
    # Wrap the actual API using the same middleware/options as deployment, without mutating global settings.
    split = TestClient(CORSMiddleware(app, allow_origins=['https://app.example'], allow_credentials=False,
                                   allow_methods=['GET', 'POST', 'PUT', 'PATCH'],
                                   allow_headers=['Authorization', 'Content-Type', 'Idempotency-Key']))
    owner = bootstrap_owner(client)
    preflight = split.options('/jobs', headers={'Origin': 'https://app.example', 'Access-Control-Request-Method': 'POST',
                                             'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key'})
    assert preflight.status_code == 200
    assert preflight.headers['access-control-allow-origin'] == 'https://app.example'
    for path in ['/projects', '/jobs', '/quotes', '/profile', '/auth/me']:
        response = split.get(path, headers={**owner, 'Origin': 'https://app.example'})
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'https://app.example'
    unauthorized = split.get('/jobs', headers={'Origin': 'https://app.example'})
    assert unauthorized.status_code == 401
    assert unauthorized.headers['access-control-allow-origin'] == 'https://app.example'
    denied = split.options('/jobs', headers={'Origin': 'https://untrusted.example', 'Access-Control-Request-Method': 'POST'})
    assert denied.status_code == 400
    assert 'access-control-allow-origin' not in denied.headers


def test_render_startup_requires_secrets_and_persistent_path(tmp_path):
    env = {'QBC_SECRET_KEY': 'x' * 40, 'ANTHROPIC_API_KEY': 'dummy-test-key', 'ANTHROPIC_MODEL': 'test-model',
           'QBC_DB_PATH': str(tmp_path / 'quotes.db'), 'PORT': '10000', 'QBC_CORS_ORIGINS': 'https://app.example'}
    port, db = validate_environment(env)
    assert port == 10000 and db.is_absolute()
    for change in [{'QBC_SECRET_KEY': 'short'}, {'ANTHROPIC_API_KEY': ''}, {'ANTHROPIC_MODEL': ''},
                   {'QBC_DB_PATH': 'temporary.db'}, {'PORT': '0'}, {'QBC_CORS_ORIGINS': '*'}, {'QBC_CORS_ORIGINS': ''}]:
        with pytest.raises(ValueError):
            validate_environment({**env, **change})
