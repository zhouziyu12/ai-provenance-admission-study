"""Local EOA signing adapter. No private key is sent to the relay or logged."""


class EthAccountSigner:
    """Wrap an eth-account LocalAccount supplied by the caller's key-management code.

    Hardware/external wallets can instead implement ProvenanceSDK's TypedDataSigner protocol.
    """

    def __init__(self, account):
        self._account = account

    def sign_typed_data(self, domain, types, message):
        from eth_account.messages import encode_typed_data

        encoded = encode_typed_data(domain_data=domain, message_types=types, message_data=message)
        return "0x" + self._account.sign_message(encoded).signature.hex().removeprefix("0x")
