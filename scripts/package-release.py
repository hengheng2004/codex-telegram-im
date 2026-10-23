#!/usr/bin/env python3
"""Export only reviewed project source, without Git history or local state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
FILES = [".env.example", ".gitignore", "AGENTS.md", "LICENSE", "README.md",
         "INSTALL_MACOS.md", "DEPLOY_WITH_CODEX.md", "PUBLISH_GITHUB.md",
         "package.json", "package-lock.json"]
DIRECTORIES = ["src", "test", "scripts", "skills", ".github/workflows"]
SUFFIXES = {".js", ".py", ".ps1", ".vbs", ".md", ".yaml", ".yml"}
PRIVATE_PARTS = {".git", ".data", ".env", ".codex", ".agents", ".aws", ".ssh",
                 ".telegram-inbox", "node_modules", "__pycache__"}


def source_files(root):
    selected = list(FILES)
    for directory in DIRECTORIES:
        base = root / directory
        if base.is_symlink():
            raise ValueError("Symlinked source directory: " + directory)
        if not base.is_dir():
            raise ValueError("Missing source directory: " + directory)
        for path in sorted(base.rglob("*")):
            relative = path.relative_to(root)
            if any(part in PRIVATE_PARTS for part in relative.parts):
                continue
            if path.is_symlink():
                raise ValueError("Symlink in source tree: " + str(relative))
            if path.is_file() and path.suffix in SUFFIXES:
                selected.append(str(relative))
    return sorted(selected)


def local_secret_values(root):
    values = []
    env = root / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if key.strip() in {"TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_USER_ID", "BRIDGE_TOKEN"}:
                value = value.strip().strip("\"'")
                if len(value) >= 6:
                    values.append(value.encode())
    return values


def inspect_source(root):
    selected = source_files(root)
    private = local_secret_values(root)
    for name in selected:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing or symlinked source file: " + name)
        body = path.read_bytes()
        if any(value in body for value in private):
            raise ValueError("Local credential or identity value found in " + name)
        if re.search(rb"\b[0-9]{6,}:[A-Za-z0-9_-]{25,}\b", body):
            raise ValueError("Possible Telegram token in " + name)
        if re.search(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", body):
            raise ValueError("Possible private key in " + name)
        if (b"/Users/" + b"abc/") in body:
            raise ValueError("Old-machine absolute path in " + name)
    return selected


def build(root, output):
    selected = inspect_source(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".source-", suffix=".tar.gz", dir=output.parent)
    os.close(descriptor)
    try:
        with tarfile.open(temporary, "w:gz") as archive:
            for name in selected:
                archive.add(root / name, arcname="codex-telegram-im/" + name, recursive=False)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_name(output.name + ".sha256").write_text(digest + "  " + output.name + "\n")
    return selected, digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Inspect the publication allowlist without building an archive")
    parser.add_argument("--output", default=str(ROOT / "dist/codex-telegram-im-source.tar.gz"))
    args = parser.parse_args()
    if args.check:
        selected = inspect_source(ROOT)
        print("Publication source check passed: {} files; no private state or Git history selected.".format(len(selected)))
    else:
        selected, digest = build(ROOT, Path(args.output).expanduser().absolute())
        print(json.dumps({"archive": str(Path(args.output).expanduser().absolute()),
                          "files": len(selected), "sha256": digest}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print("Source export failed: " + str(error), file=__import__("sys").stderr)
        raise SystemExit(1)
