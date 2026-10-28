"""
Python SDK for the verifier-gated provenance pipeline.

Primary write path:
1. authenticate with username/password to obtain a JWT
2. resolve or register a model under the authenticated owner's wallet address
3. upload the artifact through the backend relay
4. generate a Groth16 proof locally
5. submit canonical metadata + proof to the backend relay
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Protocol

import requests
from eth_utils import keccak

SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617
SIGNED_ZK_TYPES = {"SignedZKSubmission": [
    {"name": "modelId", "type": "uint256"}, {"name": "eventType", "type": "uint8"},
    {"name": "metadataHash", "type": "bytes32"}, {"name": "nullifier", "type": "uint256"},
    {"name": "nonce", "type": "uint256"}, {"name": "expectedHead", "type": "bytes32"},
    {"name": "deadline", "type": "uint256"},
]}


class TypedDataSigner(Protocol):
    """User-controlled signer. Implementations must never expose the private key."""

    def sign_typed_data(
        self, domain: Dict[str, Any], types: Dict[str, Any], message: Dict[str, Any]
    ) -> str:
        ...

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency fallback
    load_dotenv = None


class ProvenanceSDK:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:3000",
        project_root: Optional[str] = None,
        pinata_api_key: Optional[str] = None,
        pinata_secret_api_key: Optional[str] = None,
        write_api_key: Optional[str] = None,  # deprecated, retained for compatibility
        username: Optional[str] = None,
        password: Optional[str] = None,
        access_token: Optional[str] = None,
        timeout: int = 300,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.project_root = (
            Path(project_root)
            if project_root
            else Path(__file__).resolve().parent.parent.parent
        )
        self.timeout = timeout

        env_path = self.project_root / ".env"
        if load_dotenv and env_path.exists():
            load_dotenv(env_path, override=False)

        self.username = username or os.getenv("SDK_USERNAME") or os.getenv("PROVENANCE_USERNAME")
        self.password = password or os.getenv("SDK_PASSWORD") or os.getenv("PROVENANCE_PASSWORD")
        self.auth_token = access_token or os.getenv("SDK_ACCESS_TOKEN") or os.getenv("PROVENANCE_ACCESS_TOKEN")
        self.current_user: Optional[Dict[str, Any]] = None

        self.write_api_key = write_api_key
        self.pinata_api_key = pinata_api_key or os.getenv("PINATA_API_KEY")
        self.pinata_secret_api_key = (
            pinata_secret_api_key
            or os.getenv("PINATA_SECRET_API_KEY")
            or os.getenv("PINATA_SECRET")
        )

    # ------------------------------- Utilities -------------------------------

    @staticmethod
    def _sha256_file(path: str) -> str:
        digest = hashlib.sha256()
        with open(path, "rb") as file_obj:
            for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
                digest.update(chunk)
        return "0x" + digest.hexdigest()

    @staticmethod
    def _keccak_to_field(payload: str) -> int:
        field_modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        return int.from_bytes(keccak(text=payload), byteorder="big") % field_modulus

    @staticmethod
    def _safe_json_load(path: Path, default: Any) -> Any:
        try:
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
        return default

    @staticmethod
    def _canonical_json(payload: Dict[str, Any]) -> str:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _proof_to_contract_args(proof: Dict[str, Any], public_signals: Any) -> Dict[str, Any]:
        if not proof:
            raise RuntimeError("Proof JSON is empty")
        if not isinstance(public_signals, list) or len(public_signals) != 3:
            raise RuntimeError("Expected exactly 3 public signals for verifier-gated submission")

        return {
            "pA": [str(proof["pi_a"][0]), str(proof["pi_a"][1])],
            "pB": [
                [str(proof["pi_b"][0][1]), str(proof["pi_b"][0][0])],
                [str(proof["pi_b"][1][1]), str(proof["pi_b"][1][0])],
            ],
            "pC": [str(proof["pi_c"][0]), str(proof["pi_c"][1])],
            "publicSignals": [str(value) for value in public_signals],
        }

    @staticmethod
    def _response_error(response: requests.Response, fallback: str) -> str:
        try:
            payload = response.json()
        except Exception:
            payload = None
        if isinstance(payload, dict):
            return payload.get("error") or payload.get("message") or fallback
        return fallback

    # ----------------------------- Authentication ----------------------------

    def _fetch_current_user(self) -> Dict[str, Any]:
        if not self.auth_token:
            raise RuntimeError("No access token is available")

        response = requests.get(
            f"{self.base_url}/api/auth/me",
            headers={"Authorization": f"Bearer {self.auth_token}"},
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Failed to validate access token"))

        payload = response.json()
        user = payload.get("user")
        if not payload.get("success") or not isinstance(user, dict):
            raise RuntimeError(f"Unexpected /api/auth/me payload: {payload}")

        self.current_user = user
        return user

    def login(self, force: bool = False) -> Dict[str, Any]:
        if self.auth_token and not force:
            try:
                user = self._fetch_current_user()
                return {"token": self.auth_token, "user": user}
            except Exception:
                self.auth_token = None
                self.current_user = None

        if not self.username or not self.password:
            raise RuntimeError("SDK username/password must be configured before login")

        response = requests.post(
            f"{self.base_url}/api/auth/login",
            json={"username": self.username, "password": self.password},
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Authentication failed"))

        payload = response.json()
        if not payload.get("success") or not payload.get("token") or not isinstance(payload.get("user"), dict):
            raise RuntimeError(f"Unexpected /api/auth/login payload: {payload}")

        self.auth_token = payload["token"]
        self.current_user = payload["user"]
        return payload

    def _ensure_authenticated(self) -> Dict[str, Any]:
        if self.current_user and self.auth_token:
            return self.current_user
        if self.auth_token:
            return self._fetch_current_user()
        login_payload = self.login()
        return login_payload["user"]

    def _build_auth_headers(self) -> Dict[str, str]:
        self._ensure_authenticated()
        if not self.auth_token:
            raise RuntimeError("Authentication token is unavailable after login")
        return {"Authorization": f"Bearer {self.auth_token}"}

    # ------------------------------ ZK Wrapper -------------------------------

    def _generate_zk_proof(self, secret: str, model_id: int, statement_hash: int) -> Dict[str, Any]:
        """
        Bridge local proof generation through test_zk_standalone.js using
        per-run output directories to avoid concurrent file collisions.

        The circuit input still uses the generic `messageHash` field name for
        compatibility with the existing witness format, but the SDK treats it
        as the verifier statement hash derived from canonical metadata.
        """
        print(f"[SDK] Generating ZK proof for modelId={model_id}...")

        run_dir = self.project_root / ".proof_runs" / (
            datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{secrets.token_hex(6)}"
        )
        run_dir.mkdir(parents=True, exist_ok=True)

        input_path = run_dir / "last_proof_input.json"
        proof_path = run_dir / "proof.json"
        public_path = run_dir / "public.json"
        calldata_debug_path = run_dir / "proof_calldata_debug.txt"

        input_path.write_text(
            json.dumps(
                {
                    "secret": str(secret),
                    "modelId": str(model_id),
                    "statementHash": str(statement_hash),
                    "messageHash": str(statement_hash),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"[SDK] Proof input written: {input_path}")

        env = os.environ.copy()
        env["PROOF_INPUT_PATH"] = str(input_path)
        env["PROOF_OUTPUT_PATH"] = str(proof_path)
        env["PUBLIC_OUTPUT_PATH"] = str(public_path)
        env["PROOF_CALLDATA_OUTPUT_PATH"] = str(calldata_debug_path)

        command = ["node", "test_zk_standalone.js"]
        print("[SDK] Running proof generator with isolated output paths...")

        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NO_WINDOW

        result = subprocess.run(
            command,
            cwd=str(self.project_root),
            timeout=120,
            env=env,
            creationflags=creation_flags,
        )

        if result.returncode != 0 and not (
            proof_path.exists() and public_path.exists() and calldata_debug_path.exists()
        ):
            raise RuntimeError(
                f"ZK proof generation failed with exit code {result.returncode} and no complete output set"
            )

        proof = self._safe_json_load(proof_path, default={})
        public_signals = self._safe_json_load(public_path, default=[])
        if not calldata_debug_path.exists():
            raise RuntimeError(f"Calldata debug file not found: {calldata_debug_path}")

        raw = calldata_debug_path.read_text(encoding="utf-8", errors="ignore").strip()
        marker_start = "========== Solidity Calldata =========="
        marker_end = "======================================="
        calldata = raw
        if marker_start in raw:
            calldata = raw.split(marker_start, 1)[1]
            if marker_end in calldata:
                calldata = calldata.split(marker_end, 1)[0]
            calldata = calldata.strip()

        return {
            "zk": {
                "ok": True,
                "engine": "snarkjs.groth16",
                "runDir": str(run_dir),
                "inputFile": str(input_path),
                "proofFile": str(proof_path),
                "publicFile": str(public_path),
                "proof": proof,
                "publicSignals": public_signals,
                "calldata": calldata,
                "calldataFile": str(calldata_debug_path),
            }
        }

    # ------------------------------ IPFS Wrapper -----------------------------

    def _upload_model_to_ipfs(self, model_path: str) -> Dict[str, Any]:
        print(f"[SDK] Uploading model to IPFS: {model_path}")

        artifact_path = Path(model_path)
        if not artifact_path.exists():
            raise FileNotFoundError(f"Model file not found: {model_path}")

        if self.pinata_api_key and self.pinata_secret_api_key:
            url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
            headers = {
                "pinata_api_key": self.pinata_api_key,
                "pinata_secret_api_key": self.pinata_secret_api_key,
            }
            metadata = {"name": artifact_path.name}

            with open(artifact_path, "rb") as file_obj:
                files = {
                    "file": (artifact_path.name, file_obj, "application/octet-stream"),
                    "pinataMetadata": (None, json.dumps(metadata), "application/json"),
                }
                response = requests.post(url, headers=headers, files=files, timeout=self.timeout)
                response.raise_for_status()
                payload = response.json()

            cid = payload.get("IpfsHash")
            return {"ok": True, "ipfsCid": cid, "provider": "pinata-direct"}

        with open(artifact_path, "rb") as file_obj:
            response = requests.post(
                f"{self.base_url}/api/ipfs/upload/file",
                json={
                    "data": base64.b64encode(file_obj.read()).decode("ascii"),
                    "fileName": artifact_path.name,
                },
                headers=self._build_auth_headers(),
                timeout=self.timeout,
            )

        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Backend IPFS upload failed"))

        payload = response.json()
        if not payload.get("success") or not payload.get("cid"):
            raise RuntimeError(f"Unexpected backend IPFS payload: {payload}")

        return {"ok": True, "ipfsCid": payload["cid"], "provider": "backend-relay"}

    # --------------------------- Backend Communication -----------------------

    def _send_to_relayer(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        print(f"[SDK] Submitting to verifier-gated relayer: {self.base_url}/api/sdk/provenance")
        response = requests.post(
            f"{self.base_url}/api/sdk/provenance",
            json=payload,
            headers=self._build_auth_headers(),
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Relayer submission failed"))

        data = response.json()
        if not data.get("success"):
            raise RuntimeError(f"Relayer returned failure: {data}")
        return data

    def _get_eip712_config(self, model_id: int, chain: str) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/sdk/eip712/config",
            params={"chain": chain, "modelId": model_id},
            headers=self._build_auth_headers(),
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "EIP-712 configuration failed"))
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"EIP-712 configuration returned failure: {payload}")
        return payload

    def submit_eip712_record(
        self,
        model_id: int,
        model_name: str,
        chain: str,
        canonical_metadata: str,
        signer: TypedDataSigner,
        nonce: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Sign locally and relay an EIP-712-gated provenance record."""
        user = self._ensure_authenticated()
        config = self._get_eip712_config(model_id, chain)
        parsed_metadata = json.loads(canonical_metadata)
        action_codes = {
            "REGISTERED": 0,
            "ACTIVATED": 1,
            "UPDATED": 2,
            "DEPRECATED": 3,
            "REVOKED": 4,
            "VERSION_RELEASED": 5,
            "TRANSFERRED": 6,
            "STAKED": 7,
            "UNSTAKED": 8,
            "SLASHED": 9,
            "ZK_PROOF_VERIFIED": 10,
        }
        action = parsed_metadata.get("action")
        if action not in action_codes:
            raise ValueError(f"Unsupported provenance action: {action}")
        statement_hash = self._keccak_to_field(canonical_metadata)
        selected_nonce = nonce if nonce is not None else secrets.randbits(256)
        message = {
            "modelId": model_id,
            "eventType": action_codes[action],
            "statementHash": statement_hash,
            "nonce": selected_nonce,
        }
        signature = signer.sign_typed_data(config["domain"], config["types"], message)
        if not isinstance(signature, str) or not signature.startswith("0x"):
            raise ValueError("Typed-data signer must return a 0x-prefixed signature")
        response = requests.post(
            f"{self.base_url}/api/sdk/provenance/eip712",
            json={
                "modelId": model_id,
                "modelName": model_name,
                "chain": chain,
                "canonicalMetadata": canonical_metadata,
                "nonce": str(selected_nonce),
                "signature": signature,
            },
            headers=self._build_auth_headers(),
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "EIP-712 relayer submission failed"))
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"EIP-712 relayer returned failure: {payload}")
        return {"authenticatedUser": user, "typedData": {"domain": config["domain"],
            "types": config["types"], "message": message}, "relayer": payload}

    def submit_signed_zk_record(
        self, model_id: int, model_name: str, chain: str, canonical_metadata: str,
        zk_proof: Dict[str, Any], signer: TypedDataSigner,
        verifying_contract: str, chain_id: int,
        nonce: Optional[int] = None, deadline: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Require both proof and owner signature. Pin domain using independently trusted deployment data.

        A failed submission is never retried with a fresh signature or downgraded to an unsigned route.
        The private signing key stays inside the caller-provided signer.
        """
        user = self._ensure_authenticated()
        if not isinstance(verifying_contract, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", verifying_contract):
            raise ValueError("verifying_contract must be a trusted deployment address")
        if int(verifying_contract, 16) == 0 or type(chain_id) is not int or chain_id <= 0:
            raise ValueError("A nonzero contract address and positive chain_id are required")
        if type(model_id) is not int or not 0 < model_id <= 2**53 - 1:
            raise ValueError("model_id must be a positive safe integer")
        metadata = json.loads(canonical_metadata)
        if not isinstance(metadata, dict):
            raise ValueError("canonical_metadata must encode an object")
        if metadata.get("modelName") != model_name or metadata.get("chain") != chain:
            raise ValueError("Metadata does not match model name or chain")
        if str(metadata.get("sender", "")).lower() != user["walletAddress"].lower():
            raise ValueError("Metadata sender must match the authenticated owner")
        actions = ["REGISTERED", "ACTIVATED", "UPDATED", "DEPRECATED", "REVOKED",
                   "VERSION_RELEASED", "TRANSFERRED", "STAKED", "UNSTAKED", "SLASHED", "ZK_PROOF_VERIFIED"]
        if metadata.get("action") not in actions:
            raise ValueError("Unsupported provenance action")
        signals = zk_proof.get("publicSignals")
        if not isinstance(signals, list) or len(signals) != 3:
            raise ValueError("Expected three proof public signals")
        signals = [int(value) for value in signals]
        if any(value < 0 or value >= SNARK_FIELD for value in signals):
            raise ValueError("Proof public signals must be canonical field elements")
        if signals[1] != model_id or signals[2] != self._keccak_to_field(canonical_metadata):
            raise ValueError("Proof does not match model or metadata")
        selected_nonce = secrets.randbits(256) if nonce is None else nonce
        now = int(datetime.now(timezone.utc).timestamp())
        selected_deadline = now + 900 if deadline is None else deadline
        for label, value in (("nonce", selected_nonce), ("deadline", selected_deadline)):
            if type(value) is not int or not 0 <= value < 2**256:
                raise ValueError(f"{label} must be a uint256 integer")
        if selected_deadline <= now:
            raise ValueError("Authorization deadline must be in the future")

        response = requests.get(f"{self.base_url}/api/sdk/signed-zk/config",
                                params={"chain": chain, "modelId": model_id},
                                headers=self._build_auth_headers(), timeout=self.timeout)
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Signed ZK configuration failed"))
        config = response.json()
        if not config.get("success"):
            raise RuntimeError("Signed ZK configuration returned failure")
        domain = {"name": "SignedZKProvenance", "version": "1", "chainId": chain_id,
                  "verifyingContract": verifying_contract}
        supplied = config.get("domain", {})
        if (set(supplied) != set(domain) or supplied.get("name") != domain["name"] or
                supplied.get("version") != domain["version"] or
                str(supplied.get("chainId")) != str(chain_id) or
                str(supplied.get("verifyingContract", "")).lower() != verifying_contract.lower()):
            raise ValueError("Backend signing domain does not match trusted deployment")
        if config.get("types") != SIGNED_ZK_TYPES:
            raise ValueError("Unexpected signed ZK schema")
        if str(config.get("owner", "")).lower() != user["walletAddress"].lower():
            raise ValueError("Backend owner does not match authenticated owner")
        expected_head = config.get("expectedHead", "")
        if not isinstance(expected_head, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", expected_head):
            raise ValueError("Invalid expected chain head")
        message = {"modelId": model_id, "eventType": actions.index(metadata["action"]),
                   "metadataHash": "0x" + keccak(text=canonical_metadata).hex(), "nullifier": signals[0],
                   "nonce": selected_nonce, "expectedHead": expected_head, "deadline": selected_deadline}
        signature = signer.sign_typed_data(domain, SIGNED_ZK_TYPES, message)
        if not isinstance(signature, str) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
            raise ValueError("Signer must return a 65-byte signature")
        response = requests.post(f"{self.base_url}/api/sdk/provenance/signed-zk", json={
            "modelId": model_id, "modelName": model_name, "chain": chain,
            "canonicalMetadata": canonical_metadata, "zkProof": zk_proof,
            "nonce": str(selected_nonce), "expectedHead": expected_head,
            "deadline": str(selected_deadline), "signature": signature,
        }, headers=self._build_auth_headers(), timeout=self.timeout)
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Signed ZK submission failed"))
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError("Signed ZK submission returned failure")
        return {"authenticatedUser": user, "typedData": {"domain": domain, "types": SIGNED_ZK_TYPES,
                "message": message}, "relayer": payload}

    def _list_models(self, chain: str) -> Dict[str, Any]:
        response = requests.get(
            f"{self.base_url}/api/v2/models",
            params={"chain": chain},
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"Model list request failed: {payload}")
        return payload

    def _resolve_model_by_owner(self, model_name: str, chain: str, owner: str) -> Optional[Dict[str, Any]]:
        response = requests.get(
            f"{self.base_url}/api/v2/models/resolve",
            params={"chain": chain, "owner": owner, "name": model_name},
            timeout=self.timeout,
        )
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Model resolution failed"))

        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"Model resolution returned failure: {payload}")
        return payload.get("model")

    def _find_model_by_name(
        self, model_name: str, chain: str, owner: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        user = self._ensure_authenticated() if owner is None else None
        scoped_owner = owner or user["walletAddress"]
        return self._resolve_model_by_owner(model_name, chain, scoped_owner)

    def _register_model(self, model_name: str, chain: str, model_hash: str) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/api/register",
            json={
                "name": model_name,
                "description": f"Registered by ProvenanceSDK for {model_name}",
                "checksum": model_hash,
                "framework": "PyTorch",
                "license": "MIT",
                "chain": chain,
            },
            headers=self._build_auth_headers(),
            timeout=self.timeout,
        )
        if response.status_code >= 400:
            raise RuntimeError(self._response_error(response, "Model registration failed"))

        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"Model registration failed: {payload}")
        return payload

    def _ensure_model_registered(self, model_name: str, chain: str, model_hash: str) -> Dict[str, Any]:
        user = self._ensure_authenticated()
        existing = self._resolve_model_by_owner(model_name, chain, user["walletAddress"])
        if existing:
            return existing
        return self._register_model(model_name, chain, model_hash)

    # ----------------------------- Public API --------------------------------

    def submit_provenance(
        self,
        model_path: str,
        commit_msg: str,
        sender: str,
        version: str,
        secret: Optional[str] = None,
        model_name: Optional[str] = None,
        chain: str = "sepolia",
        signer: Optional[TypedDataSigner] = None,
        verifying_contract: Optional[str] = None,
        chain_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        print("\n" + "=" * 60)
        print("SDK PIPELINE START")
        print("=" * 60)

        if signer is not None and (not verifying_contract or not chain_id):
            raise ValueError("Signed ZK submission requires trusted verifying_contract and chain_id")
        if signer is None and (verifying_contract is not None or chain_id is not None):
            raise ValueError("Signed ZK deployment parameters require a signer")
        secret = str(secrets.randbelow(SNARK_FIELD - 1) + 1) if secret is None else secret
        user = self._ensure_authenticated()
        model_path = str(Path(model_path).resolve())
        effective_model_name = model_name or Path(model_path).stem

        print("[SDK] Step 1/6: Hashing model file...")
        model_hash = self._sha256_file(model_path)
        print(f"[SDK] Model hash: {model_hash}")

        print("[SDK] Step 2/6: Resolving owner-scoped on-chain model registration...")
        registry_model = self._ensure_model_registered(effective_model_name, chain, model_hash)
        model_id = int(registry_model["numericId"] if "numericId" in registry_model else registry_model["id"])
        print(
            f"[SDK] Resolved model scope: chain={chain}, owner={user['walletAddress']}, name={effective_model_name}, id={model_id}"
        )

        print("[SDK] Step 3/6: Uploading model artifact to IPFS...")
        ipfs_bundle = self._upload_model_to_ipfs(model_path)
        if not ipfs_bundle.get("ok") or not ipfs_bundle.get("ipfsCid"):
            raise RuntimeError("Model upload to IPFS did not return a CID")

        print("[SDK] Step 4/6: Building canonical metadata and generating ZK proof...")
        submitted_at = self._utc_now_iso()
        canonical_metadata_payload = {
            "action": "UPDATED",
            "artifactCid": ipfs_bundle["ipfsCid"],
            "chain": chain,
            "commit": commit_msg,
            "modelHash": model_hash,
            "modelName": effective_model_name,
            "sender": sender,
            "submittedAt": submitted_at,
            "trainingMetadata": {
                "framework": "PyTorch",
                "stage": "training",
                "version": version,
                "weights_path": model_path,
                "zkEngine": "snarkjs.groth16",
            },
            "versionTag": version,
        }
        canonical_metadata = self._canonical_json(canonical_metadata_payload)
        statement_hash = self._keccak_to_field(canonical_metadata)
        zk_bundle = self._generate_zk_proof(secret=secret, model_id=model_id, statement_hash=statement_hash)
        zk_proof = self._proof_to_contract_args(
            zk_bundle["zk"]["proof"],
            zk_bundle["zk"]["publicSignals"],
        )

        print("[SDK] Step 5/6: Assembling verifier-gated payload...")
        payload = {
            "modelId": model_id,
            "modelName": effective_model_name,
            "chain": chain,
            "canonicalMetadata": canonical_metadata,
            "zkProof": zk_proof,
        }

        print("[SDK] Step 6/6: Submitting authenticated provenance write...")
        if signer is not None:
            signed_result = self.submit_signed_zk_record(
                model_id, effective_model_name, chain, canonical_metadata, zk_proof,
                signer, verifying_contract, chain_id,
            )
            relayer_result = signed_result["relayer"]
        else:
            relayer_result = self._send_to_relayer(payload)

        print("\n" + "=" * 60)
        print("SDK PIPELINE COMPLETE")
        print("=" * 60 + "\n")

        return {
            "success": True,
            "authenticatedUser": user,
            "modelPath": model_path,
            "modelHash": model_hash,
            "modelId": model_id,
            "modelName": effective_model_name,
            "chain": chain,
            "canonicalMetadata": canonical_metadata_payload,
            "statementHash": str(statement_hash),
            "zk": {
                "runDir": zk_bundle["zk"]["runDir"],
                "calldata": zk_bundle["zk"]["calldata"],
                "proof": zk_proof,
                "publicSignals": zk_bundle["zk"]["publicSignals"],
            },
            "ipfs": ipfs_bundle,
            "relayer": relayer_result,
        }
