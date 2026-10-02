// Web Crypto type names used by ../src/util.ts. The Worker build gets them from @cloudflare/workers-types;
// the Node jobs map them to Node's implementation of the same API.
type CryptoKey = import('node:crypto').webcrypto.CryptoKey;
type JsonWebKey = import('node:crypto').webcrypto.JsonWebKey;
