---
name: java-review
description: Java and Kotlin review checklist.
metadata:
  version: "1.0.0"
  owner: platform
  paths: ["**/*.{java,kt}"]
---
- Null handling: returning null where Optional or an empty collection is the convention.
- Resources not closed (use try-with-resources).
- Catching `Exception` or `Throwable` broadly and swallowing it.
- Mutable static state; non-thread-safe collections shared across threads.
- `equals` overridden without `hashCode`.
- String concatenation in loops for large outputs; SQL built by concatenation.
