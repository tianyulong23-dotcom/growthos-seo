import { planBacklinksDeploymentManifest } from "../src/modules/backlinks/db/deployment-manifest-runner.mjs";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return value;
}

try {
  const steps = await planBacklinksDeploymentManifest({
    startRevision: readArgument("--start"),
    targetRevision: readArgument("--target"),
  });
  process.stdout.write(JSON.stringify(steps));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
