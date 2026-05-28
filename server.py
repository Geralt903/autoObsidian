#!/usr/bin/env python3
import json
import os
import sys
import urllib.parse
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests


DEFAULT_TIMEOUT = float(os.environ.get("FNS_TIMEOUT", "30"))


@dataclass
class Config:
    base_url: str
    token: str
    default_vault: str


def load_config() -> Config:
    base_url = os.environ.get("FNS_BASE_URL", "http://127.0.0.1:9000").rstrip("/")
    token = os.environ.get("FNS_TOKEN", "")
    default_vault = os.environ.get("FNS_DEFAULT_VAULT", "Life-Learing")
    if not token:
        raise RuntimeError("FNS_TOKEN is required")
    return Config(base_url=base_url, token=token, default_vault=default_vault)


class FNSClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.cfg.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str, *, params=None, json_body=None):
        url = f"{self.cfg.base_url}{path}"
        resp = requests.request(
            method,
            url,
            headers=self._headers(),
            params=params,
            json=json_body,
            timeout=DEFAULT_TIMEOUT,
        )
        if not resp.ok:
            raise RuntimeError(f"FNS {method} {path} failed: {resp.status_code} {resp.text[:500]}")
        if not resp.text.strip():
            return None
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype:
            return resp.json()
        return resp.text

    def health(self):
        return self._request("GET", "/api/health")

    def vault_list(self):
        for path in ("/api/vaults", "/api/vault"):
            try:
                return self._request("GET", path)
            except Exception:
                pass
        return {"default_vault": self.cfg.default_vault}

    def note_list(self, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        candidates = [
            ("/api/notes", {"vault": vault}),
            ("/api/notes", {"vaultName": vault}),
            ("/api/vaults/notes", {"vault": vault}),
            (f"/api/vaults/{urllib.parse.quote(vault)}/notes", None),
        ]
        last = None
        for path, params in candidates:
            try:
                return self._request("GET", path, params=params)
            except Exception as e:
                last = e
        raise last or RuntimeError("note_list failed")

    def note_search(self, query: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        candidates = [
            ("/api/search", {"q": query, "vault": vault}),
            ("/api/search", {"query": query, "vault": vault}),
            ("/api/notes/search", {"q": query, "vault": vault}),
        ]
        last = None
        for path, params in candidates:
            try:
                return self._request("GET", path, params=params)
            except Exception as e:
                last = e
        raise last or RuntimeError("note_search failed")

    def note_get(self, path_or_id: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        candidates = [
            (f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}", {"vault": vault}),
            ("/api/note", {"path": path_or_id, "vault": vault}),
            ("/api/notes/content", {"path": path_or_id, "vault": vault}),
        ]
        last = None
        for path, params in candidates:
            try:
                return self._request("GET", path, params=params)
            except Exception as e:
                last = e
        raise last or RuntimeError("note_get failed")

    def note_append(self, path_or_id: str, content: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        body = {"path": path_or_id, "content": content, "vault": vault}
        for path in ("/api/notes/append", f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}/append"):
            try:
                return self._request("POST", path, json_body=body)
            except Exception:
                pass
        raise RuntimeError("note_append failed")

    def note_prepend(self, path_or_id: str, content: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        body = {"path": path_or_id, "content": content, "vault": vault}
        for path in ("/api/notes/prepend", f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}/prepend"):
            try:
                return self._request("POST", path, json_body=body)
            except Exception:
                pass
        raise RuntimeError("note_prepend failed")

    def note_replace(self, path_or_id: str, old: str, new: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        body = {"path": path_or_id, "old": old, "new": new, "vault": vault}
        for path in ("/api/notes/replace", f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}/replace"):
            try:
                return self._request("POST", path, json_body=body)
            except Exception:
                pass
        raise RuntimeError("note_replace failed")

    def note_patch_frontmatter(self, path_or_id: str, patch: Dict[str, Any], vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        body = {"path": path_or_id, "frontmatter": patch, "vault": vault}
        for path in ("/api/notes/frontmatter", f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}/frontmatter"):
            try:
                return self._request("PATCH", path, json_body=body)
            except Exception:
                pass
        raise RuntimeError("note_patch_frontmatter failed")

    def note_create_or_update(self, path_or_id: str, content: str, vault: Optional[str] = None):
        vault = vault or self.cfg.default_vault
        body = {"path": path_or_id, "content": content, "vault": vault}
        for path in ("/api/notes", f"/api/notes/{urllib.parse.quote(path_or_id, safe='')}"):
            try:
                return self._request("PUT", path, json_body=body)
            except Exception:
                pass
        raise RuntimeError("note_create_or_update failed")


def tool_schemas():
    return [
        {"name": "vault_list", "description": "List available vaults.", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "note_list", "description": "List notes in a vault.", "inputSchema": {"type": "object", "properties": {"vault": {"type": "string"}}}},
        {"name": "note_search", "description": "Search notes by text query.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "vault": {"type": "string"}}, "required": ["query"]}},
        {"name": "note_get", "description": "Read a note by path or id.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "vault": {"type": "string"}}, "required": ["path_or_id"]}},
        {"name": "note_append", "description": "Append content to a note.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "content": {"type": "string"}, "vault": {"type": "string"}}, "required": ["path_or_id", "content"]}},
        {"name": "note_prepend", "description": "Prepend content to a note.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "content": {"type": "string"}, "vault": {"type": "string"}}, "required": ["path_or_id", "content"]}},
        {"name": "note_replace", "description": "Replace text in a note.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}, "vault": {"type": "string"}}, "required": ["path_or_id", "old", "new"]}},
        {"name": "note_patch_frontmatter", "description": "Patch note frontmatter.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "patch": {"type": "object"}, "vault": {"type": "string"}}, "required": ["path_or_id", "patch"]}},
        {"name": "note_create_or_update", "description": "Create or update a note.", "inputSchema": {"type": "object", "properties": {"path_or_id": {"type": "string"}, "content": {"type": "string"}, "vault": {"type": "string"}}, "required": ["path_or_id", "content"]}},
    ]


def make_text_result(text: str):
    return {"content": [{"type": "text", "text": text}]}


def handle_call(client: FNSClient, name: str, args: Dict[str, Any]):
    if name == "vault_list":
        return client.vault_list()
    if name == "note_list":
        return client.note_list(args.get("vault"))
    if name == "note_search":
        return client.note_search(args["query"], args.get("vault"))
    if name == "note_get":
        return client.note_get(args["path_or_id"], args.get("vault"))
    if name == "note_append":
        return client.note_append(args["path_or_id"], args["content"], args.get("vault"))
    if name == "note_prepend":
        return client.note_prepend(args["path_or_id"], args["content"], args.get("vault"))
    if name == "note_replace":
        return client.note_replace(args["path_or_id"], args["old"], args["new"], args.get("vault"))
    if name == "note_patch_frontmatter":
        return client.note_patch_frontmatter(args["path_or_id"], args["patch"], args.get("vault"))
    if name == "note_create_or_update":
        return client.note_create_or_update(args["path_or_id"], args["content"], args.get("vault"))
    raise RuntimeError(f"Unknown tool: {name}")


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.decode("utf-8").strip()
        if not line:
            break
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.lower().strip()] = v.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    raw = sys.stdin.buffer.read(length)
    return json.loads(raw.decode("utf-8"))


def write_message(msg: Dict[str, Any]):
    raw = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("utf-8"))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def main():
    cfg = load_config()
    client = FNSClient(cfg)
    while True:
        msg = read_message()
        if msg is None:
            return
        method = msg.get("method")
        msg_id = msg.get("id")
        try:
            if method == "initialize":
                result = {
                    "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "serverInfo": {"name": "fns-local", "version": "0.1.0"},
                    "capabilities": {"tools": {}},
                }
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": result})
            elif method == "notifications/initialized":
                continue
            elif method == "tools/list":
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tool_schemas()}})
            elif method == "tools/call":
                params = msg.get("params", {})
                result = handle_call(client, params["name"], params.get("arguments", {}))
                if isinstance(result, (dict, list)):
                    payload = json.dumps(result, ensure_ascii=False, indent=2)
                else:
                    payload = str(result)
                write_message({"jsonrpc": "2.0", "id": msg_id, "result": make_text_result(payload)})
            else:
                if msg_id is not None:
                    write_message({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}})
        except Exception as e:
            if msg_id is not None:
                write_message({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": str(e)}})


if __name__ == "__main__":
    main()
