# Final Statistics and L2 Scenario Note

The descriptive statistics use the 160 confirmed Sepolia experiment transactions in unified run
`20260819T141255193Z`. Each variant/operation cell has n=20. The confidence intervals use a
two-sided 95% t interval with 19 degrees of freedom.

`l2_execution_fee_scenarios.csv` applies two illustrative execution-gas prices (0.01 and 0.1 gwei)
to the measured gas units. These are scenarios, not deployed L2 measurements. They exclude L1 data
availability fees, sequencer policy, calldata compression, and token/fiat price changes. The paper
must not describe them as observed L2 transaction fees.
