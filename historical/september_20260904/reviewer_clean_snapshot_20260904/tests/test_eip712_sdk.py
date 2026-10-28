import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sdk.python.provenance_sdk import ProvenanceSDK


class RecordingSigner:
    def __init__(self):
        self.call = None

    def sign_typed_data(self, domain, types, message):
        self.call = (domain, types, message)
        return "0x" + "11" * 65


class Eip712SdkTests(unittest.TestCase):
    def setUp(self):
        self.sdk = ProvenanceSDK(access_token="test-token")
        self.sdk.current_user = {"walletAddress": "0x1111111111111111111111111111111111111111"}
        self.metadata = self.sdk._canonical_json({
            "action": "UPDATED", "artifactCid": "QmTest", "chain": "sepolia",
            "commit": "test", "modelHash": "0xabc", "modelName": "ModelA",
            "sender": self.sdk.current_user["walletAddress"], "submittedAt": "2026-08-19T00:00:00Z",
            "trainingMetadata": {"framework": "PyTorch", "stage": "training", "version": "1.0",
                                 "weights_path": "model.bin"}, "versionTag": "1.0"
        })

    @patch("sdk.python.provenance_sdk.requests.post")
    @patch("sdk.python.provenance_sdk.requests.get")
    def test_builds_and_submits_expected_typed_data(self, get, post):
        get.return_value = Mock(status_code=200)
        get.return_value.json.return_value = {
            "success": True,
            "domain": {"name": "ModelProvenance", "version": "1", "chainId": 11155111,
                       "verifyingContract": "0x2222222222222222222222222222222222222222"},
            "types": {"ProvenanceSubmission": [
                {"name": "modelId", "type": "uint256"}, {"name": "eventType", "type": "uint8"},
                {"name": "statementHash", "type": "uint256"}, {"name": "nonce", "type": "uint256"}]}
        }
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"success": True, "tx": "0xabc", "owner": self.sdk.current_user["walletAddress"]}
        signer = RecordingSigner()

        result = self.sdk.submit_eip712_record(42, "ModelA", "sepolia", self.metadata, signer, nonce=7)

        self.assertEqual(signer.call[2]["modelId"], 42)
        self.assertEqual(signer.call[2]["eventType"], 2)
        self.assertEqual(signer.call[2]["nonce"], 7)
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["nonce"], "7")
        self.assertEqual(sent["signature"], "0x" + "11" * 65)
        self.assertEqual(result["relayer"]["tx"], "0xabc")

    def test_rejects_unsupported_action_before_signing(self):
        signer = RecordingSigner()
        metadata = json.dumps({"action": "UNKNOWN"})
        with patch.object(self.sdk, "_get_eip712_config", return_value={"domain": {}, "types": {}}):
            with self.assertRaises(ValueError):
                self.sdk.submit_eip712_record(42, "ModelA", "sepolia", metadata, signer)
        self.assertIsNone(signer.call)


if __name__ == "__main__":
    unittest.main()
