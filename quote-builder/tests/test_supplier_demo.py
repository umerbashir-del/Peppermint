from app.pdf import render_quote_pdf
from tests.helpers import bootstrap_owner, workspace


def test_demo_metadata_requires_exact_tenant_and_no_real_binding(client, monkeypatch):
    owner = bootstrap_owner(client)
    monkeypatch.setenv('QBC_DEMO_SUPPLIER_TENANTS', ' tenant-a ')
    monkeypatch.delenv('QBC_SUPPLIER_BINDINGS_FILE', raising=False)
    assert client.get('/auth/me', headers=owner).json()['supplier_demo'] is True
    monkeypatch.setenv('QBC_DEMO_SUPPLIER_TENANTS', 'tenant-a-other')
    assert client.get('/auth/me', headers=owner).json()['supplier_demo'] is False
    monkeypatch.setenv('QBC_DEMO_SUPPLIER_TENANTS', 'tenant-a')
    monkeypatch.setenv('QBC_SUPPLIER_BINDINGS_FILE', 'private-source.json')
    assert client.get('/auth/me', headers=owner).json()['supplier_demo'] is False


def test_production_demo_runs_real_parser_with_explicit_sample_scope(client, monkeypatch):
    ws = workspace(client)
    monkeypatch.setenv('NODE_ENV', 'production')
    monkeypatch.setenv('QBC_DEMO_SUPPLIER_TENANTS', 'tenant-a')
    monkeypatch.setenv('QBC_ALLOW_SAMPLE_SUPPLIER', 'false')
    monkeypatch.delenv('QBC_SUPPLIER_BINDINGS_FILE', raising=False)
    response = client.post('/jobs', headers={**ws['owner'], 'Idempotency-Key': 'demo-parser-check'},
                           json={'workflow': 'supplier', 'notes': 'some wood', 'project_name': 'DEMO'})
    assert response.status_code == 200
    assert response.json()['status'] == 'needs_input'
    assert response.json()['quote'] is None
    state = client.get('/job-progress/create:demo-parser-check', headers=ws['owner']).json()
    assert state['steps'][0]['status'] == 'needs_input'
    assert state['steps'][1]['status'] == 'waiting'


def test_sample_supplier_pdf_has_visible_demo_label(monkeypatch):
    from reportlab import rl_config
    monkeypatch.setattr(rl_config, 'pageCompression', 0)
    sample = render_quote_pdf({'warnings': ['SAMPLE SUPPLIER DATA: this is not a live commercial quote.']}, 'demo', 'hash', 'approved')
    commercial = render_quote_pdf({}, 'commercial', 'hash', 'approved')
    assert sample.startswith(b'%PDF')
    assert b'SAMPLE SUPPLIER DATA' in sample
    assert b'For demonstration only.' in sample
    assert b'SAMPLE SUPPLIER DATA' not in commercial
