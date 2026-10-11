/** The JSON-RPC wallet payload must declare its domain, even when a local SDK infers it. */
export const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

/** These are the four domain fields used by both venue signing flows in this application. */
export function assertWalletSigningDomain(data: unknown): void {
  const payload = data as { domain?: Record<string, unknown>; types?: { EIP712Domain?: unknown } } | null;
  const fields = payload?.types?.EIP712Domain;
  if (!Array.isArray(fields) || fields.length !== EIP712_DOMAIN_FIELDS.length
    || fields.some((field, i) => !field || field.name !== EIP712_DOMAIN_FIELDS[i]!.name || field.type !== EIP712_DOMAIN_FIELDS[i]!.type)
    || !payload?.domain || Object.keys(payload.domain).length !== EIP712_DOMAIN_FIELDS.length
    || EIP712_DOMAIN_FIELDS.some(field => payload.domain![field.name] === undefined)) {
    throw new Error('Wallet signing request has an incomplete or unsupported EIP712Domain type. Refresh and prepare a new request.');
  }
}
