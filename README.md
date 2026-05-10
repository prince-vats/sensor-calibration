
# Sensor Calibration Tool (Browser-Only)

A fully client-side  **research-grade environmental sensor calibration web tool** .

This tool runs **entirely in the browser** (no backend, no server, no API calls, no database).

It should be deployable directly via:

* **GitHub Pages**
* Static hosting
* Pure frontend stack

Recommended stack:

* HTML
* JavaScript / TypeScript
* Optional React
* SheetJS (Excel parsing)
* PapaParse (CSV parsing)
* Plotly.js / Chart.js / D3.js for plots
* Regression libraries or custom implementation

---

# Core Philosophy

Focus on:

* functionality
* correctness
* validation
* transparency
* user guidance
* publication-quality scientific outputs

Ignore styling for now.

Minimal layout is fine.

---

# Absolute UX Requirements

The tool must always visibly display:

## 1. Requirements panel (always visible)

Show all required input rules before upload.

Include:

### Sensor file requirements

Must contain:

* first column strictly named:

`Timestamp`

Must include selected calibration parameter columns

Examples:

* PM2.5
* PM10
* CO2
* CO

(case-sensitive)

Must also include:

* `T`
* `RH`

Timestamp values must be valid parseable datetime values.

Parameter columns must be numeric or convertible to numeric.

Rows containing NaN / invalid numeric values will be removed automatically.

---

### Reference file requirements

Must contain:

* first column strictly named:

`Timestamp`

Must include selected calibration parameter columns

Timestamp values must be valid parseable datetime values.

Parameter columns must be numeric or convertible.

Rows containing NaN are removed automatically.

---

## 2. Assumptions panel

Display assumptions clearly:

* timestamps may have different timezone formats
* timezone mismatches are ignored
* overlap is determined using raw parsed timestamps
* all resampling uses interval-end labeling

Example:

If user selects hourly:

Data from:

1:00:00 → 1:59:59

is assigned to:

2:00:00

---

## 3. Real-time processing status panel

Show:

* current step
* pass/fail checks
* reason for pass/fail
* rows dropped
* estimated remaining time
* progress percentage

Each validation step must visibly log success/failure.

If a required validation fails:

* show exact reason
* prevent progression
* tell user what to fix

---

# Functional Flow

---

# STEP 1 — Select Calibration Parameters

Allow multi-select from case-sensitive list:

* PM2.5
* PM10
* CO2
* CO
* NO2
* O3
* SO2
* NH3
* VOC

User may select any number.

Selections define required columns in uploaded datasets.

---

# STEP 2 — Upload Sensor Dataset

Accept:

* `.csv`
* `.xls`
* `.xlsx`

Display:

> Uploaded filename will be used as dataset label.

Validation sequence:

---

## 2.1 First column check

Must be exactly:

`Timestamp`

Fail if not.

---

## 2.2 Timestamp validity

All values must parse as valid timestamps.

Fail if impossible.

---

## 2.3 Required parameter columns exist

Must contain all selected parameters.

Fail if missing any.

---

## 2.4 Must contain:

* `T`
* `RH`

Exact case-sensitive names.

Fail otherwise.

---

## 2.5 Numeric coercion

Attempt conversion for:

* selected parameters
* T
* RH

Non-convertible values become NaN.

---

## 2.6 Drop invalid rows

Remove rows containing:

* NaN
* null
* empty strings
* "nan"
* "NaN"
* undefined
* invalid numeric conversions

Display:

* rows removed
* remaining rows

Verification complete only if all checks pass.

---

# STEP 3 — Upload Reference Dataset

Accept:

* `.csv`
* `.xls`
* `.xlsx`

Display:

> Uploaded filename will be used as reference label.

Validation:

---

## 3.1 First column

Must equal:

`Timestamp`

---

## 3.2 Timestamp validity

Must parse correctly.

---

## 3.3 Parameter columns

Must include all selected parameters.

---

## 3.4 Numeric coercion

Convert all selected parameter columns to numeric.

---

## 3.5 Drop invalid rows

Same NaN rules.

Display rows removed.

---

# STEP 4 — Overlap Check

Compare parsed timestamps.

Determine common interval.

If none:

FAIL

Display:

“No overlapping calibration period exists.”

Block progression.

If overlap exists:

Display:

* overlap start
* overlap end
* duration

Allow continue.

---

# STEP 5 — Select Calibration Resolution

Dropdown:

* 1 second
* 1 minute
* 5 minutes
* 15 minutes
* 30 minutes
* 1 hour
* 12 hours
* 24 hours

---

# STEP 6 — Resample and Merge

Resample both datasets using interval-end labeling.

Example:

Hourly:

1:00–1:59 → 2:00

Timezone differences:

Ignore completely.

Operate using parsed timestamps only.

Intersect overlapping windows after resampling.

---

## Final merged structure

Must become:

Timestamp
parameter_sensor
parameter_reference
...
T
RH

Example:

Timestamp
PM2.5_sensor
PM2.5_reference
CO2_sensor
CO2_reference
T
RH

Display:

* total rows
* start timestamp
* end timestamp
* selected interval
* preview table (first 20 rows)

---

# STEP 7 — Calibration Analysis

For each selected parameter:

Run:

---

## A. Simple Linear Regression

Inputs:

X = sensor

Y = reference

Equation:

y = mx + b

---

## B. Multiple Linear Regression

Inputs:

X =

* sensor
* T
* RH

Output:

reference

Equation:

y = a(sensor) + b(T) + c(RH) + d

---

## Compute metrics for both

Display:

* R²
* RMSE
* MAE
* MAPE
* Bias
* Pearson correlation
* slope
* intercept

---

# STEP 7.1 Scatter Plots

For each parameter:

Generate two publication-quality plots:

## Simple regression scatter

Include:

* fitted line
* equation
* metrics
* axis labels
* title

---

## Multiple regression predicted-vs-reference scatter

Include:

* 1:1 line
* metrics
* fitted equation

---

# STEP 7.2 Time Series Plot

For each parameter:

Single plot showing:

**Red solid**

reference

**Blue solid**

raw sensor

**Blue dashed**

simple regression calibrated

**Blue dotted**

multilinear calibrated

Include:

* legend
* proper axis labels
* title
* zoom support

Publication-ready.

---

# STEP 8 — Manual Peak Alignment

Critical feature.

Allow shifting independently for:

* sensor dataset
* reference dataset

Controls:

* ← shift backward
* → shift forward

Shift by one time index.

Example:

Right shift sensor:

value at t becomes aligned with t+1

Left shift:

value at t becomes aligned with t−1

---

## After every shift automatically recompute:

* aligned dataset
* all plots
* regressions
* calibration equations
* performance metrics
* fitted curves

All visuals must refresh immediately.

This allows manual synchronization correction.

---

# STEP 9 — Download Results

Provide buttons:

* Download CSV
* Download Excel

Export must include:

Merged processed dataset

Plus calibrated columns:

parameter_simple_calibrated

parameter_multilinear_calibrated

Plus alignment offsets

Plus regression equations

Plus metrics summary sheet (Excel)

---

## Timestamp export format

Strict format:

`DD-MM-YYYY HH:mm:ss`

Example:

`18-02-2026 01:00:23`

Handle timezone inconsistencies robustly during export.

---

# Error Handling Rules

Every failure must explain:

* what failed
* why
* expected format
* how user can fix it

Never silently fail.

Never continue if required validation failed.

---

# Performance Requirements

Must comfortably handle:

* 500k+ rows
* multiple parameters
* browser memory efficiency

Use:

* chunk parsing
* progressive rendering
* async processing
* worker threads if needed

---

# Architecture Preference

Modular structure:

```plaintext
/parser
/validators
/resampling
/merge
/regression
/plots
/alignment
/export
/ui
```

Keep logic separated and testable.

---

# Important

Do NOT focus on styling yet.

Prioritize:

* correctness
* robustness
* scientific validity
* transparent status reporting
* deterministic outputs
* reproducibility

Build fully functional MVP first.
