"""Configure a scoped collector secret; never print tokens or secret values."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
from datetime import datetime, timezone
import urllib.request
from nacl.public import PublicKey, SealedBox

repo = "frentenacional1210/War-Era-Intelligence"
result = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\nusername=frentenacional1210\n\n", text=True, capture_output=True, check=True)
credential = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
headers = {"Authorization": "Bearer " + credential["password"], "Accept": "application/vnd.github+json", "User-Agent": "WINT-collector-setup"}

def api(path, method="GET", body=None):
    request = urllib.request.Request("https://api.github.com" + path, headers=headers, method=method, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

if api("/user")["login"] != "frentenacional1210":
    raise RuntimeError("GitHub credential does not belong to the repository owner")
account_repo = api("/repos/" + repo)
if account_repo["private"] or not account_repo["permissions"]["admin"]:
    raise RuntimeError("Automatic setup requires this public repository and its administrator")

path = Path("artifacts/private/COLLECTOR_SECRET.txt")
path.parent.mkdir(parents=True, exist_ok=True)
secret = path.read_text().strip() if path.exists() else secrets.token_urlsafe(48)
path.write_text(secret + "\n")
if os.name == "nt":
    subprocess.run(["icacls", str(path.resolve()), "/inheritance:r", "/grant:r", os.environ["USERNAME"] + ":F", "SYSTEM:F"], capture_output=True, check=True)

wrangler = subprocess.run(["node", "node_modules/wrangler/bin/wrangler.js", "secret", "put", "COLLECTOR_SECRET"], input=secret, text=True, encoding="utf-8", capture_output=True)
if wrangler.returncode:
    raise RuntimeError("Cloudflare collector secret setup failed; inspect Wrangler authentication")
key = api("/repos/" + repo + "/actions/secrets/public-key")
encrypted = SealedBox(PublicKey(base64.b64decode(key["key"]))).encrypt(secret.encode())
api("/repos/" + repo + "/actions/secrets/WINT_COLLECTOR_SECRET", "PUT", {"key_id": key["key_id"], "encrypted_value": base64.b64encode(encrypted).decode()})
evidence = {"configuredAt": datetime.now(timezone.utc).isoformat(), "publicRepository": True, "cloudflareSecretConfigured": True, "githubSecretConfigured": True, "secretValueExcluded": True}
Path("artifacts/validation/collector-setup.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps(evidence))
