/**
 * Validate required environment variables at startup.
 * Per ACP best practices: validate all env vars immediately at process start,
 * not during execution. Prevents unclear errors later in the lifecycle.
 */
export function validateEnvironment(): void {
  const required: Array<{
    name: string;
    pattern?: RegExp;
    description: string;
  }> = [
    {
      name: "HEDGEFI_PRIVATE_KEY",
      pattern: /^0x[0-9a-fA-F]{64}$/,
      description: "64-char hex private key (0x-prefixed)",
    },
    {
      name: "HEDGEFI_ENTITY_ID",
      pattern: /^\d+$/,
      description: "numeric entity ID",
    },
    {
      name: "HEDGEFI_WALLET_ADDRESS",
      pattern: /^0x[0-9a-fA-F]{40}$/,
      description: "40-char hex address (0x-prefixed)",
    },
  ];

  const errors: string[] = [];

  for (const { name, pattern, description } of required) {
    const value = process.env[name];

    if (!value) {
      errors.push(`  Missing ${name} (${description})`);
      continue;
    }

    if (pattern && !pattern.test(value)) {
      errors.push(`  Invalid ${name}: does not match expected format (${description})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.join("\n")}`
    );
  }

  // Optional env vars — warn but don't block startup
  if (!process.env.GEMINI_API_KEY) {
    console.warn("  Warning: GEMINI_API_KEY not set — AI reasoning will use template fallbacks");
  }
}
