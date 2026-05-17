---
name: evolve-test-skill
description: Fixture skill used by pi-evolve's integration test to verify EVOLVE_PRESERVE_SKILLS appends Pi's available_skills block.
---

This skill body is intentionally trivial. The test only inspects the
`available_skills` envelope Pi emits into the system prompt; the body content
is never asserted on.
