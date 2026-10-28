import csv
import json
import math
from pathlib import Path

import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs/bcra_revision/evidence/three_way_sepolia/20260819T141255193Z/three_way_sepolia.json"
OUT = ROOT / "docs/bcra_revision/evidence/final_statistics"
OUT.mkdir(parents=True, exist_ok=True)

data = json.loads(SOURCE.read_text(encoding="utf-8"))
rows = data["rows"]
summary_rows = []

for variant in ("ungated", "eip712", "groth16", "passive"):
    for operation in ("first", "append"):
        values = [float(row["gasUsed"]) for row in rows if row["variant"] == variant and row["operation"] == operation]
        n = len(values)
        mean = sum(values) / n
        sample_sd = math.sqrt(sum((value - mean) ** 2 for value in values) / (n - 1))
        margin = 2.093 * sample_sd / math.sqrt(n)  # t(0.975, 19)
        summary_rows.append({
            "variant": variant, "operation": operation, "n": n, "mean_gas": mean,
            "sample_sd": sample_sd, "ci95_low": mean - margin, "ci95_high": mean + margin,
            "min_gas": min(values), "max_gas": max(values), "rsd_percent": sample_sd / mean * 100,
        })

with (OUT / "gas_descriptive_statistics.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=summary_rows[0].keys())
    writer.writeheader()
    writer.writerows(summary_rows)

l2_rows = []
for row in summary_rows:
    for gas_price_gwei in (0.01, 0.1):
        l2_rows.append({
            "variant": row["variant"], "operation": row["operation"],
            "measured_mean_gas": row["mean_gas"], "assumed_execution_gas_price_gwei": gas_price_gwei,
            "estimated_execution_fee_eth": row["mean_gas"] * gas_price_gwei * 1e-9,
            "excludes_l1_data_fee": True,
        })
with (OUT / "l2_execution_fee_scenarios.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=l2_rows[0].keys())
    writer.writeheader()
    writer.writerows(l2_rows)

labels = [f"{r['variant']}\n{r['operation']}" for r in summary_rows]
means = [r["mean_gas"] for r in summary_rows]
errors = [[r["mean_gas"] - r["ci95_low"] for r in summary_rows],
          [r["ci95_high"] - r["mean_gas"] for r in summary_rows]]
colors = ["#2f6b5f", "#6f9e8f", "#c45b3c", "#d99b4b", "#2f6b5f", "#6f9e8f", "#c45b3c", "#d99b4b"]
fig, ax = plt.subplots(figsize=(11, 5.5))
ax.bar(labels, means, yerr=errors, capsize=4, color=colors, edgecolor="#202622", linewidth=0.7)
ax.set_ylabel("Gas used (mean with 95% CI)")
ax.set_title("Sepolia provenance-write gas by variant and lifecycle operation (n=20)")
ax.grid(axis="y", alpha=0.22)
fig.tight_layout()
fig.savefig(OUT / "gas_comparison_95ci.png", dpi=220)
plt.close(fig)

report = """# Final Statistics and L2 Scenario Note

The descriptive statistics use the 160 confirmed Sepolia experiment transactions in unified run
`20260819T141255193Z`. Each variant/operation cell has n=20. The confidence intervals use a
two-sided 95% t interval with 19 degrees of freedom.

`l2_execution_fee_scenarios.csv` applies two illustrative execution-gas prices (0.01 and 0.1 gwei)
to the measured gas units. These are scenarios, not deployed L2 measurements. They exclude L1 data
availability fees, sequencer policy, calldata compression, and token/fiat price changes. The paper
must not describe them as observed L2 transaction fees.
"""
(OUT / "STATISTICS_AND_L2_NOTE.md").write_text(report, encoding="utf-8")
print(json.dumps({"source_rows": len(rows), "summary_rows": len(summary_rows), "l2_rows": len(l2_rows), "output": str(OUT)}, indent=2))
