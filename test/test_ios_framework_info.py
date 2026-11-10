import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CHECK = Path(__file__).resolve().parents[1] / "scripts/check-ios-frameworks.py"


class FrameworkInfoTest(unittest.TestCase):
    def test_framework_metadata(self):
        with tempfile.TemporaryDirectory(prefix="kepos-framework-info-") as temp:
            framework = Path(temp) / "example.framework"
            framework.mkdir()
            (framework / "example").write_bytes(b"fixture")
            info = {
                "CFBundleIdentifier": "io.example.bare-inspect",
                "CFBundleExecutable": "example",
                "CFBundlePackageType": "FMWK",
            }

            def check(expected, fmt=plistlib.FMT_XML):
                (framework / "Info.plist").write_bytes(plistlib.dumps(info, fmt=fmt))
                result = subprocess.run([sys.executable, CHECK, framework], capture_output=True)
                self.assertEqual(result.returncode == 0, expected, result.stderr.decode())

            check(True)
            check(True, plistlib.FMT_BINARY)
            info["CFBundleIdentifier"] = "io.example.bare_inspect"
            check(False)
            info["CFBundleIdentifier"] = "io.example.valid"
            info["CFBundleExecutable"] = "other"
            check(False)
            info["CFBundleExecutable"] = "example"
            info["CFBundlePackageType"] = "APPL"
            check(False)
            info["CFBundlePackageType"] = "FMWK"
            (framework / "example").unlink()
            check(False)


if __name__ == "__main__":
    unittest.main()
