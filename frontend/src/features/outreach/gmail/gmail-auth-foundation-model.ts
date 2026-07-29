export type GmailAuthFoundation = Readonly<{
  connectionState: "not_connected"
  oauthStateStorage: "sha256_hash"
  pkceMethod: "S256"
  pkceStorage: "secret_reference"
  expiresInSeconds: 600
  tenantBound: true
  oneTimeConsumption: true
  connectAvailable: false
  sendAvailable: false
}>

export const gmailAuthFoundation: GmailAuthFoundation = Object.freeze({
  connectionState: "not_connected",
  oauthStateStorage: "sha256_hash",
  pkceMethod: "S256",
  pkceStorage: "secret_reference",
  expiresInSeconds: 600,
  tenantBound: true,
  oneTimeConsumption: true,
  connectAvailable: false,
  sendAvailable: false,
})
