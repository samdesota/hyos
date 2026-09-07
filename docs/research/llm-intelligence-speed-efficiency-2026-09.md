# LLM Intelligence, Speed & Token Efficiency — September 2026

Date: 2026-09-04. Data: Artificial Analysis (AA) Intelligence Index model pages & articles, BenchLM snapshot (2026-09-02/04), Cerebras/OpenAI/Anthropic announcements.

## Methodology

- **Intelligence (II)** — Artificial Analysis Intelligence Index (max reasoning effort unless noted), 0–100 scale. Snapshot variance exists between index versions (e.g. Kimi K3 reports 57–60 depending on snapshot).
- **Raw speed** — AA median output tokens/sec on the primary hosted API. Self-hosting or alternative providers can differ wildly (GLM-5.3-Flash: 47–273 tok/s across providers).
- **Token efficiency** — output tokens per Intelligence-Index task. Published: GPT-5.6 Sol = 15k (new Pareto frontier), Terra/Luna = 19k. Others **estimated** from AA total-run output-token ratios and published cost-per-task (±30–40%). Reference = Sol's 15k.
- **Eff-adj speed** = raw tok/s ÷ verbosity factor → "Sol-equivalent task tokens per second".
- **Time/task** = tokens-per-task ÷ raw tok/s (AA's own definition of wall-clock per II task).
- **II/min** = II ÷ time/task × 60 → intelligence points delivered per minute of waiting. This is the single best "fast + smart" number.

## Results (sorted by II/min)

| Model | Open wt | II | tok/s | tok/task | Verbosity | Eff-adj tok/s | s/task | II/min | $/task |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Sol Ultrafast (Cerebras) | no | 59.0 | 750 | 15,000 | 1.00× | 750 | ~20 | **177** | n/a (preview) |
| GLM-5.3-Flash (fast provider) | **yes** | 57.5 | 273 | ~15,000 est | 1.00× | 273 | ~55 | **62.8** | ~$0.03 |
| Claude Fable 5.1 (xhigh) | no | 65 | 60 | ~9,500 est | 0.63× | 95 | 158 | 24.7 | $2.72 |
| GPT-5.6 Terra (max) | no | 55 | 118 | 19,000 | 1.27× | 93 | 161 | 20.5 | — |
| GPT-5.6 Luna (max) | no | 52 | 120 | 19,000 | 1.27× | 94 | 159 | 19.7 | $0.35 |
| GPT-5.6 Sol (max) | no | 59.5 | 77 | 15,000 | 1.00× | 77 | 196 | 18.2 | $1.04 |
| **GLM-5.3 (max)** | **yes** | 60 | 75 | ~15,000 est | 1.00× | 75 | 199 | 18.1 | ~$0.26 |
| Claude Fable 5 (max) | no | 64 | 70 | ~17,700 est | 1.18× | 59 | 254 | 15.1 | $3.14 |
| DeepSeek V4 Flash 0731 (max) | **yes** | 52 | 138 | ~28,600 est | 1.91× | 72 | 207 | 15.1 | ~$0.05 |
| Ling 3.0 Flash | **yes** | 38 | 345 | ~63,000 est | 4.20× | 82 | 183 | 12.5 | ~$0.02 |
| GLM-5.3-Flash (Z.ai direct) | **yes** | 57.5 | 47 | ~15,000 est | 1.00× | 47 | 316 | 10.9 | ~$0.03 |
| Claude Opus 5 (max) | no | 63 | 57 | ~21,300 est | 1.42× | 40 | 375 | 10.1 | $2.34 |
| Claude Fable 5.1 (max) | no | 66 | 66 | ~30,000 est | 2.00× | 33 | 452 | 8.8 | $3.76 |
| Kimi K3 (max) | **yes** | 57–60 | 39 | ~30,000 est | 2.00× | 19 | 775 | 4.5 | ~$0.94 |
| Qwen3.8 Max (preview) | partial | 58 | 39 | ~32,000 est | 2.13× | 18 | 827 | 4.2 | — |

Not shown (insufficient data): Claude Opus 5 (high) ~50 tok/s, Muse Spark 1.3 (II 62.1, Meta), Gemini 3.8 Flash (II 58.9), MiniMax M3, DeepSeek V4 Pro (~62 tok/s, ~$0.04/task, II lower than Flash 0731).

## Key findings

1. **The user's hypothesis is confirmed**: GPT-5.6 Sol is materially more token-efficient than Claude Fable. Sol (max) = 15k tokens/task (AA's new Pareto frontier) vs Fable 5.1 (max) ≈ 30k (2×). Sol delivers ~85% of Fable 5.1's peak intelligence at ~28% of the cost and 2× the effective speed. Fable 5.1 is also ~20% *more expensive per task* than Fable 5 because of its verbosity jump.
2. **Raw tok/s is misleading.** Ling 3.0 Flash streams at 345 tok/s but is so verbose (~63k tok/task) that its per-task wall-clock (183 s) is no better than GPT-5.6 Sol (196 s) at far lower intelligence. Kimi K3 and Qwen3.8 Max are the worst offenders among smart open models: II ≈ 58 but 700–830 s per task.
3. **Efficiency-adjusted, the winners are:**
   - Closed: **GPT-5.6 Sol** — and if you can get into the **Ultrafast (Cerebras) preview**, it is in a league of its own (750 tok/s, ~20 s/task at near-flagship intelligence).
   - Open weights, best balance: **GLM-5.3 (max)** — II 60 (matches Sol), 75 tok/s, ~15k tok/task, ~$0.26/task. Essentially "open-source GPT-5.6 Sol at a quarter of the price".
   - Open weights, best speed/value: **GLM-5.3-Flash routed to a fast provider** (273 tok/s on OpenRouter; only 47 tok/s on Z.ai direct) — II 57.5 at ~$0.03/task.
   - Open weights, cheapest acceptable: **DeepSeek V4 Flash 0731** — II 52, 138 tok/s, but ~1.9× verbose.
4. **Fable 5.1 (xhigh) is the hidden gem of the closed frontier**: at xhigh effort it scores 65 (vs 66 at max) while using ~3× fewer tokens → the best II/min of any non-Ultrafast model.

## Recommendation (fast + balanced + open source)

**GLM-5.3 (max)** for quality, or **GLM-5.3-Flash via a fast OpenRouter provider** for speed. Both are open-weight (GLM-5.3-Flash: 320B-A?? MoE, ~306 GiB FP8 checkpoint — self-hosting needs multiple high-memory GPUs; more practical via hosted endpoints). If a closed model is acceptable and you can access OpenAI's Ultrafast tier, GPT-5.6 Sol Ultrafast dominates everything on speed-adjusted intelligence.

## Sources

- https://artificialanalysis.ai/articles/gpt-5-6-has-landed
- https://artificialanalysis.ai/models/gpt-5-6-sol · /gpt-5-6-terra · /gpt-5-6-luna
- https://artificialanalysis.ai/models/claude-fable-5-1 (+ /xhigh, /medium, /low) · /claude-fable-5 · /claude-opus-5
- https://artificialanalysis.ai/articles/claude-fable-5-1
- https://artificialanalysis.ai/models/kimi-k3 · /glm-5-3 · /glm-5-3-flash · /deepseek-v4-flash · /qwen3-8-max · /ling-3-0-flash
- https://www.cerebras.ai/blog/accelerating-gpt-5-6-sol-ultrafast-with-openai
- https://openai.com/index/gpt-5-6
- https://benchlm.ai/benchmarks/artificialanalysis (snapshot 2026-09-04)
- https://gruve.ai/blog/kimi-k3-hands-on-cheap-per-token-expensive-per-task/
- https://www.progressiverobot.com/2026/08/28/glm-5-3-flash-open-weight-320b-model/
