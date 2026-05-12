/**
 * Best-effort secret redaction for debug logs.
 *
 * This is NOT applied to the JSON stream the bridge returns to MCP callers —
 * that stream is the actual product. It is applied only to debug strings the
 * bridge writes to its own stderr when CLAUDE_BRIDGE_DEBUG=1.
 *
 * Regex-based redaction is inherently incomplete; we err on the side of
 * over-redacting in logs and document the limitation explicitly.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: readonly RedactionRule[] = [
  // Anthropic API keys (sk-ant-...)
  {
    name: 'anthropic_api_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: 'sk-ant-***',
  },
  // OpenAI-style keys (sk-...)
  {
    name: 'openai_api_key',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: 'sk-***',
  },
  // GitHub PATs (classic + fine-grained)
  {
    name: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: 'ghp_***',
  },
  // Slack tokens
  {
    name: 'slack_token',
    pattern: /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/g,
    replacement: 'xox*-***',
  },
  // AWS access key ID
  {
    name: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: 'AKIA***',
  },
  // Bearer/Basic auth in HTTP-style strings
  {
    name: 'http_authorization',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]+/g,
    replacement: '$1 ***',
  },
  // JWT-shaped tokens (three base64url segments separated by dots)
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: 'jwt:***',
  },
  // Private key blocks
  {
    name: 'pem_private_key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----',
  },
];

export function redact(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Returns the names of redaction rules — useful in tests and docs to keep the
 * "what we redact" surface explicit.
 */
export function redactionRuleNames(): readonly string[] {
  return RULES.map((r) => r.name);
}
