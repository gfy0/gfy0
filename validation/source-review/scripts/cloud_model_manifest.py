import hashlib
import json

MANIFEST_SHA = 'f2e795d0099c05eb8231a96445e6d2440aa381e1c03a1e3b3cb1f2cec296adff'

def verify_manifest(models, expected):
    models = models.resolve()
    blob = models / 'blobs' / ('sha256-' + MANIFEST_SHA)
    active = models / 'manifests-v2/ollama.com/library/gpt-oss-safeguard/20b'
    assert blob.resolve().parent == models / 'blobs'
    assert active.resolve() in (active, blob.resolve())
    assert blob.stat().st_size <= 16384 and active.stat().st_size <= 16384
    canonical = blob.read_bytes()
    assert hashlib.sha256(canonical).hexdigest() == MANIFEST_SHA
    assert hashlib.sha256(active.read_bytes()).hexdigest() == MANIFEST_SHA
    downloaded = json.loads(canonical)
    assert downloaded == expected
    return MANIFEST_SHA
