import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];

const strictTypeScriptConfig = tseslint.configs.strict.map((config) => ({
  ...config,
  files: typescriptFiles,
}));

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  ...strictTypeScriptConfig,
  {
    name: "growthos/domain-import-boundaries",
    files: ["src/modules/*/domain/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/activities/**",
                "**/adapters/**",
                "**/api/**",
                "**/db/**",
                "**/third-party/**",
                "**/vendor/**",
                "**/workflows/**",
              ],
              message:
                "Domain code must not depend on framework, adapter, workflow, database, or vendored implementation layers.",
            },
            {
              group: [
                "@ai-sdk/*",
                "@fastify/*",
                "@googleapis/*",
                "@openfeature/*",
                "@opentelemetry/*",
                "@temporalio/*",
                "ai",
                "cheerio",
                "dataforseo-client",
                "drizzle-kit",
                "drizzle-orm",
                "drizzle-orm/*",
                "exceljs",
                "fastify",
                "fastify/*",
                "fastify-type-provider-zod",
                "google-auth-library",
                "isomorphic-dompurify",
                "jsdom",
                "nodemailer",
                "openai",
                "pdf-lib",
                "playwright",
                "postal-mime",
                "robots-parser",
                "undici",
                "validator",
                "zod",
              ],
              message:
                "Domain code must depend on owned domain types and ports, not framework or vendor packages.",
            },
          ],
        },
      ],
    },
  },
);
