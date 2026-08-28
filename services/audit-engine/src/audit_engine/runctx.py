"""RunContext: run identity, artifact paths, input snapshotting, manifest."""
from __future__ import annotations

import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from .config import Config, config_hash


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class RunContext:
    def __init__(self, config: Config, runs_root: str | Path = "runs", client: str | None = None):
        self.config = config
        self.client = client or config.client
        self.cfg_hash = config_hash(config)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_id = f"{stamp}_{self.cfg_hash[:8]}"
        self.root = Path(runs_root) / self.client / self.run_id
        self.tables = self.root / "tables"
        self.report_dir = self.root / "report"
        self.inputs = self.root / "inputs"
        for p in (self.tables, self.report_dir, self.inputs):
            p.mkdir(parents=True, exist_ok=True)
        self._manifest: dict[str, Any] = {
            "run_id": self.run_id,
            "client": self.client,
            "config_hash": self.cfg_hash,
            "created_utc": stamp,
            "inputs": {},
            "notes": [],
        }

    def snapshot_input(self, path: str | Path) -> Path:
        """Copy a source file into the run dir and record its hash."""
        src = Path(path)
        dst = self.inputs / src.name
        shutil.copy2(src, dst)
        self._manifest["inputs"][src.name] = _file_sha256(src)
        return dst

    def note(self, message: str) -> None:
        self._manifest["notes"].append(message)

    def write_manifest(self, extra: dict[str, Any] | None = None) -> Path:
        if extra:
            self._manifest.update(extra)
        out = self.root / "manifest.yaml"
        with open(out, "w", encoding="utf-8") as f:
            yaml.safe_dump(self._manifest, f, sort_keys=False)
        return out
