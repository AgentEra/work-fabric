import {
  runRepositoryConformance,
  type RepositoryConformanceResult,
} from "./manifest-runner.js";

function formatErrors(result: RepositoryConformanceResult): string[] {
  if (result.kind === "schema_fixture") {
    return result.errors.map(
      (error) =>
        `${error.instance_path || "/"} ${error.keyword}: ${error.message}`,
    );
  }
  return [...result.errors];
}

async function main(): Promise<void> {
  const report = await runRepositoryConformance(process.cwd());
  const failed = report.results.filter((result) => !result.passed);

  for (const result of failed) {
    process.stderr.write(`FAIL ${result.kind}: ${result.name} (${result.source})\n`);
    for (const error of formatErrors(result)) {
      process.stderr.write(`  ${error}\n`);
    }
  }

  const passed = report.results.length - failed.length;
  process.stdout.write(
    `WFPP v1 conformance: ${passed}/${report.results.length} passed\n`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
