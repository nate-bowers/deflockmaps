<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Camera-avoidance graph planner

The best routing engine (single-pass λ-sweep over a camera-penalized road graph)
is built and merged but **dormant in production** (`PLANNER_URL` unset → the app
uses the older greedy planner). To activate it on the engine box, or to extend it,
read **`GRAPH_PLANNER.md`** — it has the full architecture, activation runbook,
verification steps, and follow-ups.
