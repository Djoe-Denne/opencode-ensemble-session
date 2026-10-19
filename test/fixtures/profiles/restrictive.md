---
description: "Restrictive reviewer."
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "*", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: skill, resource: "*", effect: allow }
---

Stop on the final answer.
<!-- ensemble-report: final_response -->
