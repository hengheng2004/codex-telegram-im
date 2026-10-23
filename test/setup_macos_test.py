import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load("mac_setup", "setup-macos.py")
release = load("source_release", "package-release.py")


class MacSetupTests(unittest.TestCase):
    def message(self):
        return {"update_id": 10, "message": {"text": "/pair test-code",
                "from": {"id": 7, "is_bot": False},
                "chat": {"id": -10, "type": "supergroup", "is_forum": True}}}

    def test_pairing_only_accepts_this_code_in_a_private_forum(self):
        good = self.message()
        self.assertEqual(setup.pair_message([good], "/pair test-code")["from"]["id"], 7)
        cases = []
        for key, value in [("username", "public"), ("is_forum", False), ("type", "private")]:
            item = self.message()
            item["message"]["chat"][key] = value
            cases.append([item])
        cases.extend([[], [good, good]])
        bot = self.message()
        bot["message"]["from"]["is_bot"] = True
        cases.append([bot])
        for updates in cases:
            with self.subTest(updates=updates), self.assertRaises(setup.SetupError):
                setup.pair_message(updates, "/pair test-code")

    def test_pairing_requires_owner_bot_permission_and_two_members(self):
        owner = {"status": "creator"}
        bot = {"status": "administrator", "can_manage_topics": True}
        setup.check_members(owner, bot, 2)
        for values in [({"status": "member"}, bot, 2), (owner, {"status": "member"}, 2),
                       (owner, dict(bot, can_manage_topics=False), 2), (owner, bot, 3)]:
            with self.subTest(values=values), self.assertRaises(setup.SetupError):
                setup.check_members(*values)

    def test_proxy_rejects_credentials_socks_and_multiline_input(self):
        self.assertEqual(setup.proxy_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890")
        self.assertEqual(setup.proxy_url(""), "")
        for value in ["socks5://127.0.0.1:7890", "http://user:password@localhost:7890", "http://localhost\nBAD=1"]:
            with self.subTest(value=value), self.assertRaises(setup.SetupError):
                setup.proxy_url(value)

    def test_config_rejects_newline_injection_and_preserves_equals_in_paths(self):
        self.assertEqual(setup.dotenv({"CODEX_WORKSPACE": "/tmp/project=a b"}), "CODEX_WORKSPACE=/tmp/project=a b\n")
        with self.assertRaises(setup.SetupError):
            setup.dotenv({"CODEX_WORKSPACE": "/tmp/project\nBRIDGE_HOST=0.0.0.0"})

    def test_private_writes_replace_content_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "private"
            setup.write_private(file, "first")
            setup.write_private(file, "second")
            self.assertEqual(file.read_text(), "second")
            if os.name != "nt":
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual([p.name for p in file.parent.iterdir()], ["private"])

    def test_service_and_wrapper_use_target_paths_and_explicit_feature_limits(self):
        root = Path("/tmp/new machine/project")
        result = setup.service_plist(root, "/opt/bin/node", "/tmp/new user/.codex", "/opt/bin:/usr/bin", "http://localhost:7890")
        result = plistlib.loads(plistlib.dumps(result))
        self.assertEqual(result["WorkingDirectory"], str(root))
        self.assertEqual(result["ProgramArguments"], ["/opt/bin/node", str(root / "src/relay.js")])
        self.assertTrue(result["RunAtLoad"])
        self.assertFalse(result["KeepAlive"]["SuccessfulExit"])
        self.assertEqual(result["EnvironmentVariables"]["NODE_USE_ENV_PROXY"], "1")
        self.assertNotIn("TELEGRAM_BOT_TOKEN", result["EnvironmentVariables"])
        wrapper = setup.wrapper_script("/tmp/codex's folder/codex", "/opt/bin:/usr/bin", "/tmp/home/.codex")
        self.assertIn('"$@"', wrapper)
        self.assertIn("features.hooks=false", wrapper)
        self.assertIn("features.multi_agent=false", wrapper)
        self.assertIn("'\"'\"'", wrapper)

    def test_configure_does_not_overwrite_existing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("keep-me")
            args = argparse.Namespace(workspace=directory, sandbox="read-only", port=43921, proxy="")
            with patch.object(setup, "ROOT", root), patch.object(setup, "api_client") as api:
                with self.assertRaises(setup.SetupError):
                    setup.configure(args)
                api.assert_not_called()
            self.assertEqual((root / ".env").read_text(), "keep-me")

    def test_api_error_does_not_disclose_the_token_url(self):
        token = "private-placeholder-token"
        error = urllib.error.HTTPError("https://api.telegram.org/bot" + token + "/getMe", 401, "rejected", {}, None)
        with patch.object(setup.urllib.request.OpenerDirector, "open", side_effect=error):
            with self.assertRaises(setup.SetupError) as caught:
                setup.api_client(token, "")("getMe")
        self.assertNotIn(token, str(caught.exception))
        self.assertIn("401", str(caught.exception))

    def test_service_actions_refuse_a_different_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "service.plist"
            agent.write_bytes(plistlib.dumps({"Label": setup.LABEL, "WorkingDirectory": "/another/checkout"}))
            value = dict(node="/node", codex_home="/codex-home", path="/bin", proxy="")
            with patch.object(setup, "ROOT", root), patch.object(setup, "paths", return_value=(agent, "gui/1")), \
                    patch.object(setup, "manifest", return_value=value), patch.object(setup, "run") as run:
                with self.assertRaises(setup.SetupError):
                    setup.service_action("stop")
                run.assert_not_called()


class SourceReleaseTests(unittest.TestCase):
    def populate(self, root):
        for name in release.FILES:
            (root / name).write_text("source\n")
        for directory in release.DIRECTORIES:
            (root / directory).mkdir(parents=True)
        (root / "src/main.js").write_text("export const ok = true;\n")

    def test_export_keeps_source_and_excludes_private_state_and_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            for directory in [".git", ".data", "node_modules", ".telegram-inbox"]:
                (root / directory).mkdir()
                (root / directory / "private.txt").write_text("do not publish")
            (root / ".env").write_text("BRIDGE_TOKEN=local-placeholder-secret\n")
            (root / "MIGRATION_CHECKLIST.md").write_text("local inventory")
            archive = root / "dist/source.tar.gz"
            selected, digest = release.build(root, archive)
            with tarfile.open(archive) as stream:
                names = stream.getnames()
            self.assertIn("codex-telegram-im/src/main.js", names)
            self.assertNotIn("MIGRATION_CHECKLIST.md", selected)
            self.assertFalse(any("/private.txt" in name for name in names))
            self.assertNotIn("codex-telegram-im/.env", names)
            self.assertTrue(archive.with_name(archive.name + ".sha256").read_text().startswith(digest))

    def test_export_refuses_local_credentials_in_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            value = "example-local-credential-value"
            (root / ".env").write_text("BRIDGE_TOKEN=" + value)
            (root / "src/main.js").write_text(value)
            with self.assertRaisesRegex(ValueError, "Local credential"):
                release.inspect_source(root)

    def test_export_refuses_token_patterns_and_old_machine_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            for value in ["123456:" + "A" * 30, "/Users/" + "abc/private-project"]:
                (root / "src/main.js").write_text(value)
                with self.assertRaises(ValueError):
                    release.inspect_source(root)

    @unittest.skipIf(os.name == "nt", "symlink privileges differ on Windows")
    def test_export_refuses_symlink_to_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            (root / ".env").write_text("private")
            (root / "src/secret.js").symlink_to(root / ".env")
            with self.assertRaisesRegex(ValueError, "Symlink"):
                release.inspect_source(root)


if __name__ == "__main__":
    unittest.main()
