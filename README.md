# BMS Difficulty

A standalone web tool that reads BMS charts and shows what the **BmsInfo** plugin in
OpenLR2 shows: the xxy star rating (the Sunny algorithm), the dan label, and the
pattern families with their subtypes.

Everything runs in the browser. You drop charts (or pick a folder) and the numbers
appear; nothing is uploaded anywhere.

```
node tools/serve.mjs          # http://127.0.0.1:4173/
```

Then open the page, drop `.bms` / `.bme` / `.bml` / `.pms` / `.bmx` files, and click a
row for the details.

## What it reports

| column | meaning |
| --- | --- |
| xxy | Sunny star rating (OD 8, rate 1.0 unless changed) |
| dan | dan label from the star rating and the LN ratio (`Regular Azimuth low`, `LN Stellium high`, …) |
| pattern | heaviest pattern family, with its heaviest subtype when it owns more than 5% |
| notes / keys / length | note count, keycount after the scratch rule, chart length |

The detail panel lists every family with its share of the chart and the two to four
subtypes that make it up, plus the raw clusters (BPM, seconds, labels).

## How it works

```
bytes ─▶ bmsParser ─▶ keymode ─▶ sanitize ─▶ osu text ─┬─▶ Sunny ─▶ star ─▶ dan
                                                        └─▶ pattern windows ─▶ clusters ─▶ families
```

* `src/bmsParser.js` — BMS/BME/BML/PMS parser: `#BPMxx`, `#STOPxx`, `#LNOBJ`, `#LNTYPE`,
  measure ratios, `#RANDOM` (deterministic first branch), long notes on the `5x` lanes.
* `src/osuBridge.js` — drops the stacked notes the pattern engine would reject and
  writes the chart as osu!mania text.
* `vendor/om-analyzer/` — the analysis engine (Sunny, pattern windows, clustering,
  dan intervals). It is the same code the plugin was ported from, with the rule
  changes listed below applied to `patternsDef.js` / `findPatterns.js` / `clustering.js`.
* `src/panel.js` — the family / subtype panel: real unions instead of the double
  counting `Amount`, `Stream` shown as `Speed`, light chordstreams folded into it.
* `src/app.js` — the page.

Charts are analysed at roughly **30 ms each** (measured on 28 seven-key charts), so a
folder of a few hundred charts finishes in a few seconds.

## Matching the plugin

`tools/verify.mjs` runs the same charts through the browser pipeline and through the
plugin's console harness (`bmsinfo.exe --sunny`), and prints the star delta and both
categories:

```
node tools/verify.mjs "D:\path\to\chart.bms"
```

On the 28 chart test set plus five scratch charts the two agree on **33/33 categories**
and on the star rating within `5e-6` (the remaining difference is a note that lands on
a half millisecond and rounds differently in the two time accumulators).

The rules carried over from the plugin, which differ from the upstream pattern engine:

* scratch lanes are dropped before the pattern pass (7 keys for a 7K chart);
* `Light Stream` keeps its name, and 4/1 is no longer a light stream;
* 7K chordstreams: Brackets (exclusive, one colour per row, two colour switches per
  pair), Double Stream, Dense (six keys across two rows), General (2/3, 3/2, 4/1);
* the jack core opens on a single repeated key, so minijacks are counted;
* the category is the family with the largest covered time, `Tech` is appended when
  more than half of that family is played at a changing BPM.

## Layout

```
index.html            page shell
src/app.js            UI: drop zone, table, detail panel
src/pipeline.js       bytes -> star/dan/pattern
src/panel.js          clusters -> families -> category
src/bmsParser.js      BMS parser
src/osuBridge.js      note cleanup + osu text writer
vendor/om-analyzer/   analysis engine (Sunny, patterns, dan tables)
tools/serve.mjs       static server (no dependencies)
tools/verify.mjs      parity check against the plugin harness
tools/bench.mjs       timing
samples/demo.bms      a small generated 4k chart for a smoke test
```

`?sample=1` analyses the bundled demo chart; `?sample=1&open=1` also opens its detail
panel (handy for headless screenshots).

## Known limitations

* the pattern pass ignores the scratch lane entirely, so scratch-heavy charts read as
  7K charts;
* `#RANDOM` uses the first branch only, so charts with branches are read deterministically;
* 2P (`21`–`29`, `61`–`69`) lanes are counted as notes but do not take part in the
  pattern families;
* DP and PMS charts are parsed but their extra lanes are not modelled.
