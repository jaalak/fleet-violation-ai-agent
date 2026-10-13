# Fleet Violation AI Agent

**▶ Use it in your browser: https://jaalak.github.io/fleet-violation-ai-agent/** (no install needed)

AI agent that checks whether an IVMS speeding violation (e.g. `Adnoc-over-speed-reckless`) is genuine or a
false positive caused by a GPS jump, a wrong speed zone or a single-sample spike.

## How it works

1. **Extract**: the selected LLM reads the *Violation Details* PDF, the optional *Road Safety RAG* PDF and each
   *Historical Tracking* screenshot into structured data (`checker/extract.py`).
2. **Match**: each screenshot is linked to its violation by timestamp.
3. **Deterministic checks** (`checker/rules.py`, thresholds in `config.yaml`):

   | Rule | Check |
   |---|---|
   | R1 | Trip distance ÷ duration vs reported speed (impossible speed → FAIL) |
   | R2 | Point-to-point GPS speed when both trace endpoints are known (GPS jump → FAIL) |
   | R3 | Duration vs the policy threshold for the event type (Over speed ≥ 30 s; Reckless ≥ 0 s) |
   | R4 | Speed vs the policy trigger (Reckless = zone limit + 20 km/h) |
   | R5 | GPS point is on a real road (OpenStreetMap) and the road's posted limit vs the zone limit |
   | R6 | Odometer progress between consecutive events is plausible |
   | R7 | Counts agree with the Road Safety RAG report, plus the RAG colour impact of overturning |
   | R8 | Zone limit vs ADNOC policy for the vehicle class; zone road type vs the actual road |

   Thresholds come from the ADNOC IVMS & AFDD System Configuration HRT-2026-01 (`checker/policy.py`, `docs/js/policy.js`).

4. **Agent** (`checker/agent.py`): the selected LLM gets the data, the rule results and the screenshot. It
   can zoom into the map, compute point-to-point speeds and look up roads. It then submits a verdict:
   **VALID / LIKELY_FALSE / NEEDS_REVIEW** with confidence, reasons, evidence and a recommended action.

## Web app (GitHub Pages)

The app in [`docs/`](docs/) runs entirely in the browser:

1. Open https://jaalak.github.io/fleet-violation-ai-agent/
2. Pick **Claude, ChatGPT or Gemini**, paste your API key and click **Connect**.
3. Add the Violation Details PDF, the optional RAG PDF and the tracking screenshots, then click **Check violations**.

There is no server. The key and the files go straight from your browser to the AI provider you chose, and GPS
points go to OpenStreetMap. The key is kept for that browser tab only, unless the user ticks "Remember". A
strict Content-Security-Policy only lets the page talk to those services. The web app uses API keys only:
browsers can't use the command-line account logins described below.

Web app code: `docs/js/` (plain ES modules, no build step). Tests:

```powershell
node --test tests_web/web.test.mjs              # rules, schemas, full pipeline with a fake AI
# browser end-to-end in headless Edge/Chrome with fake AI responses:
cd docs; python -m http.server 8765 --bind 127.0.0.1    # in one terminal
node tests_web/browser_e2e.mjs                  # in another, from the repo root
```

## Python version (optional, runs locally)

The original Streamlit version is still included. It also supports account sign-in.

## Choosing the AI provider

Pick the provider in the sidebar, sign in, click **Connect**, then choose a model. The model list comes
live from the provider, with the best one for this task listed first.

| Provider | API key | Use my account |
|---|---|---|
| Claude (Anthropic) | console.anthropic.com -> API Keys | Run `ant auth login` once in a terminal (Anthropic Console account; usage billed there) |
| ChatGPT (OpenAI) | platform.openai.com -> API keys | Not offered by OpenAI |
| Google Gemini | aistudio.google.com -> Get API key | Run `gcloud auth application-default login` once, enable Vertex AI, and enter the project ID |

Consumer chat subscriptions (Claude Pro/Max/Claude Code, ChatGPT Plus/Pro, Gemini Advanced) do **not**
give API access, so other apps can't use them. Keys typed into the app are kept in memory for the
session only and are never written to disk. If you leave the key field empty, the app uses
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` from the environment.

## Setup

```powershell
cd violation_checker
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\streamlit run app.py
```

Upload the reports and screenshots, then click **Check violations**. You can download the results as
Markdown or JSON.

## Other commands

```powershell
.venv\Scripts\python -m pytest tests                      # rules + full pipeline with a fake LLM (no API calls)
# test extraction only: <anthropic|openai|gemini> <model or -> <file> [rag]  (key from env)
.venv\Scripts\python -m checker.extract anthropic - "..\Violation_Details_Report.pdf"
.venv\Scripts\python -m checker.extract gemini - "..\RoadSafety_RAG_Report.pdf" rag
.venv\Scripts\python -m checker.extract openai - "..\screenshot.jpeg"
```

## Notes

- Best evidence: a screenshot of the *Historical Tracking* trip for each violation, with the event popup
  open so that the speed, zone and coordinates are visible.
- The road lookup uses public OpenStreetMap Overpass servers. If they are down, R5 shows N/A and the agent
  carries on.
- The agent's verdict supports a human decision. It does not replace one: LIKELY_FALSE means "ask for the
  raw GPS log / dispute with the vendor", not "auto-delete".
