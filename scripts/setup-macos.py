#!/usr/bin/env python3
"""Fresh, single-user macOS deployment. Secrets are entered locally, never as flags."""
import argparse
import getpass
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LABEL = "com.codex.telegram"
FEATURES = {
    "shell_tool": True, "unified_exec": True, "apps": True, "plugins": True,
    "hooks": False, "code_mode_host": True, "computer_use": True,
    "browser_use": True, "multi_agent": False,
}


class SetupError(Exception):
    pass


def write_private(path, body, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".setup-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(body.encode() if isinstance(body, str) else body)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def dotenv(values):
    for value in values.values():
        if any(character in str(value) for character in ("\r", "\n", "\0")):
            raise SetupError("Configuration values must fit on one line.")
    # src/config.js treats everything after the first '=' as the value.
    return "".join(str(key) + "=" + str(value) + "\n" for key, value in values.items())


def proxy_url(value):
    if not value:
        return ""
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise SetupError("Use an HTTP(S) proxy URL without credentials; SOCKS URLs are not supported by this installer.")
    if any(c in value for c in ("\r", "\n", "\0")):
        raise SetupError("Invalid proxy URL.")
    return value


def service_plist(root, node, codex_home, command_path, proxy=""):
    environment = {"PATH": command_path, "CODEX_HOME": str(codex_home)}
    if proxy:
        environment.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy,
                           NO_PROXY="localhost,127.0.0.1", NODE_USE_ENV_PROXY="1")
    return {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(root / "src/relay.js")],
        "WorkingDirectory": str(root),
        "EnvironmentVariables": environment,
        "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 20,
        "StandardOutPath": str(root / ".data/launchd.stdout.log"),
        "StandardErrorPath": str(root / ".data/launchd.stderr.log"),
    }


def wrapper_script(codex, command_path, codex_home):
    lines = ["#!/bin/zsh", "export PATH=" + shlex.quote(command_path),
             "export CODEX_HOME=" + shlex.quote(str(codex_home))]
    flags = " ".join("-c features.{}={}".format(key, str(value).lower()) for key, value in FEATURES.items())
    lines.append("exec " + shlex.quote(str(codex)) + ' "$@" ' + flags)
    return "\n".join(lines) + "\n"


def pair_message(updates, code):
    matches = []
    for update in updates:
        message = update.get("message", {})
        sender = message.get("from", {})
        if message.get("text", "").strip() == code and not sender.get("is_bot", True):
            matches.append(message)
    if len(matches) != 1:
        raise SetupError("Send the pairing code exactly once in the new private forum group, then retry configure.")
    message = matches[0]
    chat = message.get("chat", {})
    if chat.get("type") != "supergroup" or not chat.get("is_forum") or chat.get("username"):
        raise SetupError("Pair in a private group with Topics enabled, not a public group or a direct message.")
    if not message.get("from", {}).get("id") or not chat.get("id"):
        raise SetupError("Pairing message has no usable sender or chat.")
    return message


def check_members(owner, bot, count):
    if owner.get("status") != "creator":
        raise SetupError("The private group's owner must send the pairing code.")
    if bot.get("status") != "administrator" or not bot.get("can_manage_topics"):
        raise SetupError("Make the bot an administrator with Manage Topics enabled.")
    if count != 2:
        raise SetupError("Use a private group containing only you and this bot.")


def api_client(token, proxy):
    # Explicitly select the requested proxy; do not inherit an unrelated shell proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(
        {"http": proxy, "https": proxy} if proxy else {}))

    def call(method, payload=None):
        request = urllib.request.Request("https://api.telegram.org/bot" + token + "/" + method,
                                         data=json.dumps(payload or {}).encode(),
                                         headers={"Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise SetupError("Telegram request failed (HTTP {}). Check the bot and group settings.".format(error.code)) from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise SetupError("Cannot reach Telegram. Check network/proxy settings.") from None
        if not result.get("ok"):
            raise SetupError("Telegram rejected the request; check the bot and group settings.")
        return result["result"]
    return call


def run(arguments, env=None, check=True):
    result = subprocess.run([str(a) for a in arguments], cwd=ROOT, env=env,
                            capture_output=True, text=True)
    if check and result.returncode:
        # CLI errors may contain configuration or request URLs: do not dump them.
        raise SetupError("{} failed (exit {}). Inspect it locally; do not paste secrets into chat.".format(
            Path(arguments[0]).name, result.returncode))
    return result


def executable(name):
    found = shutil.which(name)
    if not found:
        raise SetupError("{} is missing. Install it and retry; see INSTALL_MACOS.md.".format(name))
    return str(Path(found).absolute())


def plan(args):
    return {
        "root": str(ROOT), "workspace": str(Path(args.workspace).expanduser().resolve()),
        "sandbox": args.sandbox, "bridge_host": "127.0.0.1", "bridge_port": args.port,
        "label": LABEL, "proxy": proxy_url(args.proxy),
        "writes": [".env", ".data/state.json", ".data/codex-wrapper.command", ".data/macos-install.json"],
        "starts_relay": False,
    }


def configure(args):
    settings = plan(args)
    if (ROOT / ".env").exists() or (ROOT / ".data/state.json").exists():
        raise SetupError("This checkout already has private configuration/state. Use install/start to reuse it, or configure a fresh checkout for a new bot.")
    node, codex = executable("node"), executable("codex")
    if int(run([node, "-p", "process.versions.node.split('.')[0]"]).stdout.strip()) < 20:
        raise SetupError("Node.js 20 or newer is required.")
    if settings["proxy"] and run([node, "--help"]).stdout.find("--use-env-proxy") < 0:
        raise SetupError("This Node version lacks environment proxy support. Use a Node version supporting NODE_USE_ENV_PROXY, or configure without --proxy.")
    codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    command_path = os.pathsep.join(dict.fromkeys([str(Path(node).parent), str(Path(codex).parent),
                                                 "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
    environment = dict(os.environ, CODEX_HOME=str(codex_home), PATH=command_path)
    run([codex, "login", "status"], env=environment)
    if not sys.stdin.isatty():
        raise SetupError("Run configure in your own interactive Terminal. Never send a bot token to Codex chat or pass it as a command-line argument.")
    token = getpass.getpass("New machine's BotFather token (hidden input): ").strip()
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
        raise SetupError("Invalid token format.")
    api = api_client(token, settings["proxy"])
    me = api("getMe")
    if api("getWebhookInfo").get("url"):
        raise SetupError("This bot already has a webhook. Create a separate bot for this workstation.")
    code = "/pair " + secrets.token_hex(8)
    print("Create a PRIVATE group containing only you and the new bot. Enable Topics.")
    print("Give the bot administrator status with Manage Topics, then send this once:")
    print(code)
    input("After sending, press Enter here: ")
    updates = api("getUpdates", {"timeout": 0, "allowed_updates": ["message"]})
    message = pair_message(updates, code)
    chat, user = message["chat"], message["from"]
    check_members(api("getChatMember", {"chat_id": chat["id"], "user_id": user["id"]}),
                  api("getChatMember", {"chat_id": chat["id"], "user_id": me["id"]}),
                  api("getChatMemberCount", {"chat_id": chat["id"]}))
    workspace = Path(settings["workspace"])
    workspace.mkdir(parents=True, exist_ok=True)
    data = ROOT / ".data"
    data.mkdir(mode=0o700, exist_ok=True)
    data.chmod(0o700)
    wrapper = data / "codex-wrapper.command"
    values = {
        "TELEGRAM_BOT_TOKEN": token, "TELEGRAM_CHAT_ID": chat["id"], "TELEGRAM_USER_ID": user["id"],
        "TELEGRAM_MAX_FILE_MB": 45, "TELEGRAM_UPLOAD_TIMEOUT_SECONDS": 60, "TELEGRAM_UPLOAD_RETRIES": 1,
        "CODEX_WORKSPACE": str(workspace), "CODEX_SANDBOX": args.sandbox,
        "CODEX_COMMAND": str(wrapper), "CODEX_COMMAND_ARGS_JSON": "[]", "CODEX_MODEL": "",
        "CODEX_SKIP_GIT_REPO_CHECK": "true", "CODEX_TIMEOUT_SECONDS": 1800,
        "CODEX_MAX_CONCURRENT_TURNS": 2, "CODEX_RUNNER_IDLE_SECONDS": 300,
        "BRIDGE_HOST": "127.0.0.1", "BRIDGE_PORT": args.port, "BRIDGE_TOKEN": secrets.token_hex(32),
        "STATE_FILE": ".data/state.json", "RELAY_LOG_FILE": ".data/relay.log", "LOG_LEVEL": "info",
    }
    if settings["proxy"]:
        values.update(HTTP_PROXY=settings["proxy"], HTTPS_PROXY=settings["proxy"], ALL_PROXY=settings["proxy"],
                      NO_PROXY="localhost,127.0.0.1", NODE_USE_ENV_PROXY="1")
    else:
        # A future host may have proxy variables; keep the relay's own policy explicit.
        values["NO_PROXY"] = "localhost,127.0.0.1"
    manifest = dict(node=node, codex=codex, codex_home=str(codex_home), path=command_path,
                    proxy=settings["proxy"], root=str(ROOT))
    write_private(wrapper, wrapper_script(codex, command_path, codex_home), 0o700)
    # Smoke-test feature flags before writing any token or pairing state.
    try:
        run([wrapper, "app-server", "--help"], env=environment)
        env_body = dotenv(values)
    except Exception:
        wrapper.unlink(missing_ok=True)
        raise
    write_private(data / "macos-install.json", json.dumps(manifest, indent=2) + "\n")
    write_private(data / "state.json", json.dumps({
        "updateOffset": max((u["update_id"] for u in updates), default=-1) + 1, "sessions": {}
    }) + "\n")
    write_private(ROOT / ".env", env_body)
    print("Paired. Private config saved locally with restricted permissions. Relay is not started.")


def manifest():
    try:
        value = json.loads((ROOT / ".data/macos-install.json").read_text())
    except (OSError, ValueError):
        raise SetupError("Run configure first; no macOS installation manifest found.") from None
    if value.get("root") != str(ROOT):
        raise SetupError("This checkout moved. Update local paths before installing; do not reuse old-machine configuration.")
    if not (ROOT / ".env").is_file():
        raise SetupError("Private .env is missing; restore it securely.")
    return value


def paths():
    return Path.home() / "Library/LaunchAgents" / (LABEL + ".plist"), "gui/{}".format(os.getuid())


def same_tree(left, right):
    def files(root):
        result = {}
        for path in root.rglob("*"):
            if path.is_symlink():
                return None
            if path.is_file():
                result[str(path.relative_to(root))] = path.read_bytes()
        return result
    return left.is_dir() and right.is_dir() and files(left) is not None and files(left) == files(right)


def install():
    value = manifest()
    agent, domain = paths()
    expected = service_plist(ROOT, value["node"], value["codex_home"], value["path"], value["proxy"])
    if agent.exists() and plistlib.loads(agent.read_bytes()) != expected:
        raise SetupError("A different service already uses this label. Inspect it locally before replacing it.")
    if run(["launchctl", "print", domain + "/" + LABEL], check=False).returncode == 0:
        raise SetupError("Service already loaded. Use stop before reinstalling, or restart for an unchanged configuration.")
    source = ROOT / "skills/codex-telegram"
    skill = Path(value["codex_home"]) / "skills/codex-telegram"
    if skill.exists() and not same_tree(source, skill):
        raise SetupError("The installed codex-telegram skill differs. Back it up and remove it before installing this version.")
    environment = dict(os.environ, CODEX_HOME=value["codex_home"], PATH=value["path"])
    registered = run([value["codex"], "mcp", "get", "codex-telegram", "--json"], env=environment, check=False)
    if registered.returncode == 0:
        old = json.loads(registered.stdout)
        transport = old.get("transport", old)
        if (transport.get("command") != value["node"] or
                transport.get("args") != [str(ROOT / "src/mcp-server.js")] or
                any(transport.get("env", {}).get(k) != v for k, v in expected["EnvironmentVariables"].items())):
            raise SetupError("codex-telegram MCP already points elsewhere. Inspect it before changing the existing registration.")
    else:
        arguments = [value["codex"], "mcp", "add", "codex-telegram"]
        for key, setting in expected["EnvironmentVariables"].items():
            arguments.extend(["--env", key + "=" + setting])
        run(arguments + ["--", value["node"], ROOT / "src/mcp-server.js"], env=environment)
    if not skill.exists():
        skill.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, skill)
    write_private(agent, plistlib.dumps(expected))
    print("MCP, skill and login service installed. Run start, then restart your Codex client.")


def service_action(action):
    agent, domain = paths()
    if not agent.is_file():
        raise SetupError("No installed service file. Run install first.")
    value = manifest()
    expected = service_plist(ROOT, value["node"], value["codex_home"], value["path"], value["proxy"])
    if plistlib.loads(agent.read_bytes()) != expected:
        raise SetupError("Installed service belongs to another configuration; refusing to control it.")
    target = domain + "/" + LABEL
    loaded = run(["launchctl", "print", target], check=False).returncode == 0
    if action == "status":
        print("Service loaded: " + str(loaded) + ". Run npm run doctor to check health; loading alone is not health.")
    elif action == "stop" or action == "uninstall":
        if loaded:
            run(["launchctl", "bootout", target])
        if action == "uninstall":
            agent.unlink()
            print("Service removed. Config, state, MCP registration and skill retained.")
        else:
            print("Service unloaded; it will not restart until start or the next login.")
    else:
        if not loaded:
            run(["launchctl", "bootstrap", domain, agent])
        run(["launchctl", "kickstart", "-k", target])
        print("Service start/restart requested. Verify with npm run doctor and a Telegram round trip.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "configure", "install", "start", "restart", "stop", "status", "uninstall"])
    parser.add_argument("--workspace", default=str(Path.home() / "Projects"))
    parser.add_argument("--sandbox", choices=["read-only", "workspace-write"], default="read-only")
    parser.add_argument("--proxy", default="", help="Explicit HTTP(S) proxy, for example http://127.0.0.1:7890")
    parser.add_argument("--port", type=int, default=43921)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise SetupError("Port must be between 1024 and 65535.")
    if args.action == "plan":
        print(json.dumps(plan(args), indent=2, ensure_ascii=False))
        return
    if sys.platform != "darwin":
        raise SetupError("This installer is for macOS. See README.md for other platforms.")
    if args.action == "configure":
        configure(args)
    elif args.action == "install":
        install()
    else:
        service_action(args.action)


if __name__ == "__main__":
    try:
        main()
    except (SetupError, KeyboardInterrupt, EOFError) as error:
        print("Setup stopped: " + (str(error) or "cancelled"), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Setup stopped ({}). Inspect locally; do not share tokens or private configuration.".format(type(error).__name__), file=sys.stderr)
        sys.exit(1)
