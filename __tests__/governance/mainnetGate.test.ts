import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as fs from "node:fs";

describe("Mainnet Go/No-Go Gate Verification", () => {
  const root = join(__dirname, "..", "..");
  const gateScript = join(root, "scripts", "verify-mainnet-gate.js");
  const docPath = join(root, "docs", "MAINNET_READINESS.md");

  test("docs/MAINNET_READINESS.md exists", () => {
    expect(fs.existsSync(docPath)).toBe(true);
  });

  test("verify-mainnet-gate.js executes successfully and passes all P0 checks", () => {
    const output = execFileSync("node", [gateScript], {
      cwd: root,
      encoding: "utf8",
    });

    expect(output).toContain("Mainnet Go/No-Go gate verification passed");
    expect(output).toContain("Release gate status: OPEN for production deployment");
    expect(output).toContain("Categories      : 7 verified");
  });

  test("MAINNET_READINESS.md contains all 7 required domains and named gatekeepers", () => {
    const content = fs.readFileSync(docPath, "utf8");

    const requiredDomains = [
      "Security",
      "Finance",
      "Support",
      "Contracts",
      "Monitoring",
      "Legal/Privacy Review",
      "Rollback",
    ];

    for (const domain of requiredDomains) {
      expect(content).toContain(domain);
    }

    expect(content).toMatch(/Gate Decision\*{0,2}\s*[:|]\s*\*{0,2}GO\*{0,2}/i);
    expect(content).toMatch(/Evaluation Date\*{0,2}\s*[:|]\s*\*{0,2}\d{4}-\d{2}-\d{2}\*{0,2}/i);
    expect(content).toContain("Go/No-Go Approval Record");
  });
});
