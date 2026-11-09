"""Build a local audit ZIP and a directory-based MCP creation request.

Usage: python tools/cloudbase-fn/package-channel-gateway.py CREATE_REQUEST.json OUTPUT_DIRECTORY
Only produces local reviewable artifacts; never calls cloud services.

The current MCP createFunction handler does not forward zipFile to Manager SDK.
The ZIP is an audit artifact, not the input used by the generated request.
"""
import json
from pathlib import Path
import stat
import sys
import zipfile


def main():
    request_file, output_dir = map(Path, sys.argv[1:])
    request = json.loads(request_file.read_text(encoding="utf-8"))
    args = request["arguments"]
    if request["name"] != "manageFunctions" or args["action"] != "createFunction" or args["func"]["name"] != "weshirt-channel-gateway":
        raise ValueError("unexpected deployment request")
    source = Path(args["functionRootPath"]) / "weshirt-channel-gateway"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / "weshirt-channel-gateway.zip"
    names = ["index.cjs", "package.json", "scf_bootstrap"]
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name in names:
            path = source / name
            if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()):
                raise ValueError("unexpected package path")
            data = path.read_bytes()
            if name == "scf_bootstrap" and (b"\r" in data or not data.startswith(b"#!/bin/sh\n")):
                raise ValueError("bootstrap must use LF and no BOM")
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | (0o755 if name == "scf_bootstrap" else 0o644)) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(entry, data)
    with zipfile.ZipFile(archive) as target:
        assert target.testzip() is None
        assert (target.getinfo("scf_bootstrap").external_attr >> 16) & 0o777 == 0o755
    # Preserve the absolute parent directory. A ZIP-only create request fails in
    # the current MCP handler, and adding zipFile would not upload this archive.
    args.pop("zipFile", None)
    (output_dir / "create-function-with-root.json").write_text(json.dumps(request), encoding="utf-8")
    print("Prepared audit ZIP and directory-based request; no cloud changes made.")
    print("MCP repackages functionRootPath; verify the deployed archive and health endpoint.")


if __name__ == "__main__":
    main()
