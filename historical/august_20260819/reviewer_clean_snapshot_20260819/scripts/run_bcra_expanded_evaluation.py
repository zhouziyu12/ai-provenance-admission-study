"""Run the BCRA multi-user, multi-model, multi-version evaluation on Sepolia."""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from sdk.python.provenance_sdk import ProvenanceSDK  # noqa: E402


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3200)
    parser.add_argument(
        "--rpc",
        default=os.getenv("BCRA_SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com"),
    )
    parser.add_argument(
        "--output-dir",
        default=str(PROJECT_ROOT / "docs" / "bcra_revision" / "evidence" / "expanded_evaluation"),
    )
    return parser.parse_args()


class TimedProvenanceSDK(ProvenanceSDK):
    def reset_measurements(self) -> None:
        self.stage_seconds: dict[str, float] = {}
        self.registration_result: dict[str, Any] = {}

    def _timed(self, name: str, function, *args, **kwargs):
        started = time.perf_counter()
        try:
            return function(*args, **kwargs)
        finally:
            self.stage_seconds[name] = round(time.perf_counter() - started, 6)

    def _sha256_file(self, path: str) -> str:
        return self._timed("hash", super()._sha256_file, path)

    def _ensure_model_registered(self, model_name: str, chain: str, model_hash: str):
        result = self._timed(
            "registration_resolution",
            super()._ensure_model_registered,
            model_name,
            chain,
            model_hash,
        )
        self.registration_result = result
        return result

    def _upload_model_to_ipfs(self, model_path: str):
        return self._timed("ipfs_upload", super()._upload_model_to_ipfs, model_path)

    def _generate_zk_proof(self, secret: str, model_id: int, statement_hash: int):
        return self._timed(
            "proof_generation",
            super()._generate_zk_proof,
            secret,
            model_id,
            statement_hash,
        )

    def _send_to_relayer(self, payload):
        return self._timed("relay_and_chain_confirmation", super()._send_to_relayer, payload)


def wait_for_backend(base_url: str, process: subprocess.Popen, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Backend exited early with code {process.returncode}")
        try:
            response = requests.get(f"{base_url}/api/health", timeout=1)
            if response.ok:
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise RuntimeError("Backend did not become ready")


def rpc_call(rpc: str, method: str, params: list[Any]) -> Any:
    response = requests.post(
        rpc,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(f"RPC {method} failed: {payload['error']}")
    return payload.get("result")


def transaction_receipt(rpc: str, tx_hash: str | None) -> dict[str, Any] | None:
    if not tx_hash:
        return None
    for _ in range(60):
        result = rpc_call(rpc, "eth_getTransactionReceipt", [tx_hash])
        if result:
            return {
                "transactionHash": result["transactionHash"],
                "blockNumber": int(result["blockNumber"], 16),
                "status": int(result["status"], 16),
                "gasUsed": int(result["gasUsed"], 16),
            }
        time.sleep(2)
    raise RuntimeError(f"Receipt not available: {tx_hash}")


def make_artifact(path: Path, series: str, version: str) -> None:
    seed = hashlib.sha256(f"{series}:{version}".encode("utf-8")).digest()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((seed + f"\n{series}\n{version}\n".encode("utf-8")) * 512)


def stable_test_secret(run_tag: str, user_alias: str, series_alias: str) -> str:
    digest = hashlib.sha256(f"{run_tag}:{user_alias}:{series_alias}".encode("utf-8")).digest()
    return str(int.from_bytes(digest[:8], "big") % (10**18 - 1) + 1)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    columns = [
        "run_id",
        "user_alias",
        "wallet_address",
        "model_series_alias",
        "version_alias",
        "lifecycle_position",
        "model_id",
        "artifact_cid",
        "registration_tx_hash",
        "registration_gas_used",
        "provenance_tx_hash",
        "provenance_gas_used",
        "receipt_status",
        "start_time_utc",
        "end_time_utc",
        "wall_clock_seconds",
        "hash_seconds",
        "registration_resolution_seconds",
        "ipfs_upload_seconds",
        "proof_generation_seconds",
        "relay_and_chain_confirmation_seconds",
        "software_commit",
        "outcome",
        "notes",
    ]
    with path.open("w", encoding="utf-8", newline="") as file_obj:
        writer = csv.DictWriter(file_obj, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    run_tag = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir = output_dir / run_tag
    run_dir.mkdir(parents=True, exist_ok=False)
    artifact_dir = PROJECT_ROOT / ".qa" / "bcra_expanded_evaluation" / run_tag / "artifacts"
    backend_log_path = run_dir / "backend.log"
    sdk_log_path = run_dir / "sdk.log"
    json_path = run_dir / "expanded_evaluation.json"
    csv_path = run_dir / "expanded_evaluation.csv"
    base_url = f"http://127.0.0.1:{args.port}"

    user2_password = os.getenv("BCRA_USER2_PASSWORD")
    if not user2_password:
        raise RuntimeError("BCRA_USER2_PASSWORD must be set for the local evaluation user")

    credentials = {
        "user_01": {
            "username": os.getenv("SDK_USERNAME") or os.getenv("PROVENANCE_USERNAME") or "researcher",
            "password": os.getenv("SDK_PASSWORD") or os.getenv("PROVENANCE_PASSWORD") or "researcher-demo-pass",
        },
        "user_02": {
            "username": os.getenv("BCRA_USER2_USERNAME", "bcra_user_02"),
            "password": user2_password,
        },
    }
    matrix = [
        ("user_01", "series_01", ["v1.0", "v2.0", "v3.0"]),
        ("user_01", "series_02", ["v1.0", "v2.0"]),
        ("user_02", "series_03", ["v1.0", "v2.0", "v3.0"]),
    ]

    child_env = os.environ.copy()
    child_env.update(
        {
            "PORT": str(args.port),
            "SEPOLIA_URL": args.rpc,
            "SEPOLIA_RPC": args.rpc,
            "WRITE_RATE_LIMIT_MAX": "1000",
            "WRITE_RATE_LIMIT_WINDOW_MS": "60000",
        }
    )
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    backend_log = backend_log_path.open("w", encoding="utf-8")
    backend = subprocess.Popen(
        ["node", str(PROJECT_ROOT / "server" / "server.js")],
        cwd=PROJECT_ROOT,
        env=child_env,
        stdout=backend_log,
        stderr=subprocess.STDOUT,
        creationflags=creation_flags,
    )

    rows: list[dict[str, Any]] = []
    try:
        wait_for_backend(base_url, backend)
        git_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, text=True
        ).strip()
        clients: dict[str, TimedProvenanceSDK] = {}
        for alias, value in credentials.items():
            client = TimedProvenanceSDK(
                base_url=base_url,
                project_root=str(PROJECT_ROOT),
                username=value["username"],
                password=value["password"],
                timeout=300,
            )
            client.reset_measurements()
            client.login()
            clients[alias] = client

        with sdk_log_path.open("w", encoding="utf-8") as sdk_log, contextlib.redirect_stdout(sdk_log), contextlib.redirect_stderr(sdk_log):
            for user_alias, series_alias, versions in matrix:
                client = clients[user_alias]
                model_name = f"BCRA_{series_alias}_{run_tag}"
                secret = stable_test_secret(run_tag, user_alias, series_alias)
                stable_model_id: int | None = None
                for position, version in enumerate(versions, start=1):
                    artifact_path = artifact_dir / user_alias / series_alias / f"{version}.bin"
                    make_artifact(artifact_path, f"{run_tag}:{series_alias}", version)
                    client.reset_measurements()
                    started_utc = utc_now()
                    started = time.perf_counter()
                    result = client.submit_provenance(
                        model_path=str(artifact_path),
                        commit_msg=f"BCRA expanded evaluation {series_alias} {version}",
                        sender="run_bcra_expanded_evaluation.py",
                        version=version,
                        secret=secret,
                        model_name=model_name,
                        chain="sepolia",
                    )
                    elapsed = round(time.perf_counter() - started, 6)
                    ended_utc = utc_now()
                    model_id = int(result["modelId"])
                    if stable_model_id is None:
                        stable_model_id = model_id
                    elif stable_model_id != model_id:
                        raise RuntimeError(f"Lifecycle modelId changed for {series_alias}")

                    registration_tx = client.registration_result.get("txHash")
                    provenance_tx = result["relayer"].get("tx")
                    registration_receipt = transaction_receipt(args.rpc, registration_tx)
                    provenance_receipt = transaction_receipt(args.rpc, provenance_tx)
                    row = {
                        "run_id": f"{run_tag}_{user_alias}_{series_alias}_{version}",
                        "user_alias": user_alias,
                        "wallet_address": result["authenticatedUser"]["walletAddress"],
                        "model_series_alias": series_alias,
                        "version_alias": version,
                        "lifecycle_position": position,
                        "model_id": model_id,
                        "artifact_cid": result["ipfs"]["ipfsCid"],
                        "registration_tx_hash": registration_tx or "",
                        "registration_gas_used": registration_receipt["gasUsed"] if registration_receipt else "",
                        "provenance_tx_hash": provenance_tx,
                        "provenance_gas_used": provenance_receipt["gasUsed"] if provenance_receipt else "",
                        "receipt_status": provenance_receipt["status"] if provenance_receipt else "",
                        "start_time_utc": started_utc,
                        "end_time_utc": ended_utc,
                        "wall_clock_seconds": elapsed,
                        "hash_seconds": client.stage_seconds.get("hash", ""),
                        "registration_resolution_seconds": client.stage_seconds.get("registration_resolution", ""),
                        "ipfs_upload_seconds": client.stage_seconds.get("ipfs_upload", ""),
                        "proof_generation_seconds": client.stage_seconds.get("proof_generation", ""),
                        "relay_and_chain_confirmation_seconds": client.stage_seconds.get("relay_and_chain_confirmation", ""),
                        "software_commit": git_commit,
                        "outcome": "PASS" if provenance_receipt and provenance_receipt["status"] == 1 else "FAIL",
                        "notes": "Owner assignment is relay-mediated in the current prototype; EIP-712 is not yet integrated.",
                    }
                    rows.append(row)
                    sdk_log.flush()

        distinct_users = len({row["user_alias"] for row in rows})
        distinct_series = len({row["model_series_alias"] for row in rows})
        lifecycle_lengths = {
            series: len([row for row in rows if row["model_series_alias"] == series])
            for series in {row["model_series_alias"] for row in rows}
        }
        all_passed = all(row["outcome"] == "PASS" for row in rows)
        summary = {
            "timestamp": utc_now(),
            "network": "sepolia",
            "softwareCommit": git_commit,
            "runCount": len(rows),
            "distinctAuthenticatedUsers": distinct_users,
            "distinctModelSeries": distinct_series,
            "lifecycleLengths": lifecycle_lengths,
            "longestLifecycle": max(lifecycle_lengths.values()),
            "allReceiptsSuccessful": all_passed,
            "acceptance": {
                "moreThanOneUser": distinct_users > 1,
                "severalModelSeries": distinct_series >= 3,
                "lifecycleLongerThanTwoVersions": max(lifecycle_lengths.values()) > 2,
                "allRunsPassed": all_passed,
            },
        }
        json_path.write_text(json.dumps({"summary": summary, "runs": rows}, indent=2) + "\n", encoding="utf-8")
        write_csv(csv_path, rows)
        print(json.dumps({"summary": summary, "jsonPath": str(json_path), "csvPath": str(csv_path)}, indent=2))
        return 0 if all(summary["acceptance"].values()) else 1
    finally:
        backend.terminate()
        try:
            backend.wait(timeout=10)
        except subprocess.TimeoutExpired:
            backend.kill()
        backend_log.close()


if __name__ == "__main__":
    raise SystemExit(main())
