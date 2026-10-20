# U.S. federal election spending, 2000–2024

Retrieved October 19, 2026. All figures are estimates or reported spending, not a complete census of political influence.

## Main series: party totals

Source: [OpenSecrets, Total Cost of Election](https://www.opensecrets.org/elections-hub/cost-of-election), cross-checked against the exact-dollar table and CSV on the [legacy party view](https://www.opensecrets.org/elections-overview/cost-of-election?cycle=2024&display=P&infl=N).

The original exact-dollar CSV is saved in `sources/opensecrets_party_totals_nominal.csv`. The plot uses every even-year cycle from 2000 through 2024, inclusive, and OpenSecrets' published Democratic and Republican amounts. It does not reconstruct or override OpenSecrets' party attribution. These amounts cover more than the national party organizations' own spending.

Each cycle covers two calendar years ending in the labeled year; 2024 means 2023–2024. Presidential cycles include the congressional races held in those cycles, plus primary campaigning and other covered election activity. Midterm cycles include congressional races. State and local races, ballot measures, lobbying, and non-election political influence are outside this federal election series.

OpenSecrets describes its cost estimate as including candidate campaigns; party election activity; 527-group federal election spending; reported outside spending, including independent expenditures and electioneering communications; PAC overhead; and conventions. Super PAC spending is part of reported outside spending. Some nonprofit spending is visible even when the identities of its donors are not.

The methodology removes candidate-to-candidate donations and candidate-to-party transfers, and party transfers to federal candidates and other party committees, to avoid counting the same money twice. Contributions and fundraising receipts are not added to spending. Unspent money is not election expenditure. PAC contributions already reflected in candidate spending are not added again as a separate bucket.

Coverage is not perfectly constant: the detailed calculation changes from 2010 onward; the table's footnote says PAC overhead is included from 2014 onward and joint fundraising committee (JFC) overhead from 2022 onward. Earlier cycles cannot be reconstructed under the same detailed method from the available information.

The Democratic, Republican, and third-party published amounts do not always sum to the national total. The current OpenSecrets page explicitly acknowledges other spending in the snapshot. The residual is preserved as `other_unallocated_usd` in the cleaned data; it is not divided between Democrats and Republicans. In 2024 the figures are:

- Democrats: $7,290,950,283.
- Republicans: $6,361,429,933.
- Third-party candidates: $385,451,239.
- Other/unallocated residual: $766,274,057.
- National total: $14,804,105,512.

These are the historical figures currently published by OpenSecrets, not a new audit of all underlying FEC filings. The page does not provide a clear filing cutoff for its historical cost snapshot. Its methodology text still uses 2019–2020 as the example reporting period. Do not interpret the source as guaranteeing a fully final, exhaustive 2024 accounting or equate retrieval date with filing cutoff.

## Companion series: outside spending by expenditure type

Source: [OpenSecrets, Total Outside Spending by Election Cycle, Excluding Party Committees](https://www.opensecrets.org/outside-spending/by_cycle). Exact values transcribed from the displayed source table are saved in `sources/outside_spending_nominal.csv`.

This table includes all party alignments but excludes party committees. It groups reported spending into independent expenditures, electioneering communications, and communication costs. The $4,217,702,088 total in 2024 includes $4,205,052,224 of independent expenditures, $9,670,637 of electioneering communications, and $2,979,227 of communication costs.

Independent expenditures are uncoordinated spending explicitly advocating a candidate's election or defeat. Super PACs are one type of spender within this category; the category also contains other organizations. Electioneering communications are a separate legal reporting category for certain broadcast communications mentioning a candidate near an election. Communication costs cover reportable candidate advocacy by corporations or unions directed to restricted audiences such as members or employees.

These are expenditure types, not ultimate donor sources. A nonprofit can fund a Super PAC, which can purchase an advertisement; those are stages of the same money flow and cannot be added as independent sources of expenditure. Before Super PACs existed in 2010, other outside groups already spent money. Zero electioneering-communication values before 2004 reflect the source's reporting categories and must not be interpreted as proof that no comparable advertising existed.

The 2012 source row has an internal discrepancy: its three components sum to $1,038,178,980, which is $66,912 above its published $1,038,112,068 total. Both are preserved. Stacked bar heights and labels use the component sum; the data table uses the published total. Every other cycle's components reconcile exactly to its published outside-spending total.

Outside spending overlaps conceptually with the broad cost estimate. It is shown separately, never added to the party totals or used to derive a campaign-spending residual. The two OpenSecrets products are separate snapshots and are not guaranteed to reconcile dollar for dollar. A consistent public party-by-spender-type table reconciling to the broad total for all 13 cycles was not established, so the main bars remain unstacked. Liberal/conservative group classifications are also not automatically identical to Democratic/Republican beneficiary attribution.

## Inflation adjustment

Source: [Federal Reserve Bank of Minneapolis, Consumer Price Index, 1913–](https://www.minneapolisfed.org/about-us/monetary-policy/inflation-calculator/consumer-price-index-1913-), which republishes BLS annual CPI-U averages. The displayed one-decimal annual CPI values used here are saved in `sources/cpi_annual.csv`.

2024 dollars = reported dollars × (313.7 / CPI in the cycle's ending year).

This is an approximate cycle-level adjustment using the ending year's annual average CPI for the entire cycle. It is not a transaction-date deflation or a political-advertising-specific price index. Calculations start from nominal spending; they do not use OpenSecrets' separate inflation-adjusted snapshot. Reported dollars are the default; the interactive report can switch to 2024 dollars.

## What cannot be counted reliably

Unreported issue advertising, unreported political activity, and undisclosed spending cannot be recovered from public campaign-finance reports. Disclosed spending by dark-money organizations can be counted even when their donors cannot be identified. No figure here should be described as all money spent in politics.

## Reproduce

Download and extract [the source bundle](election-spending-source.zip). It includes the three saved source tables, the report template, and the generation script. Run `build_report.py` from that folder with Python, matplotlib, numpy, and plotly installed. It reads only the three saved source files and writes the cleaned CSV, static figures, and a self-contained interactive HTML report next to the script. No credentials or warehouse access are needed.

The generated HTML is the standalone research version; the published website uses the same data and chart logic with Penta Projects navigation and styling.
