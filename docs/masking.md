# Data Masking

English | [简体中文](zh-CN/masking.md)

LoongSuite Pilot can mask common secrets and personal sensitive data before normalized events are sent to output backends. Use this when prompts, completions, tool arguments, or tool results may contain credentials, ID cards, phone numbers, email addresses, IPv4 addresses, or bank card numbers.

Masking is separate from message content capture:

- `captureMessageContent: false` reduces whether full message or tool content is collected.
- `mask` scans configured output fields and replaces high-confidence secrets that are still present.

For sensitive environments, use both.

## How To Enable Masking

Config file:

```json
{
  "mask": {
    "mode": "all"
  }
}
```

Or, Environment variable:

```bash
export LOONGSUITE_PILOT_MASK_MODE=all
```

Restart Pilot after changing config:

```bash
loongsuite-pilot restart
```

## Mask Modes


| Mode     | Behavior                                                                 |
| -------- | ------------------------------------------------------------------------ |
| `none`   | Do not mask fields. This is the default when no mask mode is configured. |
| `all`    | Enable all built-in sensitive data rules.                                |
| `custom` | Enable only the mask types listed in `mask.types`.                       |


## Mask Types


| Type             | What It Covers                                        |
| ---------------- | ----------------------------------------------------- |
| `cloudAccessKey` | Alibaba Cloud, AWS, and Tencent-style access key IDs. |
| `apiKey`         | OpenAI-compatible and GitHub-style API keys.          |
| `privateKey`     | PEM or OpenSSH private key blocks.                    |
| `databaseUrl`    | Database URLs with embedded passwords.                |
| `idCard`         | 18-digit mainland China ID cards with strict validation. |
| `phone`          | Mainland China mobile and landline phone numbers.     |
| `email`          | Common ASCII email addresses.                         |
| `ipAddress`      | IPv4 addresses, including public and private ranges.  |
| `bankCard`       | High-confidence card numbers validated by issuer and Luhn. |


Custom mode example:

```json
{
  "mask": {
    "mode": "custom",
    "types": ["apiKey", "idCard", "phone", "email", "ipAddress", "bankCard"]
  }
}
```

Equivalent environment variables:

```bash
export LOONGSUITE_PILOT_MASK_MODE=custom
export LOONGSUITE_PILOT_MASK_TYPES=apiKey,idCard,phone,email,ipAddress,bankCard
```

## Replacement Values

When a rule matches, Pilot replaces the secret with a fixed marker:


| Mask Type        | Replacement Marker     |
| ---------------- | ---------------------- |
| `cloudAccessKey` | `[ACCESSKEY_MASKED]`   |
| `apiKey`         | `[APIKEY_MASKED]`      |
| `privateKey`     | `[PRIVATEKEY_MASKED]`  |
| `databaseUrl`    | `[DATABASEURL_MASKED]` |
| `idCard`         | `[IDCARD_MASKED]`      |
| `phone`          | `[PHONE_MASKED]`       |
| `email`          | `[EMAIL_MASKED]`       |
| `ipAddress`      | `[IPADDRESS_MASKED]`   |
| `bankCard`       | `[BANKCARD_MASKED]`    |


The original value is not preserved in the emitted event.

## What Gets Masked

Masking runs in the collector before events are written to JSONL, SLS, HTTP, or OTLP trace output.

Pilot focuses masking on fields that may contain user or tool content, such as:

- LLM input and output messages.
- Tool call arguments.
- Tool call results.
- Known agent-specific content fields, such as `agent.content`, `agent.inline_diff_message`, and selected compact content fields.

Stable metadata such as model names, token counts, durations, Git branch, and workspace path is not intended to be scanned as secret-bearing content.

## Phase-one Detection Boundaries

- ID cards cover only 18-digit mainland China IDs.
- Phone numbers cover only mainland China mobile and landline formats, excluding extensions, 400/800 numbers, and overseas numbers.
- Email covers common ASCII addresses, excluding internationalized addresses and dotless internal domains.
- IP covers IPv4 only. Version-shaped text such as `1.2.3.4` is also masked as IPv4.
- Bank cards cover high-confidence UnionPay, Visa, Mastercard, AmEx, and Discover prefixes and must pass Luhn validation.
- Phone and bank-card detection is format-based. An 11-digit numeric ID with the same shape, or a 15-19 digit business identifier that matches an issuer prefix and passes Luhn, can also be masked. For logs with many numeric business IDs, prefer `custom` mode and enable only the required types.
- License plates, addresses, company names, job titles, custom key/value rules, and Secret Keys are outside this phase.

## Verify Masking

1. Enable JSONL output and masking.
2. Restart Pilot.
3. Trigger an agent event that contains a known test secret pattern.
4. Inspect local output:

```bash
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

Expected output should contain mask markers such as `[APIKEY_MASKED]` instead of the original secret.

## Related Configuration

- See [Local JSONL Output](local-jsonl-output.md), [SLS Output](sls-output.md), [Trace Output](trace-output.md), and [HTTP Output](http-output.md) for output backend setup.
- See [Output Event Schema](output-event-schema.md) for fields marked as opt-in sensitive content.
