---
name: review-core
description: Baseline review method used for every file. How to read a diff, what counts as a finding, and how to cite.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**"]
---
Read the whole diff chunk before writing any finding. Understand what the change is trying to do.

Check, in this order:
1. Correctness: wrong conditions, off-by-one, null or undefined access, unhandled promise or error paths, wrong return values.
2. Rule fit: does an added line break a written rule? Only a written rule can be cited.
3. Clarity: names that mislead, dead code added, copy-pasted blocks.

A good finding names the exact line, says what is wrong in one sentence, and why the cited rule applies.
Do not flag code that only looks unusual. Do not guess about code outside the diff.
If two problems sit on one line, report the more severe one.
