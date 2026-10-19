import json
import os
from pathlib import Path
import tempfile
import unittest
from cloud_model_manifest import verify_manifest, MANIFEST_SHA

fixture = Path(__file__).with_name('cloud-model-canonical.json').read_bytes()
expected = json.loads(fixture)

class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('RUNNER_TEMP', Path(__file__).parent))
        self.addCleanup(self.temp.cleanup)
        self.models = Path(self.temp.name)
        self.blob = self.models / 'blobs' / ('sha256-' + MANIFEST_SHA)
        self.blob.parent.mkdir()
        self.blob.write_bytes(fixture)
        self.active = self.models / 'manifests-v2/ollama.com/library/gpt-oss-safeguard/20b'
        self.active.parent.mkdir(parents=True)
        self.active.write_bytes(fixture)
        legacy = self.models / 'manifests/registry.ollama.ai/library/gpt-oss-safeguard/20b'
        legacy.parent.mkdir(parents=True)
        anchor = json.loads(fixture)
        anchor['layers'].append({'mediaType': 'application/vnd.docker.distribution.manifest.v2+json',
                                 'digest': 'sha256:' + MANIFEST_SHA, 'size': len(fixture)})
        legacy.write_text(json.dumps(anchor))

    def test_legacy_anchor_does_not_replace_canonical_model(self):
        self.assertEqual(verify_manifest(self.models, expected), MANIFEST_SHA)

    def test_missing_blob_is_rejected(self):
        self.blob.unlink()
        with self.assertRaises((AssertionError, OSError)):
            verify_manifest(self.models, expected)

    def test_corrupt_or_extra_canonical_layer_is_rejected(self):
        for content in [b'corrupt', json.dumps({**expected, 'layers': expected['layers'] + [{}]}).encode()]:
            self.blob.write_bytes(content)
            with self.assertRaises(AssertionError):
                verify_manifest(self.models, expected)

    def test_changed_pin_is_rejected(self):
        changed = json.loads(fixture)
        changed['layers'][0]['digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(AssertionError):
            verify_manifest(self.models, changed)

    def test_wrong_active_name_is_rejected(self):
        self.active.write_text('{}')
        with self.assertRaises(AssertionError):
            verify_manifest(self.models, expected)

if __name__ == '__main__':
    unittest.main()
